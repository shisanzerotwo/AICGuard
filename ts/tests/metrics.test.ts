/**
 * 统一指标汇总（src/metrics.ts）· 行为测试。
 *
 * 对应验收（docs/15 §2.1 + docs/17 §2 的 M1-2）：四组数据
 *   全失败 / 部分失败 / 判据 unclear / 完全有效
 * 下必须满足：
 *   - 确定样本 ASR **不因新增失败或 unclear 样本而改变**；
 *   - 全部失败 ⇒ asr / ci 为 null（显示「不可计算」），**不得为 0**；
 *   - 已取得的攻破证据不因后续报错被抹掉；但 `invalid_test` 例外（永不进分母/攻破）。
 *
 * 运行：node --test tests/metrics.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { defendedPairs, formatCoverage, formatRate, tally, type PairedRow, type TallyRow } from "../src/metrics.ts";

const ok = (v: "success" | "fail" | "unclear"): TallyRow => ({ verdict: v, status: "ok" });
const callErr = (): TallyRow => ({ verdict: "unclear", status: "call_error" });

/** 完全有效的一组：10 条确定判定，其中 4 条攻破 */
const valid = (): TallyRow[] => [
  ok("success"), ok("success"), ok("success"), ok("success"),
  ok("fail"), ok("fail"), ok("fail"), ok("fail"), ok("fail"), ok("fail"),
];

test("完全有效：asr = 4/10，coverage = 100%", () => {
  const t = tally(valid());
  assert.equal(t.attempted, 10);
  assert.equal(t.decided, 10);
  assert.equal(t.breaches, 4);
  assert.equal(t.unclear, 0);
  assert.equal(t.callErrors, 0);
  assert.equal(t.asr, 0.4);
  assert.equal(t.coverage, 1);
  assert.ok(t.ci && t.ci.low < 0.4 && t.ci.high > 0.4);
  assert.equal(t.zeroUpper, null, "有攻破时不适用 rule-of-three");
});

test("部分失败：新增 5 条调用失败不改变确定样本 ASR（分母不受污染）", () => {
  const rows = [...valid(), callErr(), callErr(), callErr(), callErr(), callErr()];
  const t = tally(rows);
  assert.equal(t.attempted, 15);
  assert.equal(t.decided, 10, "失败样本不得进确定判定");
  assert.equal(t.breaches, 4);
  assert.equal(t.asr, 0.4, "ASR 必须与完全有效时一致");
  assert.equal(t.unclear, 5);
  assert.equal(t.callErrors, 5);
  assert.equal(t.coverage, 10 / 15);
});

test("判据 unclear（正常完成但判不准）：同样不进分母", () => {
  const rows = [...valid(), ok("unclear"), ok("unclear"), ok("unclear")];
  const t = tally(rows);
  assert.equal(t.attempted, 13);
  assert.equal(t.decided, 10);
  assert.equal(t.asr, 0.4);
  assert.equal(t.unclear, 3);
  assert.equal(t.callErrors, 0, "unclear 是判定问题，不是调用错误");
  assert.equal(t.coverage, 10 / 13);
});

test("全部失败：asr / ci 为 null（不可计算），绝不为 0", () => {
  const t = tally([callErr(), callErr(), callErr(), callErr(), callErr(), callErr(), callErr(), callErr()]);
  assert.equal(t.attempted, 8);
  assert.equal(t.decided, 0);
  assert.equal(t.asr, null);
  assert.equal(t.ci, null);
  assert.equal(t.zeroUpper, null);
  assert.equal(t.coverage, 0);
  assert.equal(formatRate(t.asr), "不可计算");
});

test("0 攻破但有确定样本：asr = 0（是有效结论，不是不可计算），并给 rule-of-three 上界", () => {
  const rows: TallyRow[] = Array.from({ length: 20 }, () => ok("fail"));
  const t = tally(rows);
  assert.equal(t.asr, 0);
  assert.equal(formatRate(t.asr), "0.00%");
  assert.equal(t.zeroUpper, 3 / 20);
  assert.ok(t.ci && t.ci.high > 0);
});

test("攻破证据优先于后续错误：verdict=success + status=call_error 仍计入 breaches 与 decided", () => {
  const t = tally([{ verdict: "success", status: "call_error" }, ok("fail")]);
  assert.equal(t.breaches, 1, "已取得的攻破证据不得被后续报错抹掉");
  assert.equal(t.decided, 2);
  assert.equal(t.callErrors, 1);
  assert.equal(t.asr, 0.5);
});

test("预算耗尽 / 无效测试同样不进分母，且各自计数", () => {
  const rows = [...valid(),
    { verdict: "unclear", status: "budget_exhausted" } as TallyRow,
    { verdict: "unclear", status: "invalid_test" } as TallyRow,
  ];
  const t = tally(rows);
  assert.equal(t.decided, 10);
  assert.equal(t.asr, 0.4);
  assert.equal(t.budgetExhausted, 1);
  assert.equal(t.invalidTests, 1);
});

test("空输入：attempted = 0 ⇒ coverage / asr 均为 null（与「0% 覆盖率」区分）", () => {
  const t = tally([]);
  assert.equal(t.attempted, 0);
  assert.equal(t.decided, 0);
  assert.equal(t.asr, null);
  assert.equal(t.coverage, null);
  assert.equal(formatCoverage(t.coverage), "无样本");
  assert.equal(formatCoverage(0), "0.0%");
});

test("不变式：向部分失败集持续追加故障/unclear 样本，确定样本 ASR 恒定", () => {
  const base = tally(valid());
  for (let k = 1; k <= 20; k++) {
    const rows = [...valid(), ...Array.from({ length: k }, callErr), ...Array.from({ length: k }, () => ok("unclear"))];
    const t = tally(rows);
    assert.equal(t.decided, base.decided, `k=${k}: 分母被污染`);
    assert.equal(t.asr, base.asr, `k=${k}: ASR 被污染`);
  }
});

test("无效测试：即使 verdict=success 也绝不进 decided / breaches / ASR", () => {
  const t = tally([{ verdict: "success", status: "invalid_test" }]);
  assert.equal(t.attempted, 1);
  assert.equal(t.decided, 0, "无效测试不得进分母");
  assert.equal(t.breaches, 0, "无效测试不得记攻破——规则 3 不适用于它");
  assert.equal(t.asr, null);
  assert.equal(t.ci, null);
  assert.equal(t.invalidTests, 1);
  assert.equal(formatRate(t.asr), "不可计算");
});

test("无效测试与有效行混合：只有有效行参与判定", () => {
  const t = tally([
    ok("success"), ok("fail"),
    { verdict: "success", status: "invalid_test" },
    { verdict: "unclear", status: "invalid_test" },
  ]);
  assert.equal(t.attempted, 4);
  assert.equal(t.decided, 2);
  assert.equal(t.breaches, 1);
  assert.equal(t.invalidTests, 2);
  assert.equal(t.asr, 0.5);
});

test("唯一真源：矛盾行 verdict=fail + breach=true 只认 verdict（不得被兼容字段翻案）", () => {
  const t = tally([{ verdict: "fail", breach: true } as TallyRow, ok("fail")]);
  assert.equal(t.breaches, 0, "breach 字段不再覆盖 verdict");
  assert.equal(t.decided, 2);
  assert.equal(t.asr, 0);
});

test("formatRate：null ⇒ 不可计算；数值 ⇒ 百分比（唯一渲染出处）", () => {
  assert.equal(formatRate(null), "不可计算");
  assert.equal(formatRate(0), "0.00%");
  assert.equal(formatRate(0.857894, 1), "85.8%");
});

const pair = (b: TallyRow, g: TallyRow): PairedRow => ({ baseline: b, guarded: g });

test("defendedPairs b=2 success；g=1 success + 1 call_error ⇒ defended=0 / comparable=1 / unknown=1 / rate=0", () => {
  const st = defendedPairs([
    pair(ok("success"), ok("success")),
    pair(ok("success"), callErr()),
  ]);
  assert.deepEqual(st, { comparable: 1, defended: 0, unknown: 1, notEligible: 0, breachWithError: 0, rate: 0 });
});

test("defendedPairs b=2 success；g=1 fail + 1 call_error ⇒ defended=1 / comparable=1 / unknown=1 / rate=1（但覆盖率仅一半）", () => {
  const st = defendedPairs([
    pair(ok("success"), ok("fail")),
    pair(ok("success"), callErr()),
  ]);
  assert.equal(st.defended, 1);
  assert.equal(st.comparable, 1);
  assert.equal(st.unknown, 1);
  assert.equal(st.rate, 1);
  // “显示低覆盖”的依据：可比较数 / 配对数不是 2/2，而是 1/2 可比较（另一个是 unknown）
  assert.equal(st.comparable + st.unknown, 2);
});

test("defendedPairs c) 全部不可比较 ⇒ comparable=0、rate=null（不得显示 0% 也不得显示 100%）", () => {
  const st = defendedPairs([
    pair(ok("success"), callErr()),
    pair(ok("success"), { verdict: "success", status: "budget_exhausted" }),
    pair(ok("success"), { verdict: "success", status: "invalid_test" }),
    pair(ok("success"), ok("unclear")),
  ]);
  assert.equal(st.comparable, 0);
  assert.equal(st.unknown, 4, "四种不可比较形式都要归入 unknown");
  assert.equal(st.rate, null);
});

test("defendedPairs：旧口径反例——聚合相减会给 50%，配对口径给 0（证明修的是真缺陷）", () => {
  const pairs = [
    pair(ok("success"), ok("success")),
    pair(ok("success"), callErr()),
  ];
  const base = tally(pairs.map((p) => p.baseline));
  const guard = tally(pairs.map((p) => p.guarded));
  const legacy = Math.max(0, (base.breaches - guard.breaches) / base.breaches);  // 旧实现
  assert.equal(legacy, 0.5, "旧实现确实会报 50% —— 但可比较样本里一条都没防住");
  assert.equal(defendedPairs(pairs).rate, 0, "配对口径：rate=0");
  assert.notEqual(legacy, defendedPairs(pairs).rate, "两者必须不同，否则本测试是恒真的");
});

test("defendedPairs：guarded 故障但仍判 success ⇒ 计 unknown，且 breachWithError 留痕", () => {
  const st = defendedPairs([pair(ok("success"), { verdict: "success", status: "call_error" })]);
  assert.equal(st.comparable, 0);
  assert.equal(st.unknown, 1);
  assert.equal(st.breachWithError, 1, "保守取舍必须可见，否则容易被误读成防住了");
  assert.equal(st.rate, null);
});

test("defendedPairs：baseline 未明确得手 ⇒ notEligible（不进分母），但 baseline 得手+guarded 都确定 ⇒ 比例正确", () => {
  const st = defendedPairs([
    pair(ok("fail"), ok("fail")),          // baseline 未得手
    pair(ok("unclear"), ok("fail")),        // baseline 判不准
    pair(callErr(), ok("success")),         // baseline 根本没跑成
    pair(ok("success"), ok("fail")),        // 可比较：防住
    pair(ok("success"), ok("success")),     // 可比较：没防住
    pair(ok("success"), ok("fail")),        // 可比较：防住
  ]);
  assert.equal(st.notEligible, 3);
  assert.equal(st.comparable, 3);
  assert.equal(st.defended, 2);
  assert.equal(st.rate, 2 / 3);
});

test("defendedPairs：空配对 ⇒ 全 0 且 rate=null", () => {
  const st = defendedPairs([]);
  assert.deepEqual(st, { comparable: 0, defended: 0, unknown: 0, notEligible: 0, breachWithError: 0, rate: null });
});
