/**
 * 候选池 schema v2 与迁移（M3-2，docs/21-M3任务卡（保护数据）.md §M3-2）。
 *
 * 为什么需要它（docs/15 §3.1）：
 *   - 新候选要有**稳定 ID、版本号、审核建议、最终状态及审核来源**；
 *   - **旧批准记录迁移为「待复核」**，同时**保留原状态与原始备注**；
 *   - 审核来源**核不实**的记录必须显式标 `legacy/provenance_unknown`，**不得留空冒充人工确认**。
 *
 * 现场事实（2026-10-12 实测，见 docs/21 §0）：候选池 52 行**结构化审核来源 0 条**
 * （`origin_run` 仅 10/52 有），因此本轮迁移出来的 `review` 全部是 legacy；
 * 这不是"迁移失败"，而是把"来源本来就缺失"如实记下来。
 *
 * 本模块是**纯逻辑、零 I/O、零网络**：读写文件由 scripts/migrate-candidates.ts 负责。
 */

import type { JudgeConfig } from "./types.ts";

/** 当前候选 schema 版本 */
export const CANDIDATE_SCHEMA_VERSION = 2;

/** 候选的现行状态（沿用 v1 的三值，不新增状态以免下游分叉） */
export type CandidateStatus = "approved" | "rejected" | "pending";

/**
 * 审核模式（docs/15 §3.1）：
 *   `manual_confirm` AI 只给建议/理由/置信，人工定状态；
 *   `auto_approve`   显式启用后按配置规则改状态，且**标记为 AI 审核**、不冒充人工；
 *   `legacy`         迁移前未记录模式（本轮全部如此）。
 */
export type ReviewMode = "manual_confirm" | "auto_approve" | "legacy";

/** 来源可核实性：
 *   `recorded`             结构化字段里有审核者/时间（本轮为 0 条）；
 *   `recorded-in-notes`    **在 `notes` 自由文本里**留有审核痕迹（如 `【AI 代审 Jev approved·conf 0.98】`）
 *                          —— 能回答“谁/哪种模式/置信度”，但**不是结构化字段**，不得与前者混为一谈；
 *   `legacy/provenance_unknown` 连自由文本痕迹也没有 ⇒ 不得参与排名/自动合并。
 */
export type ReviewProvenance = "recorded" | "recorded-in-notes" | "legacy/provenance_unknown";

/**
 * 判据来源：
 *   `configured`             用例自带 judge；
 *   `objective-detector`     无 judge 且目标由客观检测器判定（金丝雀 / marker）——既有语料约定，无需 judge；
 *   `missing-needs-review`   内容类目标（推荐禁用农药 / 有害内容）**必须有 judge** 却缺失 ⇒ 阻断合并。
 */
export type JudgeSource = "configured" | "objective-detector" | "missing-needs-review";

/**
 * 需要判据（judge）的目标：正式语料里这两类**几乎**都带 judge（49/51，缺 2 条既有遗留：
 * `probes_zh` 的 RJ-10、`sanity_positive` 的 PC-05，均为 `harmful_content`）；其余目标默认走客观检测器
 * （`tool_abuse` 0/26、`cost_amplification` 0/6 全不带 judge）。
 * ⚠️ 口径注意：早期注释曾写成“49/49 全部带 judge”，那是错的说法（由 M3-2 独立复核发现，见
 * `docs/m1-evidence/39-M3-2独立复核.txt` §D.1）——**这里的“缺 2 条”是既有语料缺口，不是候选池问题**。
 */
export const CONTENT_GOALS_REQUIRING_JUDGE = ["harmful_agrochemical", "harmful_content"] as const;

export interface CandidateReview {
  mode: ReviewMode;
  /** 审核者标识；AI 代审记 `ai:<名称>`；来源缺失时固定为 `legacy/provenance_unknown`（**不得**编造人名或模型名） */
  by: string;
  /** 审核时间（ISO）；来源缺失时为 null */
  at: string | null;
  /** 审核理由 / 迁移说明（人可读） */
  note: string;
  /** 置信度（0–1）；无来源时为 null */
  confidence: number | null;
  provenance: ReviewProvenance;
  /** 旧批准记录迁移后为 true：状态尚未经人工复核确认 */
  needsRecheck: boolean;
  /** 痕迹结论与迁移前状态不一致时为 true（如痕迹说 rejected、状态却是 approved） */
  conflict: boolean;
}

export interface CandidateV2 {
  schemaVersion: number;
  id: string;
  /** 记录版本号：每次状态/字段变更递增（本轮迁移统一记为 1） */
  version: number;
  family: string;
  text: string;
  goal: string;
  severity: number;
  source: string;
  /** 现行状态；旧 approved 迁移后为 `pending`（待复核） */
  status: CandidateStatus;
  /** 迁移前状态（**原样保留**，docs/15 §3.1） */
  statusBeforeMigration: CandidateStatus;
  /** 原始备注（**原样保留**） */
  notes: string;
  originRun: string | null;
  judge: JudgeConfig | null;
  judgeSource: JudgeSource;
  review: CandidateReview;
  merge: {
    /** 是否可被合并脚本自动合并（有任一 blocker 即 false） */
    autoMergeable: boolean;
    blockers: string[];
  };
}

/** 迁移前（schema v1）记录的最小形状 */
export interface CandidateV1 {
  id: string;
  family: string;
  text: string;
  goal: string;
  severity: number;
  notes: string;
  source: string;
  status: CandidateStatus;
  origin_run?: string;
  judge?: JudgeConfig;
  turns?: string[];
  schemaVersion?: number;
}

export interface MigrationSummary {
  total: number;
  /** 迁移**前**的状态分布（必须与迁移前一致：本轮 46/3/3） */
  statusBeforeMigration: Record<string, number>;
  /** 迁移**后**的现行状态分布（旧 approved ⇒ pending） */
  statusAfterMigration: Record<string, number>;
  needsRecheck: number;
  /** 来源核实情况（结构化 / 仅自由文本 / 未知） */
  provenanceRecorded: number;
  provenanceInNotes: number;
  provenanceLegacy: number;
  /** 迁移行里解析到 AI 代审痕迹的条数 / 其中与状态冲突的条数 */
  aiTraceParsed: number;
  aiTraceConflicts: number;
  judgeSource: Record<string, number>;
  /** blocker 计数（如 multiTurnMissingTurns / judgeMissingForContentGoal / needsRecheck） */
  blockers: Record<string, number>;
  /** 输入里已是 v2 的记录数（幂等：不重复迁移） */
  alreadyV2: number;
}

/** `notes` 里的审核痕迹：`【AI 代审 Jev approved·conf 0.98】红线 0.02；分布 1.00/0.00/0.00` */
export interface ReviewTrace {
  /** 审核者名称（原件写法，如 `Jev`） */
  reviewer: string;
  /** 痕迹里记录的结论（可能缺省） */
  decision: CandidateStatus | null;
  /** 置信度 */
  confidence: number | null;
  /** 痕迹原文（留痕用） */
  raw: string;
}

/**
 * 从 `notes` 自由文本里解析审核痕迹。
 * 现场形态（实测 25/52 条）：`【AI 代审 Jev approved·conf 0.98】…`
 * 解析失败一律返回 null（**不猜**）——猜出来的来源比没有来源更糟。
 */
export function parseReviewTrace(notes: string | undefined): ReviewTrace | null {
  if (!notes) return null;
  const m = notes.match(/【AI\s*代审\s*([^\s】]+)\s*(approved|rejected|pending)?[·・]?\s*conf\s*([\d.]+)】/);
  if (!m) return null;
  const conf = Number(m[3]);
  return {
    reviewer: m[1]!,
    decision: (m[2] as CandidateStatus | undefined) ?? null,
    confidence: Number.isFinite(conf) ? conf : null,
    raw: m[0],
  };
}

const isV2 = (raw: CandidateV1): boolean => raw.schemaVersion === CANDIDATE_SCHEMA_VERSION;

/** 由目标推断判据来源（见 JudgeSource 注释） */
export function judgeSourceFor(raw: CandidateV1): JudgeSource {
  if (raw.judge && (raw.judge.any?.length || raw.judge.requireContext?.length)) return "configured";
  return (CONTENT_GOALS_REQUIRING_JUDGE as readonly string[]).includes(raw.goal)
    ? "missing-needs-review"
    : "objective-detector";
}

/**
 * 迁移单条候选。
 * 幂等：输入已是 v2 ⇒ 原样返回（不覆盖已有 review，不重复打回待复核）。
 */
export function migrateCandidate(raw: CandidateV1): CandidateV2 {
  if (isV2(raw)) return structuredClone(raw as unknown as CandidateV2);

  const statusBeforeMigration = raw.status;
  // 旧批准记录迁移为「待复核」：状态置 pending，但原状态保留在 statusBeforeMigration
  const status: CandidateStatus = statusBeforeMigration === "approved" ? "pending" : statusBeforeMigration;
  const needsRecheck = statusBeforeMigration === "approved";
  const judgeSource = judgeSourceFor(raw);
  const trace = parseReviewTrace(raw.notes);
  const conflict = !!trace?.decision && trace.decision !== statusBeforeMigration;

  const blockers: string[] = [];
  if (needsRecheck) blockers.push("needsRecheck");
  // 多轮用例必须有轮次结构，否则文本是依赖上下文的一轮追问，直接合并会造出语义不自足的用例
  if (raw.family === "multi_turn_induction" && !(raw.turns?.length)) blockers.push("multiTurnMissingTurns");
  if (judgeSource === "missing-needs-review") blockers.push("judgeMissingForContentGoal");
  if (conflict) blockers.push("reviewTraceConflict");

  // 审核痕迹存在时如实登记为 **AI 审核**（docs/15 §3.1：auto_approve 必须标记为 AI 审核、不冒充人工确认）；
  // 无痕迹时才是 legacy。注意：**AI 审核 ≠ 人工确认** ⇒ 旧 approved 一律仍需人工复核。
  const traceNote = trace
    ? `${trace.raw}（`
      + `审核者：AI「${trace.reviewer}」；模式：AI 代审；决策：${trace.decision ?? "未记录"}；置信度：${trace.confidence ?? "未记录"}；`
      + `审核时间：自由文本未记录）`
      + (conflict ? `⚠️ 痕迹决策（${trace.decision}）与迁移前状态（${statusBeforeMigration}）**不一致**，已标 conflict` : "")
    : "自由文本里也没有审核痕迹";

  const reviewNote = needsRecheck
    ? `迁移自 schema v1：原状态 approved，${traceNote} ⇒ 按 docs/15 §3.1 打回待复核，保留原状态与原始备注；`
      + `AI 代审不等于人工确认，复核前不得参与合并与排名`
    : `迁移自 schema v1：原状态 ${statusBeforeMigration}（保持），${traceNote}`;

  return {
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    id: raw.id,
    version: 1,
    family: raw.family,
    text: raw.text,
    goal: raw.goal,
    severity: raw.severity,
    source: raw.source,
    status,
    statusBeforeMigration,
    notes: raw.notes,
    originRun: raw.origin_run ?? null,
    judge: raw.judge ?? null,
    judgeSource,
    review: {
      mode: trace ? "auto_approve" : "legacy",
      by: trace ? `ai:${trace.reviewer}` : "legacy/provenance_unknown",
      at: null,
      note: reviewNote,
      confidence: trace?.confidence ?? null,
      provenance: trace ? "recorded-in-notes" : "legacy/provenance_unknown",
      needsRecheck,
      conflict,
    },
    merge: { autoMergeable: blockers.length === 0, blockers },
  };
}

/** 迁移一批候选，并给出可逐项复算的汇总 */
export function migrateCandidates(raws: CandidateV1[]): { items: CandidateV2[]; summary: MigrationSummary } {
  const items = raws.map(migrateCandidate);
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const summary: MigrationSummary = {
    total: items.length,
    statusBeforeMigration: {},
    statusAfterMigration: {},
    needsRecheck: 0,
    provenanceRecorded: 0,
    provenanceInNotes: 0,
    provenanceLegacy: 0,
    aiTraceParsed: 0,
    aiTraceConflicts: 0,
    judgeSource: {},
    blockers: {},
    alreadyV2: raws.filter(isV2).length,
  };
  for (const it of items) {
    bump(summary.statusBeforeMigration, it.statusBeforeMigration);
    bump(summary.statusAfterMigration, it.status);
    bump(summary.judgeSource, it.judgeSource);
    if (it.review.needsRecheck) summary.needsRecheck++;
    if (it.review.provenance === "recorded") summary.provenanceRecorded++;
    else if (it.review.provenance === "recorded-in-notes") summary.provenanceInNotes++;
    else summary.provenanceLegacy++;
    if (it.review.mode === "auto_approve") summary.aiTraceParsed++;
    if (it.review.conflict) summary.aiTraceConflicts++;
    for (const b of it.merge.blockers) bump(summary.blockers, b);
  }
  return { items, summary };
}

/** 汇总自检：迁移前后的状态分布必须守恒（没有记录被凭空新增/丢弃） */
export function verifyDistributionPreserved(summary: MigrationSummary): { ok: boolean; reason: string } {
  const before = Object.values(summary.statusBeforeMigration).reduce((a, b) => a + b, 0);
  const after = Object.values(summary.statusAfterMigration).reduce((a, b) => a + b, 0);
  if (before !== summary.total || after !== summary.total) {
    return { ok: false, reason: `条数不守恒：total=${summary.total} before=${before} after=${after}` };
  }
  return { ok: true, reason: `条数守恒：${summary.total} 条（迁移前 ${JSON.stringify(summary.statusBeforeMigration)} → 迁移后 ${JSON.stringify(summary.statusAfterMigration)}）` };
}
