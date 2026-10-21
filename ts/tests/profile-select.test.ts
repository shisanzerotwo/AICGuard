/**
 * G2（`docs/40`）：档位子集选择器 `selectProfiles` 的单元测试。
 *
 * 锁的是三条纪律：
 *   ① 不给名单 ⇒ **不收窄**（原 4 档，覆盖面不得被悄悄减少）；
 *   ② 名单里出现**未知档位名** ⇒ 报错（不得静默忽略——静默忽略会把"少跑档位"伪装成"跑过了"）；
 *   ③ 空/畸形名单 ⇒ 报错（不得静默回退成"全档"——那会把"收窄"反转成"放大"，直接烧额度）。
 * 另外锁顺序与去重（报告表格列顺序必须与候选表一致，否则同一批数据两种呈现）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { selectProfiles } from "../src/profile-select.ts";

const ALL = [
  { name: "none" },
  { name: "rules+norm" },
  { name: "full" },
  { name: "full+agent" },
];

test("G2-④ 缺省（undefined）⇒ 全档，顺序不变，且不改动入参", () => {
  const got = selectProfiles(ALL, undefined);
  assert.deepEqual(got.map((p) => p.name), ALL.map((p) => p.name));
  assert.notEqual(got, ALL, "必须返回新数组，不得把候选表本身交出去");
});

test("G2-③ 子集生效：只保留名单里的档位，顺序按候选表（不是按名单书写顺序）", () => {
  assert.deepEqual(selectProfiles(ALL, "full,none").map((p) => p.name), ["none", "full"]);
  assert.deepEqual(selectProfiles(ALL, "none,full").map((p) => p.name), ["none", "full"]);
});

test("G2-③ 容错与去重：空格与重复名不产生重复档位", () => {
  assert.deepEqual(selectProfiles(ALL, " none , full ").map((p) => p.name), ["none", "full"]);
  assert.deepEqual(selectProfiles(ALL, "none,none,full").map((p) => p.name), ["none", "full"]);
});

test("G2-① 反例：未知档位名必须报错（不得静默忽略）", () => {
  assert.throws(() => selectProfiles(ALL, "none,bogus"), /未知档位：bogus/,
    "未知名字必须显式报错");
  // 错误信息要能把"可选值"带出来，否则使用者只能去读源码
  assert.throws(() => selectProfiles(ALL, "bogus"), /可选：none \/ rules\+norm \/ full \/ full\+agent/);
});

test("G2-② 反例：空名单 / 只有逗号 / 只有空白 ⇒ 报错，不得回退成全档", () => {
  for (const spec of ["", ",", " , ", "   "]) {
    assert.throws(() => selectProfiles(ALL, spec), /--profiles 为空/,
      `空名单 ${JSON.stringify(spec)} 必须报错（静默回全档会放大额度）`);
  }
});

test("G2 阳性对照：名单命中多个档位时，返回的是它们的引用（管线不被重建）", () => {
  const got = selectProfiles(ALL, "full+agent,rules+norm");
  assert.deepEqual(got.map((p) => p.name), ["rules+norm", "full+agent"]);
  assert.equal(got[0], ALL[1], "必须复用候选表里的对象（管线保持同一实现）");
});
