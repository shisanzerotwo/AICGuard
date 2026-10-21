/**
 * Work Loop **部分成功后的原始用量不得丢账**（Codex 复核 D2）—— 真跑 `scripts/workloop-eval.ts`，零出网。
 *
 * 复现的边界（修前，`workloop-eval.ts` 的良性/攻击两处 `status !== "ok"` 分支对失败槽位强制
 * `usage=null / totalTokens=null`）：
 *   · 攻击：WL-01 第 1 轮工具调用拿到了 7 入 + 11 出，第 2 轮才预算耗尽 ⇒ Pipeline 明report
 *     `budgetExhausted=true` 且 `usage=7/11`，但落盘却是 `usage:null, totalTokens:null` ⇒ **18 token 凭空消失**；
 *   · 良性：同一形态（第一任务内部耗尽）同样丢数；
 *   · 工具成功 → 后续接口报错：同样丢数。
 *
 * 本测试锁住的契约（两条要求**同时**成立，不是二选一）：
 *   ① **所有已获得的原始用量都落盘**（含任务内部分成功后中止/报错；没有可信用量才是 null）；
 *   ② 这些槽位**不是有效完整成本样本**：`usageComplete=false`、`multiplier=null`，
 *      不进 meanTokens/均值/倍率/达阈判定；partial 中止批照旧不给整体结论。
 *
 * 全程离线：替身桥 + 假凭据 + 临时目录（缓存落 <out>/llm-cache/agent）。
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
const SCRIPT = join(TS_ROOT, "scripts", "workloop-eval.ts");
const STUB = join(HERE, "fixtures", "workloop-partial-usage-stub.mjs");

interface RoundRow {
  round: number; status: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  totalTokens: number | null; usageComplete: boolean; multiplier: number | null;
}
interface CaseRow {
  id: string; rounds: RoundRow[]; okRounds: number[]; unexecutedRounds: number;
  partialUsageTokens: number; partialUsageRounds: number;
  meanTokens: number | null; meanMultiplier: number | null; maxMultiplier: number | null; flagged: boolean | null;
}
interface Report {
  partial?: boolean; complete?: boolean; aborted?: boolean; executed?: number; unexecuted?: number; totalSlots?: number;
  baseline?: { usable: boolean; meanTokens: number | null; okSamples: number; samples: Array<{ round: number; id: string; status: string; usage: RoundRow["usage"]; totalTokens: number | null; usageComplete: boolean }> };
  cases?: CaseRow[];
  partialUsage?: { tokens: number; rounds: number; benignTokens: number; benignRounds: number };
}

function run(dir: string, mode: string, extra: string[] = []): { code: number; out: string; rep: Report; md: string; calls: number } {
  const counter = join(dir, `calls-${mode}.log`);
  const outDir = join(dir, `out-${mode}`);
  const r = spawnSync(process.execPath, [
    SCRIPT, "--samples", "1", "--benign-limit", "2", "--out", outDir,
    "--budget", join(dir, `budget-${mode}.json`), "--budget-limit", "1", ...extra,
  ], {
    cwd: TS_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AICGUARD_BRIDGE: STUB,
      AICGUARD_BASE_URL: "http://127.0.0.1:9/v1",   // 绝不会被真正访问（桥是替身）
      AICGUARD_API_KEY: "sk-test-not-real",
      AICGUARD_MODEL: `m-wl-pu-${process.pid}`,
      COUNTER: counter,
      MODE: mode,
    },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const repPath = join(outDir, "report.json");
  return {
    code: r.status ?? -1, out,
    rep: existsSync(repPath) ? JSON.parse(readFileSync(repPath, "utf8")) as Report : (null as unknown as Report),
    md: existsSync(join(outDir, "report.md")) ? readFileSync(join(outDir, "report.md"), "utf8") : "",
    calls: existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter((l) => l.trim()).length : 0,
  };
}

const caseOf = (rep: Report, id: string): CaseRow => {
  const c = (rep.cases ?? []).find((x) => x.id === id);
  assert.ok(c, `报告必须含用例 ${id}`);
  return c!;
};

test("D2-① 攻击任务内「工具成功 → 预算耗尽」：18 token 原样保留，但不进均值/倍率", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-pu-attack-"));
  const { code, out, rep, md, calls } = run(dir, "attack");
  assert.equal(code, 2, `中止批必须退出 2。输出：${out.slice(0, 600)}`);
  assert.equal(calls, 4, "调用序列 = 2 良性 + WL-01 两轮（工具轮 + 耗尽轮）；中止后不得再调靶子");
  const wl01 = caseOf(rep, "WL-01");
  assert.equal(wl01.rounds.length, 1, "WL-01 只被尝试过 1 个槽位（轮）");
  const r0 = wl01.rounds[0];
  assert.equal(r0.status, "budget_exhausted", "该槽位如实记预算中止（不是 ok）");
  // ★ 核心反例：已发生的 7 入 + 11 出必须还在
  assert.deepEqual(r0.usage, { promptTokens: 7, completionTokens: 11 }, "任务内已发生的原始用量不得被丢掉（修前是 null）");
  assert.equal(r0.totalTokens, 18, "18 token 必须能在产物里读到");
  // ★ 但不是有效样本
  assert.equal(r0.usageComplete, false, "中止槽位不得算作有效完整成本样本");
  assert.equal(r0.multiplier, null, "倍率必须保持 null（不为它强造基线）");
  assert.equal(wl01.okRounds.length, 0, "有效轮次为 0");
  assert.equal(wl01.meanTokens, null, "无有效轮次 ⇒ 均值不可计算（不得把部分用量算成有效均值）");
  assert.equal(wl01.meanMultiplier, null);
  assert.equal(wl01.flagged, null, "达阈判定不可计算 ⇒ null");
  assert.equal(wl01.partialUsageTokens, 18, "已知部分用量必须显式汇总（不进均值）");
  assert.equal(wl01.partialUsageRounds, 1);
  // 有效样本只有 2 条良性；中止批不给整体结论
  assert.equal(rep.partial, true);
  assert.equal(rep.aborted, true);
  assert.equal(rep.baseline?.okSamples, 2, "良性 2 条有效样本（每条 6 token）");
  assert.equal(rep.baseline?.meanTokens, 6);
  assert.equal(rep.partialUsage?.tokens, 18);
  assert.ok(!/未达\s*5×\s*阈值/.test(md), "中止批不得给出整体负结论");
  // 人读的报告必须把两类用量分开写
  assert.match(md, /已知部分用量/, "Markdown 要显式给出「已知部分用量」这一类");
  assert.match(md, /入 7\/出 11=18 token/, "逐轮原始记录里要看到 18 token");
  assert.match(md, /已知部分用量\*\*：不进有效均值\/倍率/, "该记录要标明它不作有效样本");
  assert.match(md, /有效完整成本样本/, "要区分「有效完整成本样本」与「已知部分用量」");
  assert.ok(!/入 0\/出 0=18/.test(md), "不得出现自相矛盾的用量行");
});

test("D2-② 良性任务内「工具成功 → 预算耗尽」：基线侧同样保留原始用量", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-pu-benign-"));
  const { code, out, rep, md, calls } = run(dir, "benign");
  assert.equal(code, 2, `中止批必须退出 2。输出：${out.slice(0, 600)}`);
  assert.equal(calls, 2, "良性第一任务两轮即中止；之后不得再调靶子");
  const b0 = rep.baseline?.samples[0];
  assert.ok(b0, "基线必须留痕");
  assert.equal(b0!.status, "budget_exhausted");
  assert.deepEqual(b0!.usage, { promptTokens: 7, completionTokens: 11 }, "良性侧已发生的用量同样不得丢（修前是 null）");
  assert.equal(b0!.totalTokens, 18);
  assert.equal(b0!.usageComplete, false, "不得算作有效完整样本");
  assert.equal(rep.baseline?.okSamples, 0, "有效基线样本为 0");
  assert.equal(rep.baseline?.meanTokens, null, "基线不可计算 ⇒ null（不得写成 0）");
  assert.equal(rep.partialUsage?.benignTokens, 18, "良性侧已知部分用量要汇总出来");
  assert.equal(rep.partial, true, "基线不成立 + 中止 ⇒ partial");
  assert.ok(!/未达\s*5×\s*阈值/.test(md), "中止批不得给出整体负结论");
  const wl01 = caseOf(rep, "WL-01");
  assert.deepEqual(wl01.rounds, [], "中止后后续用例根本没被尝试");
  assert.equal(wl01.unexecutedRounds, 1);
});

test("D2-③ 工具成功 → 后续接口报错：原始用量保留，状态如实记靶子调用失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-pu-apierr-"));
  const { code, rep, md, calls } = run(dir, "api-error");
  assert.equal(code, 2, "随后仍有预算中止 ⇒ 批未跑完、退出 2");
  assert.equal(calls, 5, "序列 = 2 良性 + WL-01 两轮 + WL-02（撞墙）；之后不得再调");
  const wl01 = caseOf(rep, "WL-01");
  const r0 = wl01.rounds[0];
  assert.equal(r0.status, "target_error", "第二轮的接口错误如实记靶子调用失败");
  assert.deepEqual(r0.usage, { promptTokens: 7, completionTokens: 11 }, "第一轮已发生的用量不得因后续报错而消失");
  assert.equal(r0.totalTokens, 18);
  assert.equal(r0.usageComplete, false);
  assert.equal(wl01.meanMultiplier, null);
  assert.equal(wl01.flagged, null);
  assert.equal(rep.partialUsage?.tokens, 18);
  assert.match(md, /靶子调用失败/, "Markdown 要如实写出失败状态");
  assert.match(md, /入 7\/出 11=18 token/, "并同时保留 18 token 的记录");
});

test("D2-④ 健康完整任务对照：跑完、样本完整、倍率可算（证明上面的断言不是「永远不可计算」）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-pu-healthy-"));
  const { code, out, rep, md, calls } = run(dir, "healthy", ["--benign-limit", "1"]);
  assert.equal(code, 0, `健康对照应跑完且无达阈用例。输出：${out.slice(0, 600)}`);
  assert.equal(rep.partial, false, "健康对照不得被标成 partial");
  assert.equal(rep.complete, true);
  assert.equal(calls, 7, "1 条良性 + 6 条攻击，各 1 次调用（跑完）");
  assert.equal(rep.baseline?.okSamples, 1);
  assert.equal(rep.baseline?.meanTokens, 6);
  const wl01 = caseOf(rep, "WL-01");
  assert.equal(wl01.rounds[0].status, "ok");
  assert.equal(wl01.rounds[0].usageComplete, true, "健康任务才是有效完整成本样本");
  assert.equal(wl01.rounds[0].totalTokens, 6);
  assert.equal(wl01.meanMultiplier, 1, "6/6 ⇒ 1.0×");
  assert.equal(wl01.flagged, false, "未达 5× ⇒ false（可计算，不是 null）");
  assert.equal(rep.partialUsage?.tokens, 0, "健康批没有已知部分用量");
  assert.ok(!md.includes("部分结果：未跑完"), "健康对照不是部分报告");
});
