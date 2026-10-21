/**
 * 报告只读适配（M2-3）· 行为测试。
 *
 * docs/15 §2.1：新报告 `schemaVersion: 2`；旧报告通过**只读适配**展示并标记历史版本，
 * **不覆盖原文件**；缺失字段一律视为不可用（**不得补 0**，否则会把"没有数据"渲染成"0% 攻破"）。
 *
 * 全部离线。运行：node --test tests/report-adapter.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPORT_SCHEMA_VERSION, adaptReport } from "../src/report-adapter.ts";

/** v1 形态的报告（无 schemaVersion、无 defense_* / versions / target_runtime） */
const legacyV1 = {
  meta: { run_id: "baseline", started_at: "2026-10-11T16:47:36.957Z", target: "AgroBot", profile: "档位 3" },
  metrics: { probe_total: 374, baseline_breach: 320, guarded_breach: 16, baseline_asr: 0.8579, guarded_asr: 0.0429, defense_rate: 0.95, false_positive_rate: 0 },
};

/** v2 形态的报告（带 schemaVersion / defense_* / versions / target_runtime） */
const v2 = {
  schemaVersion: REPORT_SCHEMA_VERSION,
  meta: { run_id: "m2-3", started_at: "2026-10-12T00:00:00Z", target: "AgroBot", profile: "档位 3" },
  metrics: {
    probe_total: 374, baseline_breach: 320, guarded_breach: 16,
    baseline_asr: 0.8579, guarded_asr: 0.0429, defense_rate: 0.95, false_positive_rate: 0,
    baseline_decided: 373, guarded_decided: 373, asr_computable: true,
  },
  versions: { codeSha: "a".repeat(40), corpusHash: "b".repeat(64) },
  target_runtime: { kind: "offline", name: "AgroBot" },
};

test("v2 报告：不标历史版本、无 warning、比率原样读出", () => {
  const v = adaptReport(v2);
  assert.equal(v.schemaVersion, 2);
  assert.equal(v.isLegacy, false);
  assert.equal(v.legacyLabel, "");
  assert.deepEqual(v.warnings, []);
  assert.equal(v.rates.baselineAsr, 0.8579);
  assert.equal(v.rates.guardedAsr, 0.0429);
  assert.equal(v.runId, "m2-3");
});

test("v1 报告：标为历史版本 + 缺失字段逐个告警 + 缺失比率为 null（不补 0）", () => {
  const v = adaptReport(legacyV1);
  assert.equal(v.schemaVersion, 1, "缺失 schemaVersion 按 1 记");
  assert.equal(v.isLegacy, true);
  assert.match(v.legacyLabel, /历史版本报告/);
  // 送进来的比率是有的，所以不告警；但 v2 独有字段必须逐个告警
  assert.equal(v.rates.baselineAsr, 0.8579);
  const fields = v.warnings.map((w) => w.field);
  for (const f of ["baseline_decided", "guarded_decided", "benign_evaluated", "defense_comparable", "asr_computable"]) {
    assert.ok(fields.includes(`metrics.${f}`), `应告警缺失字段 ${f}`);
  }
  assert.ok(fields.includes("versions"), "应告警缺 versions");
  assert.ok(fields.includes("target_runtime"), "应告警缺 target_runtime");
});

test("缺失的比率一律 null：绝不把「没有数据」变成 0", () => {
  const v = adaptReport({ meta: { run_id: "x" }, metrics: { baseline_asr: 0.5 } });
  assert.equal(v.rates.baselineAsr, 0.5);
  assert.equal(v.rates.guardedAsr, null);
  assert.equal(v.rates.defenseRate, null);
  assert.equal(v.rates.falsePositiveRate, null);
  assert.equal(v.rates.guardedAsr === 0, false, "null 不得等于 0");
  assert.ok(v.warnings.some((w) => w.field === "metrics.guarded_asr"));
});

test("更高版本的报告：保留版本号但打标记，不假装理解其余语义", () => {
  const v = adaptReport({ schemaVersion: 99, meta: { run_id: "future" }, metrics: {} });
  assert.equal(v.schemaVersion, 99);
  assert.equal(v.isLegacy, false, "更高版本不算历史版本，但要告警");
  assert.ok(v.warnings.some((w) => w.field === "schemaVersion" && /高于本程序支持/.test(w.reason)));
});

test("畸形输入不炸：空对象/字符串/数组都得到可用的最小视图", () => {
  for (const bad of [{}, "not a report", [], null, 42]) {
    const v = adaptReport(bad);
    assert.equal(typeof v.schemaVersion, "number");
    assert.equal(v.runId, "(未知)");
    assert.equal(v.rates.baselineAsr, null);
  }
});

test("只读适配不覆盖原文件（字节与 mtime 均不变）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-adapter-"));
  try {
    const p = join(dir, "report.json");
    const raw = JSON.stringify(legacyV1, null, 2) + "\n";
    writeFileSync(p, raw, "utf8");
    const before = { size: statSync(p).size, mtimeMs: statSync(p).mtimeMs, bytes: readFileSync(p, "utf8") };
    const v = adaptReport(JSON.parse(readFileSync(p, "utf8")));
    assert.equal(v.isLegacy, true);
    const after = { size: statSync(p).size, mtimeMs: statSync(p).mtimeMs, bytes: readFileSync(p, "utf8") };
    assert.deepEqual(after, before, "适配层必须是纯函数：不得改动原文件");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
