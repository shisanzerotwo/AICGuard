import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmBot } from "../src/targets/llmbot.ts";
import { Pipeline } from "../src/guards.ts";
import { runEvaluation, runSingle } from "../src/evaluate.ts";
import { buildPayload, writeMarkdown, writeCasesJsonl } from "../src/report.ts";
import type { Probe } from "../src/types.ts";

const probe: Probe = { id: "cost", family: "direct_injection", goal: "leak_system", text: "成本测试", severity: 1, source: "native", notes: "离线成本契约" };
test("文本主报告保留用量来源：未知不算零，部分成本不进倍率，缓存确认零", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-text-usage-"));
  const prev = process.env.AICGUARD_BRIDGE;
  try {
    const bridge = join(dir, "bridge.mjs");
    process.env.AICGUARD_BRIDGE = bridge;
    const bot = (cacheDir = join(dir, "cache")) => new LlmBot({ model: "offline", baseUrl: "http://127.0.0.1:9/v1", apiKey: "offline",
      systemPrompt: "测试", cacheDir, budget: { path: join(dir, "budget.json"), runId: "test" } });
    for (const source of ["unknown", "partial", "reported"] as const) {
      writeFileSync(bridge, `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify({
        text: "合规回答", attempts: 1, usageSource: source, usage: source === "unknown" ? undefined : { prompt_tokens: 7, completion_tokens: 11 },
      }))}));`);
      const target = bot();
      // 每次独立盐/缓存目录，避免上一模式缓存遮蔽测试输入。
      const p = { ...probe, id: source, text: source };
      const result = runEvaluation([p], [], target, Pipeline.disabled(), "secret");
      assert.deepEqual(result.results.map(r => r.usageSource), [source, "none"]);
      const u = result.metrics.tokenUsage!;
      assert.equal(u.baseline.sources[source], 1);
      assert.equal(u.guarded.sources.none, 1);
      assert.equal(u.overheadRatio, null, "重放/未知/部分样本不能参与完整成本倍率");
      assert.equal(u.baseline.completeCases, source === "reported" ? 1 : 0);
      const meta = { runId: source, startedAt: "2026-10-16", target: "offline", profile: "none", profileLabel: "none", guardsEnabled: [], threshold: 1 };
      const payload = buildPayload(meta, result.metrics, result.results, [], []);
      assert.equal((payload.metrics as { token_usage: typeof u }).token_usage.baseline.sources[source], 1);
      writeCasesJsonl(result.results, join(dir, "cases.jsonl"));
      const cases = readFileSync(join(dir, "cases.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
      assert.equal(cases[0].usageSource, source, "逐条报告也须保留来源，不仅聚合数字");
      assert.equal(cases[1].usageSource, "none");
      writeMarkdown(meta, result.metrics, result.results, [], [], join(dir, "report.md"));
      const md = readFileSync(join(dir, "report.md"), "utf8");
      assert.match(md, /完整成本样本/);
      assert.match(md, /不可计算/);
    }
    const healthy = runEvaluation([probe], [], bot(""), Pipeline.disabled(), "secret");
    assert.equal(healthy.metrics.tokenUsage?.overheadRatio, 1, "完整健康成本必须仍可计算，不能一概置空");
    assert.equal(healthy.metrics.tokenUsage?.guarded.completeCases, 1);
    // 同一用例多轮：一轮有完整用量，后一轮未知，保留已知下界并降级。
    writeFileSync(bridge, `import fs from 'node:fs';const p=JSON.parse(fs.readFileSync(0,'utf8'));
      process.stdout.write(JSON.stringify({text:'合规回答',attempts:1,usageSource:p.messages.length===1?'reported':'unknown',
        ...(p.messages.length===1?{usage:{prompt_tokens:7,completion_tokens:11}}:{})}));`);
    const r = runSingle({ ...probe, turns: ["first", "second"] }, bot(), Pipeline.disabled(), "baseline", "secret");
    assert.equal(r.usageSource, "partial");
    assert.equal(r.usage?.promptTokens, 7);
  } finally {
    if (prev === undefined) delete process.env.AICGUARD_BRIDGE; else process.env.AICGUARD_BRIDGE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
