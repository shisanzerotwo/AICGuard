/**
 * 阈值扫描的推荐逻辑（src/tuning.ts）· 行为测试。
 *
 * 对应 M1-2c 独立复核第三项：旧实现只要 rows 非空就会给"最优阈值"，
 * 且候选只用 fp_input 过滤——asr_input 为 null（攻击 ASR 不可计算）的行也可能被选中，
 * 表现为"证据不足却给出工作点"。
 *
 * 规则（本文件锁定）：
 *   候选必须同时具备 `fp_input !== null` 与 `asr_input !== null`；
 *   一个候选都没有 ⇒ threshold=null、feasible=false、insufficient=true（不可推荐）；
 *   混合有效/null 时只能从有效行里选。
 *
 * 运行：node --test tests/tuning-recommend.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { recommendSweep, type SweepRow } from "../src/tuning.ts";

const row = (threshold: number, patch: Partial<SweepRow> = {}): SweepRow => ({
  threshold,
  asr_input: 0.5,
  fp_input: 0,
  blocked_input: 100,
  benign_blocked_input: 0,
  decided_input: 373,
  unclear_input: 0,
  call_errors_input: 0,
  asr_full: 0.04,
  fp_full: 0,
  blocked_output: 5,
  benign_blocked_full: 0,
  decided_full: 373,
  ...patch,
});

test("无任何可行证据：两行 asr_input=null / fp_input=0 / decided=0 ⇒ 不可推荐", () => {
  const rows = [
    row(0.50, { asr_input: null, fp_input: 0, decided_input: 0 }),
    row(0.70, { asr_input: null, fp_input: 0, decided_input: 0 }),
  ];
  const rec = recommendSweep(rows);
  assert.equal(rec.threshold, null, "证据不足时不得给出阈值");
  assert.equal(rec.feasible, false, "不得声称找到了可行点");
  assert.equal(rec.insufficient, true);
  assert.match(rec.reason, /没有有效攻击判定/);
});

test("无证据时 Markdown 不显示星标工作点，也不出现『推荐工作点：阈值 x』", () => {
  const rows = [row(0.50, { asr_input: null, decided_input: 0 })];
  const rec = recommendSweep(rows);
  // 复用渲染逻辑（与外层一致的最小复刻：只验证阈值非空才打星）
  const cell = (r: SweepRow) => (rec.threshold !== null && Math.abs(r.threshold - rec.threshold) < 1e-9 ? " ⭐" : "");
  const line = `| ${rows[0].threshold.toFixed(2)}${cell(rows[0])} |`;
  assert.equal(line.includes("⭐"), false, "不得打星标");
  assert.equal(rec.threshold === null, true);
});

test("混合有效/null：只能从有效行选择（null 不得因为比较对象而胜出）", () => {
  const rows = [
    row(0.50, { asr_input: null, fp_input: 0, decided_input: 0 }),   // 无效：没有确定判定
    row(0.70, { asr_input: 0.06, fp_input: 0.0, decided_input: 373 }), // 有效
  ];
  const rec = recommendSweep(rows);
  assert.equal(rec.insufficient, false);
  assert.equal(rec.threshold, 0.70, "只能选有效行");
  assert.equal(rec.feasible, true);
});

test("约束内优先比 ASR，ASR 并列时沿用历史行为（取更小阈值）", () => {
  const rows = [
    row(0.50, { asr_input: 0.06 }),
    row(0.70, { asr_input: 0.06 }),
    row(0.90, { asr_input: 0.84 }),
  ];
  const rec = recommendSweep(rows);
  assert.equal(rec.threshold, 0.50, "并列时取更小阈值（历史行为，另见代码注释里的注释/代码矛盾）");
});

test("误报率不可计算的行不算满足误报约束（不能凭 null 进 feasible 集）", () => {
  const rows = [
    row(0.50, { fp_input: null, benign_blocked_input: 0, decided_input: 373 }),  // 误报不可计算
    row(0.70, { asr_input: 0.06, fp_input: 0.0 }),                               // 真正可行
  ];
  const rec = recommendSweep(rows);
  assert.equal(rec.feasible, true);
  assert.equal(rec.threshold, 0.70, "不得选中误报率不可计算的那一行");
});

test("全部误报超限：退化为选误报最低的候选（仍只在候选内选）", () => {
  const rows = [
    row(0.50, { asr_input: 0.06, fp_input: 0.30 }),
    row(0.70, { asr_input: 0.20, fp_input: 0.10 }),
  ];
  const rec = recommendSweep(rows);
  assert.equal(rec.feasible, false);
  assert.equal(rec.insufficient, false);
  assert.equal(rec.threshold, 0.70, "选误报率最低的候选");
});
