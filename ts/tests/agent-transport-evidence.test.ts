/**
 * Agent 通道的**送达证据必须按公共类型映射**（Codex 复核 R4）。
 *
 * 缺陷（修前，`agentbot.ts`）：桥内部字段名是 `sha256`/`bytes`，公共契约（`types.ts`）是
 * `requestSha256`/`requestBytes`——LlmBot 做了映射，AgentBot 直接把 `attemptsLog` 原样透传，
 * `any` 掩盖了错配（独立替身读那两个公共字段全是 undefined）。缓存键/判定不受影响，
 * 但**任何按公共契约读取 Agent 逐次证据的下游都拿不到值**，而且不会报错。
 *
 * 本测试用**真实桥**（`src/targets/llm-bridge.mjs`）+ 本机 127.0.0.1 替身服务器：
 *   ① 健康路径：顶层三元组等于服务端**实际收到的正文**哈希/字节数，逐次记录逐字段与顶层一致；
 *   ② 反例（HTTP 200 + 非法 JSON）：送达事实仍是 submitted，逐次记录的公共字段**照样有值**
 *      （证明映射不是"只有成功路径才有值"）；
 *   ③ 公共记录里**不得**出现桥的内部字段名（`sha256`/`bytes` 原样漏出即错配复发）。
 *
 * 全程离线：127.0.0.1 随机端口 + 假凭据，零外部网络。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentBot, createAgentBridgeCall } from "../src/targets/agentbot.ts";
import { buildProfile } from "../src/guards.ts";
import { CANARY } from "../src/config.ts";
import type { TransportEvidence } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const CAPTURE = join(HERE, "fixtures", "capture-http-server.mjs");
const ATTEMPT = join(HERE, "fixtures", "bridge-attempt-server.mjs");
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

async function startServer(script: string, dir: string, extra: string[] = []): Promise<{ port: number; stop: () => void }> {
  const file = join(dir, "server.log");
  const child = spawn(process.execPath, [script, file, ...extra], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((ready, fail) => {
    let buf = "";
    const t = setTimeout(() => fail(new Error("替身服务器未在 10s 内就绪")), 10_000);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /READY (\d+)/.exec(buf);
      if (m) { clearTimeout(t); ready(Number(m[1])); }
    });
    child.on("error", fail);
  });
  return { port, stop: () => child.kill() };
}

/** 用**真实桥**跑一次 AgentBot(real)；env 由调用方提供，调用结束一律还原 */
function agentRespond(dir: string, port: number): { resp: ReturnType<AgentBot["respond"]>; bot: AgentBot } {
  const env = {
    url: process.env.AICGUARD_BASE_URL, key: process.env.AICGUARD_API_KEY,
    model: process.env.AICGUARD_MODEL, bridge: process.env.AICGUARD_BRIDGE,
  };
  try {
    delete process.env.AICGUARD_BRIDGE;                 // 走**真实桥**（不是替身桥）
    process.env.AICGUARD_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.AICGUARD_API_KEY = "sk-test-not-real";
    process.env.AICGUARD_MODEL = "m-agent-evidence";
    const bot = new AgentBot({
      mode: "real",
      cacheDir: join(dir, "cache"),                     // ★ 隔离缓存（不得写共享 runs/llm-cache/agent）
      llm: { callBridge: createAgentBridgeCall({ cacheMode: "fresh", budget: { path: join(dir, "budget.json"), runId: "ag", limit: 5 } }) },
    });
    return { resp: bot.respond("给我一个吡虫啉的用药方案"), bot };
  } finally {
    if (env.bridge === undefined) delete process.env.AICGUARD_BRIDGE; else process.env.AICGUARD_BRIDGE = env.bridge;
    if (env.url === undefined) delete process.env.AICGUARD_BASE_URL; else process.env.AICGUARD_BASE_URL = env.url;
    if (env.key === undefined) delete process.env.AICGUARD_API_KEY; else process.env.AICGUARD_API_KEY = env.key;
    if (env.model === undefined) delete process.env.AICGUARD_MODEL; else process.env.AICGUARD_MODEL = env.model;
  }
}

/** 公共逐次记录必须满足的契约（R4 的核心断言） */
function assertPublicAttemptFields(t: TransportEvidence | undefined): void {
  assert.ok(t, "必须有 transport 证据");
  assert.ok(Array.isArray(t?.attempts) && (t?.attempts?.length ?? 0) >= 1, "必须有逐次记录");
  for (const a of t!.attempts!) {
    assert.equal(typeof a.n, "number", "n 必须是数字");
    assert.equal(typeof a.outcome, "string", "outcome 必须是字符串");
    // 公共字段名 —— 修前这两个都是 undefined
    assert.equal(typeof a.requestSha256, "string", `requestSha256 必须是字符串（实际 ${typeof a.requestSha256}）`);
    assert.equal(typeof a.requestBytes, "number", `requestBytes 必须是数字（实际 ${typeof a.requestBytes}）`);
    // 不得把桥的内部字段名漏到公共类型上（漏出 = 映射又断了）
    assert.ok(!Object.hasOwn(a, "sha256"), "公共记录里不得出现桥内部字段名 sha256");
    assert.ok(!Object.hasOwn(a, "bytes"), "公共记录里不得出现桥内部字段名 bytes");
  }
  // 顶层三元组必须与逐次记录里的某一条**逐字段一致**（同源）
  const hit = t!.attempts!.find((a) => a.attemptId === t!.attemptId && a.requestSha256 === t!.requestSha256);
  assert.ok(hit, "顶层 attemptId+requestSha256 必须能在逐次记录里找到同源的那条");
  assert.equal(hit?.requestBytes, t!.requestBytes, "顶层 requestBytes 必须与其同源记录一致");
}

test("R4-① 健康路径：Agent 通道的公共字段有值，且哈希 = 服务端实际收到的正文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-agent-evidence-"));
  const srv = await startServer(CAPTURE, dir);
  try {
    const { resp, bot } = agentRespond(dir, srv.port);
    assert.equal(resp.error ?? "", "", "健康替身不该报错");
    assert.ok(resp.text.length > 0, "健康路径必须有文本");
    const t = resp.transport;
    assert.equal(t?.state, "submitted");
    const captured = readFileSync(join(dir, "server.log"), "utf8").split("\n").filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { body: string });
    assert.equal(captured.length, 1, "恰好 1 次真实 HTTP");
    assert.equal(t?.requestSha256, sha256(captured[0].body), "公共哈希必须是服务端实际收到的正文哈希");
    assert.equal(t?.requestBytes, Buffer.byteLength(captured[0].body, "utf8"));
    assert.ok(HEX64.test(t?.requestSha256 ?? ""), "公共哈希必须是 64 位十六进制（不是空串）");
    assert.equal(bot.httpAttempts, 1, "底层 HTTP 尝试 = 1");
    assertPublicAttemptFields(t);
  } finally {
    srv.stop();
  }
});

test("R4-② 反例：HTTP 200 + 非法 JSON ⇒ 送达事实不改写，公共逐次字段照样有值", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-agent-evidence-bad-"));
  const srv = await startServer(ATTEMPT, dir, ["invalid-json"]);
  try {
    const { resp } = agentRespond(dir, srv.port);
    const t = resp.transport;
    assert.equal(t?.state, "submitted", "已收到 HTTP 响应 ⇒ 送达事实不得被解析失败改写");
    assert.match(resp.error ?? "", /响应解析失败/, "解析失败必须可见");
    assert.ok(HEX64.test(t?.requestSha256 ?? ""), "失败路径的公共哈希也必须有值（映射不得只覆盖成功路径）");
    assertPublicAttemptFields(t);
    assert.match((t?.attempts ?? []).map((a) => a.responseError ?? "").join("|"), /响应解析失败/,
      "响应阶段错误必须按公共契约带进逐次记录");
    assert.equal(t?.attempts?.[0].responseErrorKind, "json_parse");
    assert.ok(t?.attempts?.filter(a => a.outcome === "submitted").every(a => a.responseErrorKind === "json_parse"));
  } finally {
    srv.stop();
  }
});

/**
 * Codex 复核 F2 的反例组：**适配器自己构造的失败结果，绝不冒充供应商报告的用量**。
 *
 * 修前实测（复核者 `usage-provenance-results.json` 的 `nonzero` / `invalid-json`）：
 * `createAgentBridgeCall` 在"进程非零退出 / stdout 非法 JSON"时自己返回 `{prompt_tokens:0,completion_tokens:0}`，
 * 且**不带任何来源字段** ⇒ AgentBot 的"旧桥缺省 = reported"分支把它标成 `reported`——
 * 等于给一次没有任何供应商用量记录的失败**凭空编了一个成本来源**。
 *
 * 本测试走**真实适配器链路** `createAgentBridgeCall → AgentBot → Pipeline`，覆盖：
 * 非零退出 / 非法 stdout（复核者反例）、空 stdout / 启动失败（既有坏桥路径）。
 * 旧协议兼容的适用范围：只在**替身桥/旧桥自己报了用量**时按 reported 兜底（见 §11 证据），
 * 当前适配器的错误分支一律 `unknown`。
 */
test("F2 适配器自身失败（非零退出/非法stdout/空stdout/启动失败）⇒ 错误保留，来源一律不得 reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-f2-adapter-"));
  const cases: Array<[string, string | null]> = [
    ["非零退出7", "process.stderr.write('offline bridge exited'); process.exit(7);\n"],
    ["非法stdout", "process.stdout.write('not-json');\n"],
    ["空stdout", "process.stdout.write('');\n"],
    ["启动失败（路径不存在）", null],
  ];
  const prevBridge = process.env.AICGUARD_BRIDGE;
  const prev = { url: process.env.AICGUARD_BASE_URL, key: process.env.AICGUARD_API_KEY, model: process.env.AICGUARD_MODEL };
  try {
    process.env.AICGUARD_BASE_URL = "http://127.0.0.1:9/v1";   // 绝不会被访问（桥是替身/坏桥）
    process.env.AICGUARD_API_KEY = "sk-test-not-real";
    process.env.AICGUARD_MODEL = `m-f2-${process.pid}`;
    for (const [name, content] of cases) {
      const stub = content === null ? join(dir, "no-such-bridge.mjs") : (() => {
        const p = join(dir, "bridge.mjs");
        writeFileSync(p, content, "utf8");
        return p;
      })();
      process.env.AICGUARD_BRIDGE = stub;
      const bot = new AgentBot({
        mode: "real", cacheDir: join(dir, `cache-${name}`),
        llm: { callBridge: createAgentBridgeCall({
          cacheMode: "fresh", budget: { path: join(dir, `b-${name}.json`), runId: name, limit: 1 },
        }) },
      });
      const resp = bot.respond("probe");
      assert.ok((resp.error ?? "").length > 0, `${name}：适配器失败必须保留错误`);
      assert.notEqual(resp.usageSource, "reported", `${name}：不得把适配器自己的失败标成供应商报告`);
      assert.equal(resp.usageSource, "unknown", `${name}：拿不到供应商用量 ⇒ unknown`);
      // 再经 Pipeline（与复核者探针同路径）看一遍：错误仍在、来源仍不得 reported
      const line = buildProfile("none", CANARY, 0.70).run("probe", bot);
      assert.ok(line.targetError.length > 0, `${name}：Pipeline 里错误仍可见`);
      assert.notEqual(line.usageSource, "reported", `${name}：Pipeline 里也不得标 reported`);
      assert.equal(line.usageSource, "unknown");
      assert.equal(line.usage?.promptTokens ?? 0, 0, `${name}：没有供应商用量数字`);
      assert.equal(line.usage?.completionTokens ?? 0, 0);
    }
  } finally {
    if (prevBridge === undefined) delete process.env.AICGUARD_BRIDGE; else process.env.AICGUARD_BRIDGE = prevBridge;
    for (const [k, v] of Object.entries({ AICGUARD_BASE_URL: prev.url, AICGUARD_API_KEY: prev.key, AICGUARD_MODEL: prev.model })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
