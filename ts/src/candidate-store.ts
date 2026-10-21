/**
 * 候选写入模块与跨进程独占锁（M3-3，docs/21-M3任务卡（保护数据）.md §M3-3；契约 docs/15 §3.1）。
 *
 * 为什么必须有"单一写入模块 + 独占锁"：
 *   审核可能来自控制台（服务器进程）与 CLI（另一个进程），两者若各写各的，
 *   就会出现"同一候选被两次审核、后者覆盖前者""读到半份文件"这类事务问题。
 *   契约要求：**CLI 与服务器共用同一个写入模块与跨进程独占锁**；锁冲突拒绝写入；
 *   遗留锁必须先核实持有者与事务状态，**不得按超时自动抢锁**。
 *
 * 设计要点（都是"如实与可审计"取向）：
 *   1. 锁用 `openSync(path, "wx")`（O_CREAT|O_EXCL，NTFS/POSIX 都是原子的）创建锁文件；
 *      锁文件里写清 `lockId / owner / pid / purpose / startedAt`——谁持锁、为什么持、从何时起。
 *   2. `releaseLock` 只允许持有者本人（lockId 匹配）释放；**没有**超时夺锁。
 *   3. `inspectLock` 给出持有者是否还活着（`process.kill(pid, 0)` 探测）。
 *   4. `recoverStaleLock` 必须显式 `confirmHolderDead: true` 且**确实探测到持有者已死**，
 *      并往 `<lock>.audit.jsonl` 追加一条审计记录——恢复动作本身也要留痕。
 *   5. 写入走"临时文件 + rename"原子替换，避免半份文件被读到。
 *   6. 审核应用（`applyReviews`）是**纯函数**：先比对版本，只改"版本未变且仍符合审核条件"的记录，
 *      其余进冲突清单（保持原样，不回滚别人的决定）。
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import type { CandidateStatus, CandidateV2, ReviewMode } from "./candidates.ts";

/** 锁文件内容：谁、为何、何时 */
export interface LockInfo {
  lockId: string;
  owner: string;
  pid: number;
  purpose: string;
  startedAt: string;
}

export interface LockInspection {
  exists: boolean;
  lock: LockInfo | null;
  /** 持有者进程是否仍存活（探测 `process.kill(pid,0)`：EPERM 视为存活，ESRCH 视为已退出） */
  holderAlive: boolean | null;
  ageMs: number | null;
  raw: string;
}

export interface LockHandle { ok: true; lock: LockInfo }
export interface LockRefused { ok: false; reason: "locked" | "not-owner" | "io-error"; holder?: LockInfo | null; detail?: string }

const now = (): string => new Date().toISOString();
const newLockId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** 进程存活探测：ESRCH = 已退出；EPERM = 存在但无权限（视为存活） */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function inspectLock(lockPath: string): LockInspection {
  if (!existsSync(lockPath)) return { exists: false, lock: null, holderAlive: null, ageMs: null, raw: "" };
  const raw = readFileSync(lockPath, "utf8");
  let lock: LockInfo | null = null;
  try {
    lock = JSON.parse(raw) as LockInfo;
  } catch {
    lock = null; // 锁文件损坏：如实报告，不猜、不自动清
  }
  const ageMs = lock ? Date.now() - Date.parse(lock.startedAt) : null;
  return { exists: true, lock, holderAlive: lock ? isProcessAlive(lock.pid) : null, ageMs, raw };
}

/** 获取独占锁；已被占用时**拒绝**（不等待、不夺锁） */
export function acquireLock(lockPath: string, opts: { owner: string; purpose: string }): LockHandle | LockRefused {
  mkdirSync(dirname(lockPath), { recursive: true });
  const lock: LockInfo = { lockId: newLockId(), owner: opts.owner, pid: process.pid, purpose: opts.purpose, startedAt: now() };
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, "wx"); // 原子：已存在即 EEXIST
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      const ins = inspectLock(lockPath);
      return { ok: false, reason: "locked", holder: ins.lock, detail: ins.lock ? `${ins.lock.owner}(pid ${ins.lock.pid})` : "锁文件存在但不可解析" };
    }
    return { ok: false, reason: "io-error", detail: err.message };
  }
  try {
    writeSync(fd, JSON.stringify(lock));
  } finally {
    closeSync(fd);
  }
  return { ok: true, lock };
}

/** 释放锁：只有持有者（lockId 匹配）能释放，避免"释放别人的锁" */
export function releaseLock(lockPath: string, lockId: string): { ok: boolean; reason?: string } {
  const ins = inspectLock(lockPath);
  if (!ins.exists) return { ok: true };
  if (!ins.lock) return { ok: false, reason: "锁文件不可解析，按红线不自动清理；请人工核实后执行 recover" };
  if (ins.lock.lockId !== lockId) return { ok: false, reason: "not-owner" };
  unlinkSync(lockPath);
  return { ok: true };
}

/**
 * 遗留锁恢复：**必须**显式确认持有者已死（`confirmHolderDead: true`）且探测确实已死；
 * 恢复动作写审计文件 `<lock>.audit.jsonl`。锁文件损坏时也不自动清（要求人工介入）。
 */
export function recoverStaleLock(
  lockPath: string,
  opts: { confirmHolderDead: boolean; operator: string; reason: string },
): { ok: boolean; reason?: string; auditRecord?: string } {
  const ins = inspectLock(lockPath);
  if (!ins.exists) return { ok: true, reason: "无锁文件" };
  if (!opts.confirmHolderDead) return { ok: false, reason: "未显式确认持有者已死（红线：不得按超时自动抢锁）" };
  if (ins.lock && ins.holderAlive) return { ok: false, reason: `持有者仍存活（${ins.lock.owner} pid ${ins.lock.pid}），拒绝恢复` };
  const audit = { at: now(), operator: opts.operator, reason: opts.reason, lock: ins.lock, rawLock: ins.lock ? undefined : ins.raw };
  appendFileSync(`${lockPath}.audit.jsonl`, JSON.stringify(audit) + "\n", "utf8");
  rmSync(lockPath, { force: true });
  return { ok: true, auditRecord: `${lockPath}.audit.jsonl` };
}

/** 持锁执行一段写入；锁冲突即拒绝（返回 ok:false），执行完一定释放 */
export function withLock<T>(
  lockPath: string,
  opts: { owner: string; purpose: string },
  fn: () => T,
): { ok: true; value: T } | { ok: false; reason: string; holder?: LockInfo | null } {
  const got = acquireLock(lockPath, opts);
  if (!got.ok) return { ok: false, reason: `${got.reason}${got.detail ? `：${got.detail}` : ""}`, holder: got.holder };
  try {
    return { ok: true, value: fn() };
  } finally {
    const rel = releaseLock(lockPath, got.lock.lockId);
    if (!rel.ok) process.stderr.write(`[candidate-store] 释放锁失败：${rel.reason}\n`);
  }
}

// ══════════════════════════ 状态文档（JSON） ══════════════════════════

export interface CandidateStoreState {
  schemaVersion: number;
  /** 当前审核模式：默认 manual_confirm（auto_approve 必须显式开启） */
  reviewMode: ReviewMode;
  /** auto_approve 的规则（只有 mode=auto_approve 时生效） */
  autoApproveRules: AutoApproveRules;
  candidates: CandidateV2[];
}

/** auto_approve 规则：显式配置、可审计 */
export interface AutoApproveRules {
  enabled: boolean;
  minConfidence: number;
  /** 允许 AI 改状态的家族白名单；空数组表示不限 */
  allowedFamilies: string[];
  /** 是否允许 AI 覆盖迁移遗留痕迹冲突的记录（默认 false，交人工） */
  allowTraceConflict: boolean;
}

export const DEFAULT_AUTO_APPROVE_RULES: AutoApproveRules = {
  enabled: false,
  minConfidence: 0.9,
  allowedFamilies: [],
  allowTraceConflict: false,
};

export function emptyState(): CandidateStoreState {
  return { schemaVersion: 1, reviewMode: "manual_confirm", autoApproveRules: { ...DEFAULT_AUTO_APPROVE_RULES }, candidates: [] };
}

/** 从 JSONL（M3-2 迁移产物格式）导入候选 */
export function parseCandidatesJsonl(text: string): CandidateV2[] {
  return text.trim().split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as CandidateV2);
}

/** 导出为 JSONL（供 M3-4 快照发布使用） */
export function toCandidatesJsonl(candidates: CandidateV2[]): string {
  return candidates.map((c) => JSON.stringify(c)).join("\n") + "\n";
}

/**
 * 原子写：临时文件 + rename，避免读到半份文件。
 * ⚠️ **失败时必须清理临时文件并把错误说清楚**：Windows 上目标文件被其他进程占用（未带
 * FILE_SHARE_DELETE）时 `rename` 会失败——此时**原文件必须保持不变**，且不能把 `.tmp-*` 残留下来，
 * 否则下一次写入/复核者会把残留当成“半成品”。（M3-3 复核者列为未测分支，本次补齐。）
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 清理失败也不得掩盖原始错误
    }
    const err = e as NodeJS.ErrnoException;
    throw new Error(`原子写失败（原文件保持不变）：${err.code ?? ""} ${err.message}`.trim());
  }
}

export function loadState(path: string): CandidateStoreState {
  if (!existsSync(path)) return emptyState();
  const text = readFileSync(path, "utf8");
  const trimmed = text.trim();
  if (!trimmed) return emptyState();

  // ① 先尝试“完整状态文档”（多行 JSON 也能解析）
  try {
    const obj = JSON.parse(trimmed) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const rec = obj as Record<string, unknown>;
      if (Array.isArray(rec.candidates)) {
        return {
          schemaVersion: Number(rec.schemaVersion ?? 1),
          reviewMode: (rec.reviewMode as ReviewMode) ?? "manual_confirm",
          autoApproveRules: { ...DEFAULT_AUTO_APPROVE_RULES, ...((rec.autoApproveRules as object) ?? {}) },
          candidates: rec.candidates as CandidateV2[],
        };
      }
      if ("id" in rec) {
        // 单条候选（极小的 JSONL 文件）
        return { ...emptyState(), candidates: [rec as unknown as CandidateV2] };
      }
    }
  } catch {
    // 不是单个 JSON 文档 ⇒ 按 JSONL 继续解析
    // ⚠️ 早期实现在这里直接 JSON.parse 整段文本，于是“多行 JSONL”会抛语法错。
    //    单行夹具的单元测试掩盖了该缺陷，真实数据（52 行迁移产物）一跑就暴露（M3-3 自查发现）。
  }

  // ② JSONL：逐行一条候选（M3-2 迁移产物的格式）
  return { ...emptyState(), candidates: parseCandidatesJsonl(trimmed) };
}

export function saveState(path: string, state: CandidateStoreState): void {
  writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
}

// ══════════════════════════ 审核应用（纯函数） ══════════════════════════

export interface ReviewRequest {
  id: string;
  /** 审核者看到的版本号；与当前版本不一致即冲突 */
  expectedVersion: number;
  decision: CandidateStatus;
  /** `manual_confirm` = 人工决定；`auto_approve` = AI 按规则决定（必须标记为 AI） */
  mode: "manual_confirm" | "auto_approve";
  /** 人工写 `human:<name>`；AI 写 `ai:<name>`——由本模块校验，不靠自觉 */
  by: string;
  at?: string;
  note: string;
  confidence?: number | null;
  /** AI 审核时附上给人工看的建议（manual_confirm 模式下的"AI 只产生建议"） */
  aiSuggestion?: { by: string; decision: CandidateStatus; confidence: number | null; note: string } | null;
}

export interface ApplyConflict {
  id: string;
  reason: string;
  detail: string;
  /** 冲突时**保留**的既有决定（不回滚、不覆盖） */
  kept: { status: CandidateStatus; version: number; reviewMode: ReviewMode; by: string };
}

export interface ApplyReport {
  applied: Array<{ id: string; fromVersion: number; toVersion: number; decision: CandidateStatus; mode: ReviewMode; by: string }>;
  conflicts: ApplyConflict[];
}

/** auto_approve 是否允许改这条记录（规则显式配置；不满足即拒绝，交人工） */
export function evaluateAutoApprove(candidate: CandidateV2, rules: AutoApproveRules): { allowed: boolean; reason: string } {
  if (!rules.enabled) return { allowed: false, reason: "auto_approve 未显式启用" };
  if (rules.allowedFamilies.length && !rules.allowedFamilies.includes(candidate.family)) {
    return { allowed: false, reason: `family ${candidate.family} 不在白名单` };
  }
  if (candidate.merge.blockers.includes("judgeMissingForContentGoal")) {
    return { allowed: false, reason: "缺判据（judgeMissingForContentGoal）必须人工处理" };
  }
  if (candidate.review.conflict && !rules.allowTraceConflict) {
    return { allowed: false, reason: "存在审核痕迹冲突，规则未允许 AI 覆盖" };
  }
  return { allowed: true, reason: "规则允许" };
}

/** 重算合并阻断项（审核改变状态后必须重算，否则阻断项会陈旧） */
function recomputeBlockers(candidate: CandidateV2, opts: { needsRecheck: boolean; traceResolved: boolean }): string[] {
  const blockers: string[] = [];
  if (opts.needsRecheck) blockers.push("needsRecheck");
  if (candidate.family === "multi_turn_induction" && !(candidate as unknown as { turns?: string[] }).turns?.length) {
    blockers.push("multiTurnMissingTurns");
  }
  if (candidate.judgeSource === "missing-needs-review") blockers.push("judgeMissingForContentGoal");
  if (candidate.review.conflict && !opts.traceResolved) blockers.push("reviewTraceConflict");
  return blockers;
}

/**
 * 应用一批审核请求（**纯函数**，不改输入）。
 * 契约（docs/15 §3.1）：
 *   - AI 请求期间不持锁：本函数不接触锁，调用方**在写入那一刻**才持锁（见 CLI/服务器）；
 *   - 应用时重读状态、只改版本未变且仍符合条件的候选；冲突条目保留人工决定并返回冲突清单；
 *   - `auto_approve` 的决定**标记为 AI 审核**，不冒充人工确认。
 */
export function applyReviews(
  state: CandidateStoreState,
  requests: ReviewRequest[],
): { state: CandidateStoreState; report: ApplyReport } {
  const byId = new Map(state.candidates.map((c) => [c.id, c]));
  const report: ApplyReport = { applied: [], conflicts: [] };
  const next = new Map(byId);

  for (const req of requests) {
    const cur = byId.get(req.id);
    if (!cur) {
      report.conflicts.push({ id: req.id, reason: "not-found", detail: "候选不存在", kept: { status: "pending", version: 0, reviewMode: state.reviewMode, by: "" } });
      continue;
    }
    // v1 形状守卫（M3-5 实测踩到）：没迁移的候选没有 version/review，直接进去会以
    // “Cannot read properties of undefined (reading 'mode')” 崩成 500——那是无信息量的错误。
    // 这里提前给出**可执行**的冲突理由（先跑 scripts/migrate-candidates.ts 迁移）。
    if (typeof cur.version !== "number" || !cur.review) {
      report.conflicts.push({
        id: req.id, reason: "legacyRecordShape",
        detail: "该候选不是 schema v2（缺 version/review）⇒ 无法做版本冲突判定；先用 scripts/migrate-candidates.ts 迁移",
        kept: { status: cur.status ?? "pending", version: cur.version ?? 0, reviewMode: state.reviewMode, by: cur.review?.by ?? "" },
      });
      continue;
    }
    const kept = { status: cur.status, version: cur.version, reviewMode: cur.review.mode, by: cur.review.by };

    // 0) 模式与身份校验（不靠自觉：manual_confirm 必须是人工，auto_approve 必须标 AI）
    if (req.mode === "manual_confirm" && !req.by.startsWith("human:")) {
      report.conflicts.push({ id: req.id, reason: "manualConfirmNeedsHuman", detail: `manual_confirm 必须由人工决定，收到 by=${req.by}`, kept });
      continue;
    }
    if (req.mode === "auto_approve") {
      if (state.reviewMode !== "auto_approve") {
        report.conflicts.push({ id: req.id, reason: "autoApproveNotEnabled", detail: `当前审核模式是 ${state.reviewMode}，未显式启用 auto_approve`, kept });
        continue;
      }
      if (!req.by.startsWith("ai:")) {
        report.conflicts.push({ id: req.id, reason: "autoApproveMustBeMarkedAI", detail: `auto_approve 的 by 必须形如 ai:<name>，收到 ${req.by}`, kept });
        continue;
      }
      const verdict = evaluateAutoApprove(cur, state.autoApproveRules);
      if (!verdict.allowed) {
        report.conflicts.push({ id: req.id, reason: "autoApproveRuleNotMet", detail: verdict.reason, kept });
        continue;
      }
    }

    // 1) 版本冲突：AI/人工等待期间有人改过 ⇒ 拒绝应用，保留对方决定
    if (cur.version !== req.expectedVersion) {
      report.conflicts.push({
        id: req.id,
        reason: "versionConflict",
        detail: `期望版本 ${req.expectedVersion}，当前版本 ${cur.version}（审核等待期间已被改动）`,
        kept,
      });
      continue;
    }

    // 2) 应用
    const isHuman = req.mode === "manual_confirm";
    const needsRecheck = req.decision === "approved" ? !isHuman : false;
    const review: CandidateV2["review"] = {
      mode: req.mode,
      by: req.by,
      at: req.at ?? now(),
      note: req.note,
      confidence: req.confidence ?? null,
      // 结构化字段来自我们的写入模块 ⇒ recorded；AI 审核也如实标 auto_approve（见 mode/by）
      provenance: "recorded",
      needsRecheck,
      // 人工复核会实地看痕迹冲突，故人工决定视为解决该冲突；AI 不解决
      conflict: cur.review.conflict && !isHuman,
    };
    const updated: CandidateV2 = {
      ...cur,
      version: cur.version + 1,
      status: req.decision,
      review,
      merge: { autoMergeable: false, blockers: [] },
    };
    updated.merge.blockers = recomputeBlockers(updated, { needsRecheck, traceResolved: isHuman });
    updated.merge.autoMergeable = updated.merge.blockers.length === 0;
    next.set(req.id, updated);
    report.applied.push({ id: req.id, fromVersion: cur.version, toVersion: updated.version, decision: req.decision, mode: review.mode, by: review.by });
  }

  return {
    state: { ...state, candidates: state.candidates.map((c) => next.get(c.id) ?? c) },
    report,
  };
}

/**
 * 切换审核模式：**不追溯批准**任何现有候选（只改模式字段）。
 * 语义收紧（M3-3 测试发现）：`enabled` 与模式**绑定** —— 切到 `auto_approve` 即启用规则、
 * 切回 `manual_confirm` 即关闭。否则会出现“模式已切但规则还没开”的中间态，
 * 让人误以为 AI 已在工作（或相反），而契约要求 auto_approve 必须是**显式启用**的。
 * 切模式本身是显式动作（CLI `--mode` / 服务器 `confirm:true`），所以不再需要一个额外的 enabled 开关。
 */
export function setReviewMode(state: CandidateStoreState, mode: ReviewMode, rules?: Partial<AutoApproveRules>): CandidateStoreState {
  return {
    ...state,
    reviewMode: mode,
    autoApproveRules: { ...state.autoApproveRules, ...(rules ?? {}), enabled: mode === "auto_approve" },
  };
}

// ══════════════════════════ 合并计划（不写语料） ══════════════════════════

export interface MergeRequest {
  id: string;
  /** 确认时看到的版本号 */
  expectedVersion: number;
  /** **必须**人工确认（docs/15 §3.1：两种模式的合并均需人工确认具体条目及版本） */
  confirmedBy: string;
  note?: string;
}

export interface MergePlan {
  planned: Array<{ id: string; version: number; confirmedBy: string }>;
  refused: ApplyConflict[];
}

/**
 * 生成合并计划（**不写语料**，真写入属 M3-4 快照发布）。
 * 拒绝条件：非人工确认 / 状态不是 approved / 版本与确认时不一致 / 仍有合并阻断项。
 * 特别是：`needsRecheck`（AI 代审未获人工确认）与 `multiTurnMissingTurns`（轮次缺失）
 * 必须在合并前解决——这正是 M3-3 要守住的底线。
 */
export function planMerge(state: CandidateStoreState, requests: MergeRequest[]): MergePlan {
  const byId = new Map(state.candidates.map((c) => [c.id, c]));
  const plan: MergePlan = { planned: [], refused: [] };
  for (const req of requests) {
    const cur = byId.get(req.id);
    if (!cur) {
      plan.refused.push({ id: req.id, reason: "not-found", detail: "候选不存在", kept: { status: "pending", version: 0, reviewMode: state.reviewMode, by: "" } });
      continue;
    }
    const kept = { status: cur.status, version: cur.version, reviewMode: cur.review.mode, by: cur.review.by };
    if (!req.confirmedBy.startsWith("human:")) {
      plan.refused.push({ id: req.id, reason: "mergeNeedsHumanConfirmation", detail: `confirmedBy 必须是 human:<name>，收到 ${req.confirmedBy}`, kept });
      continue;
    }
    if (cur.status !== "approved") {
      plan.refused.push({ id: req.id, reason: "notApproved", detail: `现行状态是 ${cur.status}，不是 approved`, kept });
      continue;
    }
    if (cur.version !== req.expectedVersion) {
      plan.refused.push({ id: req.id, reason: "versionConflict", detail: `期望版本 ${req.expectedVersion}，当前 ${cur.version}`, kept });
      continue;
    }
    if (cur.merge.blockers.length) {
      plan.refused.push({ id: req.id, reason: "blocked", detail: `仍有阻断项：${cur.merge.blockers.join(",")}`, kept });
      continue;
    }
    plan.planned.push({ id: cur.id, version: cur.version, confirmedBy: req.confirmedBy });
  }
  return plan;
}
