import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmBot } from "../src/targets/llmbot.ts";
import { AgentBot, createAgentBridgeCall } from "../src/targets/agentbot.ts";
test("进程错误证据：Windows未上报signal也须报错，保留实际退出信息", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-process-evidence-"));
  const before = { ...process.env };
  try {
    Object.assign(process.env, { AICGUARD_BASE_URL: "http://127.0.0.1:9/v1", AICGUARD_API_KEY: "offline", AICGUARD_MODEL: "process-evidence" });
    for(const [name, code] of [["exit7", "process.exit(7)"], ["signal", "process.kill(process.pid, 'SIGTERM')"]]) {
      const bridge = join(dir, name + ".mjs"); writeFileSync(bridge, code);
      process.env.AICGUARD_BRIDGE = bridge;
      for (const kind of ["text", "agent"]) {
        const budget = { path: join(dir, "budget.json"), runId: name, limit: 1 };
        const bot = kind === "text" ? new LlmBot({ model: "offline", baseUrl: "http://127.0.0.1:9/v1", apiKey: "offline", systemPrompt: "测试", budget, cacheDir: join(dir, kind+name) })
          : new AgentBot({ mode: "real", cacheDir: join(dir, kind+name), llm: { callBridge: createAgentBridgeCall({ cacheMode: "fresh", budget }) } });
        const r = bot.respond("测试");
        assert.ok(r.error, `${name}/${kind} 必须报错，不依赖signal非空`);
        assert.equal(r.usageSource, "unknown");
        assert.ok(r.bridgeProcess, "必须保留实际进程退出信息");
        assert.ok(Object.hasOwn(r.bridgeProcess, "signal"));
        assert.ok(Object.hasOwn(r.bridgeProcess, "exitCode"));
        if (name === "exit7") { assert.equal(r.bridgeProcess.exitCode, 7); assert.equal(r.bridgeProcess.signal, null); }
      }
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before); rmSync(dir, { recursive: true, force: true });
  }
});
