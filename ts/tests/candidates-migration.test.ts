/**
 * M3-2 候选池迁移（schema v1 → v2）的验收测试（docs/21 §M3-2）。
 *
 * 覆盖的硬性验收：
 *   1. 旧批准记录 ⇒ 状态变「待复核」，**原状态与原始备注保留**（docs/15 §3.1）；
 *   2. 来源缺失一律标 `legacy/provenance_unknown`，**不得编造审核者/时间**；
 *   3. 状态分布守恒（本轮 46/3/3 必须逐项保留在 statusBeforeMigration）；
 *   4. 多轮用例无 `turns` ⇒ 阻断自动合并；内容类目标缺 judge ⇒ 阻断；其余目标走客观检测器；
 *   5. 幂等：对已是 v2 的记录再迁移 ⇒ 原样返回，不覆盖 review、不重复打回待复核；
 *   6. 原始字段零丢失（text/notes/family/goal/severity/source/origin_run/judge 逐字段相等）。
 *
 * 全部离线、只读真实候选池（不写任何文件）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANDIDATE_SCHEMA_VERSION,
  judgeSourceFor,
  migrateCandidate,
  migrateCandidates,
  parseReviewTrace,
  verifyDistributionPreserved,
  type CandidateV1,
} from "../src/candidates.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = join(HERE, "..", "..", "data", "probes_candidates.jsonl");

const base = (over: Partial<CandidateV1> = {}): CandidateV1 => ({
  id: "XX-01",
  family: "direct_injection",
  text: "示例文本",
  goal: "leak_system_prompt",
  severity: 3,
  notes: "原始备注",
  source: "native",
  status: "approved",
  origin_run: "20990101",
  ...over,
});

test("旧批准记录 ⇒ 待复核，原状态与原始备注保留，来源标 legacy", () => {
  const c = migrateCandidate(base());
  assert.equal(c.schemaVersion, CANDIDATE_SCHEMA_VERSION);
  assert.equal(c.status, "pending", "旧 approved 迁移后必须变 pending（待复核）");
  assert.equal(c.statusBeforeMigration, "approved", "原状态必须保留");
  assert.equal(c.notes, "原始备注", "原始备注必须原样保留");
  assert.equal(c.review.provenance, "legacy/provenance_unknown");
  assert.equal(c.review.needsRecheck, true);
  assert.equal(c.review.mode, "legacy", "无痕迹时不得声称任何审核模式");
  assert.equal(c.review.by, "legacy/provenance_unknown", "不得编造审核者");
  assert.equal(c.review.at, null, "不得编造审核时间");
  assert.equal(c.review.confidence, null);
  assert.equal(c.version, 1);
  assert.match(c.review.note, /没有审核痕迹/);
});

test("notes 里的 AI 代审痕迹：如实登记为 auto_approve（AI 审核，不冒充人工）", () => {
  const notes = "灵感来自 DI-14。【进化】源自 run 20261003104938 的 guarded 攻破案例，经 LLM 生成、人工审阅。【AI 代审 Jev approved·conf 0.98】红线 0.02；分布 1.00/0.00/0.00";
  const c = migrateCandidate(base({ notes }));
  assert.equal(c.review.mode, "auto_approve", "有痕迹 ⇒ 标 AI 审核模式");
  assert.equal(c.review.by, "ai:Jev", "保留原件里的审核者名称；前缀 ai: 以免与人工混淆");
  assert.equal(c.review.confidence, 0.98);
  assert.equal(c.review.provenance, "recorded-in-notes", "痕迹在自由文本里 ⇒ 不等于结构化来源");
  assert.equal(c.review.at, null, "痕迹里没有时间 ⇒ 不得编造");
  assert.equal(c.review.needsRecheck, true, "AI 代审 ≠ 人工确认 ⇒ 仍需复核");
  assert.equal(c.review.conflict, false);
  assert.match(c.review.note, /AI 代审不等于人工确认/);
  assert.equal(c.notes, notes, "原始备注（含痕迹）必须原样保留");
});

test("痕迹与状态冲突 ⇒ 标 conflict 并阻断", () => {
  const c = migrateCandidate(base({ status: "approved", notes: "【AI 代审 Jev rejected·conf 0.90】" }));
  assert.equal(c.review.conflict, true);
  assert.ok(c.merge.blockers.includes("reviewTraceConflict"));
  assert.match(c.review.note, /不一致/);
});

test("痕迹解析失败 ⇒ 不猜（返 null，不得凭空造审核者）", () => {
  assert.equal(parseReviewTrace("经 LLM 生成、人工审阅"), null);
  assert.equal(parseReviewTrace("【AI 代审】"), null, "缺审核者/置信度不完整时不解析");
  assert.equal(parseReviewTrace(undefined), null);
});

test("rejected / pending 保持原状态，且不需要复核", () => {
  const r = migrateCandidate(base({ id: "XX-02", status: "rejected" }));
  assert.equal(r.status, "rejected");
  assert.equal(r.statusBeforeMigration, "rejected");
  assert.equal(r.review.needsRecheck, false);

  const p = migrateCandidate(base({ id: "XX-03", status: "pending" }));
  assert.equal(p.status, "pending");
  assert.equal(p.statusBeforeMigration, "pending");
  assert.equal(p.review.needsRecheck, false);
});

test("判据来源：内容类目标缺 judge ⇒ 阻断；其余目标走客观检测器（不阻断）", () => {
  assert.equal(judgeSourceFor(base({ goal: "leak_system_prompt" })), "objective-detector");
  assert.equal(judgeSourceFor(base({ goal: "policy_bypass" })), "objective-detector");
  assert.equal(judgeSourceFor(base({ goal: "harmful_agrochemical" })), "missing-needs-review");
  assert.equal(judgeSourceFor(base({ goal: "harmful_content" })), "missing-needs-review");
  assert.equal(judgeSourceFor(base({ goal: "harmful_agrochemical", judge: { any: ["甲拌磷"] } })), "configured");

  const leak = migrateCandidate(base({ id: "XX-04", status: "pending" }));
  assert.equal(leak.judgeSource, "objective-detector");
  assert.deepEqual(leak.merge.blockers, [], "客观检测器路径不应阻断合并");

  const bad = migrateCandidate(base({ id: "XX-05", status: "pending", goal: "harmful_agrochemical" }));
  assert.ok(bad.merge.blockers.includes("judgeMissingForContentGoal"));
  assert.equal(bad.merge.autoMergeable, false);
});

test("多轮用例缺 turns ⇒ 阻断自动合并（有无 turns 形成对照）", () => {
  const noTurns = migrateCandidate(base({ id: "XX-06", status: "pending", family: "multi_turn_induction" }));
  assert.ok(noTurns.merge.blockers.includes("multiTurnMissingTurns"));
  const withTurns = migrateCandidate(base({ id: "XX-07", status: "pending", family: "multi_turn_induction", turns: ["轮1", "轮2"] }));
  assert.ok(!withTurns.merge.blockers.includes("multiTurnMissingTurns"), "补齐 turns 后不得再阻断");
});

test("幂等：已是 v2 的记录再迁移 ⇒ 原样返回，不覆盖已有 review", () => {
  const first = migrateCandidate(base({ id: "XX-08" }));
  // 模拟"人工复核已完成、状态已确认"的 v2 记录
  const reviewed = { ...first, status: "approved" as const, review: { ...first.review, mode: "manual_confirm" as const, by: "human:alice", at: "2026-10-12T10:00:00Z", provenance: "recorded" as const, needsRecheck: false } };
  const again = migrateCandidate(reviewed as unknown as CandidateV1);
  assert.deepEqual(again.review, reviewed.review, "已复核记录不得被迁移覆盖");
  assert.equal(again.status, "approved", "人工确认后的 approved 不得被打回待复核");

  const { summary } = migrateCandidates([reviewed as unknown as CandidateV1]);
  assert.equal(summary.alreadyV2, 1);
});

test("原始字段零丢失（逐字段相等）", () => {
  const raw = base({ id: "XX-09", judge: { any: ["甲拌磷"], kind: "recommend" }, turns: ["a"] });
  const c = migrateCandidate(raw);
  assert.equal(c.id, raw.id);
  assert.equal(c.family, raw.family);
  assert.equal(c.text, raw.text);
  assert.equal(c.goal, raw.goal);
  assert.equal(c.severity, raw.severity);
  assert.equal(c.source, raw.source);
  assert.equal(c.notes, raw.notes);
  assert.equal(c.originRun, raw.origin_run);
  assert.deepEqual(c.judge, raw.judge);
});

test("真实候选池：状态分布守恒（46/3/3 保留在 statusBeforeMigration）", () => {
  const raws = readFileSync(CANDIDATES, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l) as CandidateV1);
  const { items, summary } = migrateCandidates(raws);
  assert.equal(summary.total, raws.length);
  assert.deepEqual(summary.statusBeforeMigration, { approved: 46, rejected: 3, pending: 3 }, "迁移前分布必须与现场一致");
  assert.deepEqual(summary.statusAfterMigration, { pending: 49, rejected: 3 }, "旧 approved 全部转为待复核");
  assert.equal(summary.needsRecheck, 46);
  assert.equal(summary.provenanceRecorded, 0, "现场确实没有任何**结构化**审核来源");
  assert.equal(summary.provenanceInNotes, 49, "自由文本里有 AI 代审痕迹的条数（用非 /g 正则逐行实测 49/52）");
  assert.equal(summary.provenanceLegacy, raws.length - 49);
  assert.equal(summary.aiTraceParsed, 49);
  assert.equal(summary.aiTraceConflicts, 0, "现场没有痕迹决策与状态不一致的行");
  const dist = verifyDistributionPreserved(summary);
  assert.ok(dist.ok, dist.reason);
  // 三条已知现场问题必须被如实标注（docs/21 §0.1）
  assert.equal(summary.blockers.needsRecheck, 46);
  assert.equal(summary.blockers.multiTurnMissingTurns, 10);
  assert.equal(summary.judgeSource["objective-detector"], 10, "10 条无 judge 的候选目标均属客观检测器路径");
  assert.equal(summary.blockers.judgeMissingForContentGoal, undefined, "现场没有内容类目标缺 judge 的情况");
  assert.equal(items.length, 52);
});
