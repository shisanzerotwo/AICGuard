import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmBot } from "../src/targets/llmbot.ts";
import { AgentBot, createAgentBridgeCall } from "../src/targets/agentbot.ts";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("旧桥来源：占位零保持未知，单字段非零与未发送冲突时保留下界", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-legacy-single-"));
  const before = { ...process.env };
  const bridge = join(dir, "bridge.mjs");
  writeFileSync(bridge, "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(process.env.USAGE_COMPAT_FIXTURE));");
  const cases = [
    { name: "拒绝顶层不能覆盖未知逐次状态", raw: { request: { state: "refused" }, attemptsLog: [{ outcome: "bridge-status-unknown" }] }, source: "unknown", lower: { promptTokens: null, completionTokens: null } },
    { name: "零计数不能覆盖未知逐次状态", raw: { attempts: 0, request: { state: "refused" }, attemptsLog: [{ outcome: "bridge-status-unknown" }] }, source: "unknown", lower: { promptTokens: null, completionTokens: null } },
    { name: "拒绝顶层不能覆盖连接尝试", raw: { request: { state: "refused" }, attemptsLog: [{ outcome: "not-connecting" }, { outcome: "refused" }] }, source: "unknown", lower: { promptTokens: null, completionTokens: null } },
    { name: "未知逐次状态保留合法成本下界", raw: { attempts: 0, request: { state: "refused" }, attemptsLog: [{ outcome: "bridge-status-unknown" }], usage: { prompt_tokens: 7 } }, source: "partial", lower: { promptTokens: 7, completionTokens: null } },
    { name: "明确拒绝逐次记录仍为零消耗", raw: { attempts: 0, request: { state: "refused" }, attemptsLog: [{ outcome: "refused" }] }, source: "none", lower: { promptTokens: null, completionTokens: null } },
    { name: "无证据的占位零", raw: { usage: { prompt_tokens: 0, completion_tokens: 0 } }, source: "unknown", lower: { promptTokens: null, completionTokens: null } },
    { name: "非零单字段与零次冲突", raw: { attempts: 0, usage: { prompt_tokens: 7 } }, source: "partial", lower: { promptTokens: 7, completionTokens: null } },
    { name: "非零单字段与拒绝冲突", raw: { attempts: 0, request: { state: "refused" }, usage: { completion_tokens: 11 } }, source: "partial", lower: { promptTokens: null, completionTokens: 11 } },
    { name: "只有单字段正用量", raw: { usage: { prompt_tokens: 7 } }, source: "partial", lower: { promptTokens: 7, completionTokens: null } },
    { name: "确认未发送", raw: { attempts: 0, request: { state: "refused" }, usage: { prompt_tokens: 0, completion_tokens: 0 } }, source: "none", lower: { promptTokens: null, completionTokens: null } },
    { name: "完整健康", raw: { attempts: 1, text: "合规回答", usage: { prompt_tokens: 7, completion_tokens: 11 } }, source: "reported", lower: { promptTokens: 7, completionTokens: 11 } },
    { name: "明确报告完整零", raw: { attempts: 1, text: "合规回答", usage: { prompt_tokens: 0, completion_tokens: 0 } }, source: "reported", lower: { promptTokens: 0, completionTokens: 0 } },
    { name: "已发送但只报单字段零", raw: { attempts: 1, text: "合规回答", usage: { prompt_tokens: 0 } }, source: "partial", lower: { promptTokens: 0, completionTokens: null } },
  ];
  try {
    Object.assign(process.env, { AICGUARD_BRIDGE: bridge, AICGUARD_BASE_URL: "http://127.0.0.1:9/v1", AICGUARD_API_KEY: "offline", AICGUARD_MODEL: "offline-usage-compat" });
    for (const c of cases) {
      process.env.USAGE_COMPAT_FIXTURE = JSON.stringify(c.raw);
      const budget = { path: join(dir, "unused-budget.json"), runId: "legacy", limit: 1 };
      const text = new LlmBot({ model: "offline", systemPrompt: "离线", baseUrl: process.env.AICGUARD_BASE_URL!, apiKey: "offline", budget, cacheDir: "" }).respond("用量兼容");
      const agent = createAgentBridgeCall({ cacheMode: "fresh", budget })([{ role: "user", content: "用量兼容" }]);
      for (const [kind, r] of [["text", text], ["agent", agent]] as const) {
        assert.equal(r.usageSource, c.source, `${c.name}/${kind}`);
        assert.deepEqual(r.usageLowerBound, c.lower, `${c.name}/${kind} 不得丢弃已知字段或推断未知字段`);
      }
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("实际回环请求：单字段用量跨文本与Agent保留下界；逐次正文/错误分类同源", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-usage-evidence-"));
  const before = { ...process.env };
  const server = spawn(process.execPath, [join(root, "tests/fixtures/bridge-attempt-server.mjs"), join(dir, "hits"), "usage-prompt-only"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await new Promise<number>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("server not ready")), 5000);
      server.on("error", fail);
      server.stdout.on("data", (b: Buffer) => { const m = /READY (\d+)/.exec(b.toString()); if(m) { clearTimeout(timer); ok(Number(m[1])); } });
    });
    delete process.env.AICGUARD_BRIDGE;
    Object.assign(process.env, { AICGUARD_BASE_URL: `http://127.0.0.1:${port}/v1`, AICGUARD_API_KEY: "offline", AICGUARD_MODEL: "offline" });
    for (const mode of ["text", "agent"]) {
      const budget = { path: join(dir, mode + "-budget.json"), runId: mode, limit: 1 };
      const target = mode === "text"
        ? new LlmBot({ model: "offline", systemPrompt: "离线测试", baseUrl: process.env.AICGUARD_BASE_URL!, apiKey: "offline", budget, cacheDir: join(dir, "text-cache") })
        : new AgentBot({ mode: "real", cacheDir: join(dir, "agent-cache"), llm: { callBridge: createAgentBridgeCall({ cacheMode: "fresh", budget }) } });
      const r = target.respond("逐次正文测试");
      assert.equal(r.usageSource, "partial", mode);
      assert.deepEqual(r.usageLowerBound, { promptTokens: 7, completionTokens: null }, "缺字段保持未知，不能冒充报告零");
      assert.equal(r.transport?.attempts?.[0].decodedText?.includes("逐次正文测试"), true);
      assert.equal(r.transport?.attempts?.[0].responseErrorKind, undefined, "健康回答无错误类别");
    }
  } finally {
    server.kill();
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
    rmSync(dir, { recursive: true, force: true });
  }
});
