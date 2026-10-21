/**
 * RAG 批次**预算中止**的端到端验收（P3 返工项 4）—— 真跑 `scripts/rag-eval.ts`，零出网。
 *
 * 用替身桥模拟「中途额度耗尽」（第 1 条正常、第 2 条起报 budget_exhausted），锁住：
 *   ① 中止后**不再调靶子**（替身桥调用计数停在 2）；
 *   ② 后续用例合成 `budget_exhausted` 行（verdict=unclear）⇒ 不进确定判定分母、不得当防御成功；
 *   ③ 报告与 cases.jsonl **保留完整状态**：batch.aborted / abortReason / budgetStop / executed / unexecuted；
 *   ④ 计数三口径分列（桥调用 / 底层 HTTP 尝试 / 缓存命中）且与账本快照一起落盘；
 *   ⑤ **独立 replay 不受额度耗尽影响**（不发请求 ⇒ 不扣额度、也不用账本）。
 *
 * 全程离线：替身桥 + 假凭据 + 隔离模型名。注意隔离的**不是写入位置**：LlmBot 的默认缓存目录是
 * `runs/llm-cache/<model>`（模型子目录，仍在共享父目录下）—— 不与他人条目互撞，但也**不是临时目录**。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";


const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const RAG_EVAL = join(TS_ROOT, "scripts", "rag-eval.ts");
const STUB = join(HERE, "fixtures", "bridge-abort-stub.mjs");
const DOCS = join(TS_ROOT, "tests", "fixtures", "rag-dev-docs");
const CASES = join(TS_ROOT, "tests", "fixtures", "rag-dev-cases.jsonl");
// 中止专用夹具：各条 query **互不共享缓存**（否则后面的用例命中缓存、不会调靶子，中止会落在最后一条）
const ABORT_CASES = join(TS_ROOT, "tests", "fixtures", "rag-abort-cases.jsonl");
const MODEL = `m-abort-test-${process.pid}`;   // 隔离缓存目录（runs/llm-cache/<model>）：跨测试不共享

interface Evidence {
  id: string; status: string; verdict: string; unexecuted?: boolean;
  budgetStopReason?: string; delivered: boolean; requestSha256: string;
  condition: string; invalidReason: string | null; transportState?: string;
}

function runRagEval(outDir: string, counter: string, extra: string[] = []): { code: number; stdout: string } {
  const r = spawnSync(process.execPath, [
    RAG_EVAL, "--out", outDir, "--docs-dir", DOCS, "--cases", ABORT_CASES,
    "--target", "llm", "--model", MODEL, ...extra,
  ], {
    cwd: TS_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AICGUARD_BRIDGE: STUB,
      AICGUARD_BASE_URL: "http://127.0.0.1:9/v1",     // 绝不会被真正访问（桥是替身）
      AICGUARD_API_KEY: "sk-test-not-real",
      AICGUARD_MODEL: MODEL,
      COUNTER: counter,
    },
  });
  return { code: r.status ?? -1, stdout: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const callCount = (p: string): number => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length : 0);

test("P3-⑰ RAG 预算中止：后续不再调靶子、未执行项显式可见、报告可对账", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-rag-abort-"));
  const counter = join(dir, "calls.log");
  const out = join(dir, "out");
  const budget = join(dir, "budget.json");
  const { code, stdout } = runRagEval(out, counter, ["--budget", budget, "--budget-limit", "1"]);
  assert.equal(code, 0, `rag-eval 应正常退出。输出：${stdout.slice(0, 800)}`);

  // ① 中止后不再调靶子
  assert.equal(callCount(counter), 2, "第 1 条正常、第 2 条撞上耗尽；之后不得再有靶子调用");

  const evidence = readFileSync(join(out, "cases.jsonl"), "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Evidence);
  const unexecuted = evidence.filter((e) => e.unexecuted === true);
  assert.ok(unexecuted.length > 0, "必须有“未执行”的合成行（否则读者以为整批跑完了）");
  assert.ok(unexecuted.every((e) => e.status === "budget_exhausted" && e.verdict === "unclear"),
    "未执行行一律 budget_exhausted + unclear");
  assert.ok(unexecuted.every((e) => e.delivered === false && e.requestSha256 === ""),
    "未执行的用例不可能有送达证据（也不得拿空正文哈希冒充请求哈希）");
  assert.ok(unexecuted.every((e) => e.transportState === "unexecuted"),
    "未执行行的送达状态必须显式标 unexecuted");
  // ★ Codex 复核项 3：forced 的未执行行不得被 invalidReasonOf 覆盖成 invalid_test
  assert.ok(unexecuted.some((e) => e.condition === "forced"), "夹具里必须有 forced 的未执行行（否则这条断言没覆盖面）");
  assert.ok(unexecuted.every((e) => e.status === "budget_exhausted" && e.verdict === "unclear"
    && e.invalidReason === null),
    `未执行行必须保持 budget_exhausted/unclear/invalidReason=null；实际：${JSON.stringify(unexecuted.map((e) => [e.id, e.status, e.verdict, e.invalidReason]))}`);
  assert.ok(evidence.some((e) => e.status === "budget_exhausted" && e.unexecuted !== true),
    "撞上耗尽的那一条要如实记为 budget_exhausted（与未执行分开）");
  assert.ok(!evidence.some((e) => e.status === "call_error"), "预算中止不得混成 call_error");

  // ② 报告：批次与中止块 + 三口径 + 账本快照
  const report = JSON.parse(readFileSync(join(out, "rag-report.json"), "utf8")) as {
    batch?: { aborted: boolean; abortReason: string; budgetStop: string; executed: number; unexecuted: number; cacheMode: string; salt: string; usage: { bridgeCalls: number; httpAttempts: number; cacheHits: number }; ledger: { used: number } | null; notes: string[] };
    metrics: { endToEnd: { budgetExhausted: number; decided: number }; coverage: { invalidTests: number } };
  };
  assert.ok(report.batch, "真实通道必须落 batch 块");
  const b = report.batch!;
  assert.equal(b.aborted, true);
  assert.match(b.abortReason, /预算中止/);
  assert.equal(b.budgetStop, "exhausted", "中止类别要能区分（exhausted/corrupt/locked/limit）");
  assert.equal(b.executed, 2, "已执行 2 条（1 条正常 + 1 条撞上耗尽）");
  assert.equal(b.unexecuted, unexecuted.length, "未执行数与 cases.jsonl 一致");
  assert.equal(b.cacheMode, "fresh");
  assert.ok(b.salt.startsWith("rag-"), "fresh 必须记采样标识（replay 要靠它复现）");
  assert.equal(b.usage.bridgeCalls, 2, "桥调用 2 次");
  assert.equal(b.usage.httpAttempts, 1, "底层 HTTP 尝试只有第 1 次（第 2 次是发送前拒绝，attempts=0）");
  assert.ok(report.metrics.endToEnd.budgetExhausted >= unexecuted.length, "指标里要能看到预算中止数");
  // 账本快照：替身桥**不记账** ⇒ 这里必须如实写 null，且说明"无法与账本对账"
  // （真实桥的记账与对账由 rag-transport-evidence.test.ts 覆盖）
  // 中止行不得被算成"无效测试"（invalid_test 的含义是"夹具没按约定送达"，预设了执行）
  assert.equal(report.metrics.coverage.invalidTests, 0,
    "本夹具无夹具性失败 ⇒ invalidTests 必须为 0（中止不得伪装成无效测试）");
  assert.equal(b.ledger, null, "替身桥不写账本 ⇒ 不得假装有账本快照");
  assert.ok(b.notes.some((n) => n.includes("无法与账本对账")), "无账本时必须明说“无法对账”，不得写成“一致”");

  // ★ Codex 复核 R6：forced 汇编表的“判定为”列不得从 “无 invalidReason”推出“有效测试”。
  //   本场景的 AB-03/AB-05 实际是 unexecuted=true / budget_exhausted / invalidReason=null。
  const md = readFileSync(join(out, "rag-report.md"), "utf8");
  const forcedSection = ((): string => {
    const a = md.indexOf("## 强制送达装配（forced 行）");
    const b2 = md.indexOf("## 逐条证据");
    assert.ok(a >= 0 && b2 > a, "报告必须含强制送达装配小节（且位于逐条证据之前）");
    return md.slice(a, b2);
  })();
  const forcedRow = (id: string) => forcedSection.split("\n").find((l) => l.startsWith(`| ${id} |`));
  for (const id of ["AB-03", "AB-05"]) {
    const r = forcedRow(id) ?? "";
    assert.match(r, /未执行（预算中止）/, `${id} 行（unexecuted=true）必须显式标未执行；实际：${r}`);
    assert.ok(!r.includes("有效测试"), `${id} 行不得写“有效测试”（修前缺陷）：${r}`);
    assert.ok(r.includes("**未装配**"), `${id} 未装配的事实必须保留：${r}`);
  }
  // 对照：AB-02 是**执行过**的那条（撞上额度墙 ⇒ budget_exhausted，unexecuted 未置位）——
  // 它不得被标成“未执行”（那是另一种事实），也不得被读成“有效测试”。
  const ab02 = forcedRow("AB-02") ?? "";
  assert.ok(!ab02.includes("未执行"), `执行过（撞墙）的 forced 行不得被标成未执行：${ab02}`);
  assert.ok(!ab02.includes("有效测试"), `未跑成的 forced 行不得写“有效测试”：${ab02}`);
  assert.match(ab02, /未判定（budget_exhausted）/, `执行了但没跑成 ⇒ 未判定 + 实际状态：${ab02}`);
});

test("P3-⑱ 独立 replay 不受额度耗尽影响：不发请求、不扣额度、不因缺账本失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-rag-replay-"));
  const counter = join(dir, "calls.log");
  const out = join(dir, "out-replay");
  // 故意指向一个**不存在**的账本：replay 若去碰它就会露馅
  const ghost = join(dir, "ghost-budget.json");
  const { code, stdout } = runRagEval(out, counter, ["--mode", "replay", "--budget", ghost]);
  assert.equal(code, 0, `replay 应当照常跑完（不因额度问题失败）。输出：${stdout.slice(0, 800)}`);
  assert.equal(callCount(counter), 0, "replay 一次都不许调桥");
  assert.ok(!existsSync(ghost), "replay 不得创建/触碰账本（额度用完也能继续读缓存）");
  const report = JSON.parse(readFileSync(join(out, "rag-report.json"), "utf8")) as {
    batch?: { cacheMode: string; aborted: boolean; usage: { bridgeCalls: number; httpAttempts: number } };
  };
  assert.equal(report.batch?.cacheMode, "replay", "报告必须记实际生效的模式");
  assert.equal(report.batch?.aborted, false, "replay 不会因额度中止");
  assert.equal(report.batch?.usage.httpAttempts, 0, "replay 零 HTTP");
});
