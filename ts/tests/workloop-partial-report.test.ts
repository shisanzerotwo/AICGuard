/**
 * Work Loop **部分报告**必须保留已得到的原始结果（Codex 复核 R3）—— 真跑 `scripts/workloop-eval.ts`，零出网。
 *
 * 复现的入口级反例（修前）：
 *   良性 2 条调用失败 → 第 1 条攻击**成功拿到 7 入 + 11 出 = 18 token** → 下一条预算耗尽。
 *   脚本确实退出 2、JSON 也确实有 `partial: true`，但**那条 18-token 记录整个消失**：
 *   `writePartial()` 既不接收 `cases` 也不接收逐轮数据 ⇒ "已得的有效证据"被丢掉了。
 *
 * 本测试锁四件事：
 *   ① 中止/基线不成立 ⇒ 显式 `partial` + `partialReasons`（不是靠调用方猜）；
 *   ② 倍率**保持 null**（不得为了凑一个数字强造基线或倍率）；
 *   ③ 逐条/逐轮原始用量与执行状态**完整落盘**（含 18-token 那条与失败轮）；
 *   ④ 人读的 Markdown 里也能看到那条记录，且**不给整体结论**。
 *
 * 全程离线：替身桥 + 假凭据 + 临时目录（缓存落到 <out>/llm-cache/agent）。
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
const MIXED_STUB = join(HERE, "fixtures", "workloop-mixed-stub.mjs");

interface RoundRow {
  round: number;
  status: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  totalTokens: number | null;
  usageComplete: boolean;
  multiplier: number | null;
}
interface CaseRow {
  id: string; rounds: RoundRow[]; okRounds: number[]; unexecutedRounds: number;
  partialUsageTokens: number; partialUsageRounds: number;
  meanTokens: number | null; meanMultiplier: number | null; maxMultiplier: number | null; flagged: boolean | null;
}
interface Report {
  partial?: boolean; complete?: boolean; partialReasons?: string[];
  aborted?: boolean; budgetStop?: string; executed?: number; unexecuted?: number; totalSlots?: number;
  baseline?: { usable: boolean; meanTokens: number | null; okSamples: number; attempted: number; samples: Array<{ id: string; status: string; totalTokens: number | null; usageComplete: boolean }> };
  cases?: CaseRow[];
  failures?: string[];
  partialUsage?: { tokens: number; rounds: number; benignTokens: number; benignRounds: number };
}

test("R3 基线不成立 + 中止：partial 显式、倍率 null、**已得的 18-token 记录必须还在**", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-partial-"));
  const counter = join(dir, "calls.log");
  const r = spawnSync(process.execPath, [
    SCRIPT, "--samples", "1", "--benign-limit", "2", "--out", join(dir, "out"),
    "--budget", join(dir, "budget.json"), "--budget-limit", "1",
  ], {
    cwd: TS_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AICGUARD_BRIDGE: MIXED_STUB,
      AICGUARD_BASE_URL: "http://127.0.0.1:9/v1",   // 绝不会被真正访问（桥是替身）
      AICGUARD_API_KEY: "sk-test-not-real",
      AICGUARD_MODEL: `m-wl-mixed-${process.pid}`,
      COUNTER: counter,
    },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 2, `未跑完必须退出 2。输出：${out.slice(0, 800)}`);
  // 槽位：1 轮 ×（2 良性 + 6 攻击）= 8；被尝试的是 前 4 个（2 良性失败 + 1 攻击成功 + 1 撞墙）
  assert.equal(existsSync(join(dir, "out", "report.json")), true, "部分报告必须落盘");

  const rep = JSON.parse(readFileSync(join(dir, "out", "report.json"), "utf8")) as Report;
  // ① 显式 partial
  assert.equal(rep.partial, true, "必须显式标 partial");
  assert.equal(rep.complete, false);
  assert.ok((rep.partialReasons ?? []).some((x) => /良性基线不成立/.test(x)),
    `partialReasons 要点出基线不成立：${JSON.stringify(rep.partialReasons)}`);
  assert.ok((rep.partialReasons ?? []).some((x) => /预算中止/.test(x)), "同时要点出预算中止");
  assert.equal(rep.aborted, true);
  assert.equal(rep.budgetStop, "exhausted");
  assert.equal(rep.totalSlots, 8);
  assert.equal(rep.executed, 4, "被尝试过的槽位：2 良性 + 2 攻击");
  assert.equal(rep.unexecuted, 4, "其余槽位未执行");

  // ② 基线不成立 ⇒ 均值不可计算（不是 0），失败轮如实为失败
  assert.equal(rep.baseline?.usable, false);
  assert.equal(rep.baseline?.meanTokens, null, "基线不成立 ⇒ 均值必须是 null（不可计算），不得是 0");
  assert.equal(rep.baseline?.okSamples, 0);
  assert.equal(rep.baseline?.samples.length, 2, "良性两轮（都失败）也要留痕");
  assert.ok(rep.baseline?.samples.every((b) => b.status === "target_error" && b.usageComplete === false),
    "良性失败轮：状态如实为 target_error，且**不得**算作有效完整成本样本（D2 后原始用量照落盘，由 usageComplete 区分）");

  // ③ ★ 核心反例：18-token 那条原始记录必须还在，且**倍率保持 null**
  const wl01 = (rep.cases ?? []).find((c) => c.id === "WL-01");
  assert.ok(wl01, "cases 必须包含 WL-01");
  assert.equal(wl01!.rounds.length, 1, "WL-01 被尝试过 1 轮");
  const round = wl01!.rounds[0];
  assert.equal(round.status, "ok", "这一轮确实成功拿到了响应");
  assert.deepEqual(round.usage, { promptTokens: 7, completionTokens: 11 }, "原始用量（7 入 / 11 出）必须在产物里");
  assert.equal(round.totalTokens, 18, "18 token 的记录不得丢失");
  assert.equal(round.multiplier, null, "基线不成立 ⇒ 倍率必须为 null（不得强造）");
  assert.equal(wl01!.meanTokens, 18, "均值 token 仍可计算（有有效轮次）");
  assert.equal(wl01!.meanMultiplier, null, "倍率不可计算 ⇒ null");
  assert.equal(wl01!.maxMultiplier, null);
  assert.equal(wl01!.flagged, null, "达阈判定不可计算 ⇒ null（不得是 false）");
  assert.deepEqual(wl01!.okRounds, [1]);
  // 撞墙的那条如实记预算中止，且用量为 null
  const wl02 = (rep.cases ?? []).find((c) => c.id === "WL-02");
  assert.equal(wl02!.rounds[0].status, "budget_exhausted");
  // D2 后：中止轮的**原始用量照样落盘**（替身桥报 0），但必须显式标成"非有效完整样本"，
  // 且**不进**均值/倍率 —— 「不会看起来像很便宜」这条保证从"写 null"改由 usageComplete 承担。
  assert.equal(wl02!.rounds[0].usageComplete, false, "中止轮不得算作有效完整成本样本");
  assert.equal(wl02!.rounds[0].multiplier, null, "中止轮不得参与倍率");
  assert.equal(wl02!.meanTokens, null, "WL-02 无有效轮次 ⇒ 均值不可计算（不得把中止轮算进去）");
  assert.equal(wl02!.partialUsageTokens, 0, "替身桥在中止轮报 0 token ⇒ 不进已知部分用量汇总");
  // 根本没尝试的用例：rounds 为空但 unexecutedRounds 如实计数
  const wl06 = (rep.cases ?? []).find((c) => c.id === "WL-06");
  assert.deepEqual(wl06!.rounds, []);
  assert.equal(wl06!.unexecutedRounds, 1, "未尝试轮次要显式计数");

  // ④ 人读的 Markdown：能看到那条记录，且不给整体结论
  const md = readFileSync(join(dir, "out", "report.md"), "utf8");
  assert.match(md, /部分结果：未跑完/);
  assert.match(md, /入 7\/出 11=18 token/, "Markdown 的逐轮原始记录里要能看到那条 18-token");
  assert.match(md, /只覆盖已执行的 4 个槽位/, "必须写明结论只覆盖已执行子集");
  assert.ok(!/未达\s*5×\s*阈值/.test(md), "不得给出整体负结论");
  assert.ok(!/顺从度有限/.test(md), "不得对模型行为下整体负结论");
});
