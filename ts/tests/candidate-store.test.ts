/**
 * M3-3a 验收测试：候选写入模块与跨进程独占锁（docs/21 §M3-3）。
 *
 * 覆盖契约（docs/15 §3.1）与验收项：
 *   1. 两个"标签页"同时审核同一候选 ⇒ **恰好一个成功**，另一个拿到冲突清单（版本冲突）；
 *   2. AI 审核等待期间人工改判 ⇒ 自动应用被拒（版本冲突），人工决定保留；
 *   3. `auto_approve` 产生的记录带 `review.mode=auto_approve` 且 `by=ai:*`（不冒充人工）；
 *   4. 切换审核模式**不追溯批准**现有候选；
 *   5. 跨进程锁：持锁进程活着时第二个写者被拒；杀掉持锁进程后**遗留锁不会自动被抢**，
 *      只有显式 recover（且确认持有者已死）才恢复，并留下审计记录；
 *   6. 原子写：写入过程用临时文件 + rename（不产生半份文件）；
 *   7. 合并计划：非人工确认 / 非 approved / 版本不符 / 有阻断项 一律拒绝。
 *
 * 全部离线；临时文件写在系统临时目录，**不触碰 data/**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acquireLock,
  applyReviews,
  emptyState,
  inspectLock,
  loadState,
  planMerge,
  recoverStaleLock,
  releaseLock,
  saveState,
  setReviewMode,
  withLock,
  type CandidateStoreState,
  type ReviewRequest,
} from "../src/candidate-store.ts";
import { migrateCandidate, type CandidateV1, type CandidateV2 } from "../src/candidates.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "aicguard-m33-"));

const makeCandidate = (over: Partial<CandidateV1> = {}): CandidateV2 =>
  migrateCandidate({
    id: "XX-01", family: "direct_injection", text: "文本", goal: "leak_system_prompt",
    severity: 3, notes: "备注", source: "native", status: "pending", ...over,
  });

const stateWith = (...cs: CandidateV2[]): CandidateStoreState => ({ ...emptyState(), candidates: cs });

const req = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "XX-01", expectedVersion: 1, decision: "approved", mode: "manual_confirm",
  by: "human:alice", note: "人工确认", ...over,
});

test("两个标签页同时审核同一候选 ⇒ 恰好一个成功，另一个进冲突清单", () => {
  const s0 = stateWith(makeCandidate());
  // 两个"标签页"都基于 version=1 的同一快照
  const tabA = applyReviews(s0, [req({ by: "human:alice", decision: "approved" })]);
  const tabB = applyReviews(s0, [req({ by: "human:bob", decision: "rejected" })]);

  assert.equal(tabA.report.applied.length, 1);
  assert.equal(tabB.report.applied.length, 1);
  assert.equal(tabA.report.conflicts.length, 0);
  assert.equal(tabB.report.conflicts.length, 0);

  // 现在把 tabB 的结果应用到 A 之后的真实状态上（模拟"后到的写入"）
  const late = applyReviews(tabA.state, [req({ by: "human:bob", decision: "rejected" })]);
  assert.equal(late.report.applied.length, 0, "后到者不得覆盖先到者");
  assert.equal(late.report.conflicts.length, 1);
  assert.equal(late.report.conflicts[0]!.reason, "versionConflict");
  assert.equal(late.report.conflicts[0]!.kept.by, "human:alice", "冲突时保留先到者的决定");
  assert.equal(late.state.candidates[0]!.status, "approved");
});

test("AI 审核等待期间人工改判 ⇒ 自动应用被拒（版本冲突），人工决定保留", () => {
  let s = stateWith(makeCandidate());
  s = setReviewMode(s, "auto_approve", { enabled: true });
  const aiWaiting = s;

  // 人工先改判（version 1 → 2）
  const human = applyReviews(aiWaiting, [req({ by: "human:carol", decision: "rejected" })]);
  assert.equal(human.report.applied.length, 1);

  // AI 基于旧版本的应用请求到达
  const ai = applyReviews(human.state, [req({ mode: "auto_approve", by: "ai:jev", confidence: 0.99, decision: "approved" })]);
  assert.equal(ai.report.applied.length, 0);
  assert.equal(ai.report.conflicts[0]!.reason, "versionConflict");
  assert.equal(ai.state.candidates[0]!.status, "rejected", "人工决定必须保留");
});

test("auto_approve：未显式启用 / 未标 AI / 不满足规则 ⇒ 一律拒绝", () => {
  const pending = makeCandidate();
  // ① 模式未启用
  const s1 = stateWith(pending);
  const r1 = applyReviews(s1, [req({ mode: "auto_approve", by: "ai:jev" })]);
  assert.equal(r1.report.conflicts[0]!.reason, "autoApproveNotEnabled");

  // ② 标了 auto_approve 但 by 不是 ai:*
  const s2 = { ...s1, reviewMode: "auto_approve" as const, autoApproveRules: { ...s1.autoApproveRules, enabled: true } };
  const r2 = applyReviews(s2, [req({ mode: "auto_approve", by: "human:alice" })]);
  assert.equal(r2.report.conflicts[0]!.reason, "autoApproveMustBeMarkedAI");

  // ③ 家族白名单不含该家族
  const s3 = { ...s2, autoApproveRules: { ...s2.autoApproveRules, allowedFamilies: ["roleplay_jailbreak"] } };
  const r3 = applyReviews(s3, [req({ mode: "auto_approve", by: "ai:jev" })]);
  assert.equal(r3.report.conflicts[0]!.reason, "autoApproveRuleNotMet");

  // ④ manual_confirm 用 AI 身份（必须由人工）
  const r4 = applyReviews(s1, [req({ mode: "manual_confirm", by: "ai:jev" })]);
  assert.equal(r4.report.conflicts[0]!.reason, "manualConfirmNeedsHuman");
});

test("auto_approve 的记录带 review.mode=auto_approve 且 by=ai:*，且仍标 needsRecheck", () => {
  const pending = makeCandidate();
  const s = { ...stateWith(pending), reviewMode: "auto_approve" as const, autoApproveRules: { ...emptyState().autoApproveRules, enabled: true } };
  const r = applyReviews(s, [req({ mode: "auto_approve", by: "ai:jev", confidence: 0.97, decision: "approved" })]);
  assert.equal(r.report.applied.length, 1);
  const c = r.state.candidates[0]!;
  assert.equal(c.review.mode, "auto_approve");
  assert.equal(c.review.by, "ai:jev");
  assert.equal(c.review.confidence, 0.97);
  assert.equal(c.review.needsRecheck, true, "AI 审核 ≠ 人工确认 ⇒ 仍需复核");
  assert.equal(c.status, "approved");
  assert.ok(c.merge.blockers.includes("needsRecheck"), "阻断项必须随审核结果重算");

  // 人工确认后才解除 needsRecheck
  const human = applyReviews(r.state, [req({ expectedVersion: c.version, by: "human:alice", decision: "approved" })]);
  const c2 = human.state.candidates[0]!;
  assert.equal(c2.review.mode, "manual_confirm");
  assert.equal(c2.review.needsRecheck, false);
  assert.equal(c2.merge.autoMergeable, true, "人工确认且无其他阻断项后才允许合并");
});

test("切换审核模式不追溯批准现有候选", () => {
  const s0 = stateWith(makeCandidate());
  const s1 = setReviewMode(s0, "auto_approve", { enabled: true });
  assert.equal(s0.candidates[0]!.status, "pending", "原状态不变");
  assert.equal(s1.candidates[0]!.status, "pending", "切模式不得追溯批准");
  assert.equal(s1.reviewMode, "auto_approve");
  assert.equal(s1.autoApproveRules.enabled, true);
  // 切回 manual_confirm 时 auto_approve 规则必须自动失效（避免"模式关了规则还开着"）
  const s2 = setReviewMode(s1, "manual_confirm");
  assert.equal(s2.autoApproveRules.enabled, false);
});

test("合并计划：非人工确认 / 非 approved / 版本不符 / 有阻断项 一律拒绝", () => {
  const pending = makeCandidate();
  const s = stateWith(pending);
  assert.equal(planMerge(s, [{ id: "XX-01", expectedVersion: 1, confirmedBy: "human:alice" }]).refused[0]!.reason, "notApproved");
  assert.equal(planMerge(s, [{ id: "XX-01", expectedVersion: 1, confirmedBy: "ai:jev" }]).refused[0]!.reason, "mergeNeedsHumanConfirmation");
  assert.equal(planMerge(s, [{ id: "XX-01", expectedVersion: 9, confirmedBy: "human:alice" }]).refused[0]!.reason, "notApproved");

  // 手工构造"已 approved 但仍有 needsRecheck 阻断"的记录
  const approvedBlocked: CandidateV2 = { ...pending, status: "approved", merge: { autoMergeable: false, blockers: ["needsRecheck"] } };
  const plan = planMerge(stateWith(approvedBlocked), [{ id: "XX-01", expectedVersion: 1, confirmedBy: "human:alice" }]);
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.refused[0]!.reason, "blocked");

  const clean: CandidateV2 = { ...pending, status: "approved", merge: { autoMergeable: true, blockers: [] } };
  const ok = planMerge(stateWith(clean), [{ id: "XX-01", expectedVersion: 1, confirmedBy: "human:alice" }]);
  assert.equal(ok.planned.length, 1);
  assert.equal(ok.planned[0]!.confirmedBy, "human:alice");
});

test("锁：第二个写者被拒；非持有者不能释放；锁文件记录持有者信息", () => {
  const lockPath = join(TMP, "t1.lock");
  const first = acquireLock(lockPath, { owner: "cli", purpose: "审核" });
  assert.equal(first.ok, true);
  const second = acquireLock(lockPath, { owner: "server", purpose: "审核" });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "locked");

  const ins = inspectLock(lockPath);
  assert.equal(ins.exists, true);
  assert.equal(ins.lock?.owner, "cli");
  assert.equal(ins.lock?.pid, process.pid);
  assert.equal(ins.holderAlive, true);

  if (first.ok) {
    const wrong = releaseLock(lockPath, "not-the-lock-id");
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, "not-owner");
    assert.equal(existsSync(lockPath), true, "非持有者不得删锁");
    assert.equal(releaseLock(lockPath, first.lock.lockId).ok, true);
  }
  assert.equal(existsSync(lockPath), false);
  rmSync(lockPath, { force: true });
});

test("跨进程锁：持锁进程活着 ⇒ 被拒；进程死后遗留锁**不自动被抢**，显式 recover 才恢复并留审计", async () => {
  const lockPath = join(TMP, "cross.lock");
  const holderScript = join(TMP, "holder.mjs");
  const storeUrl = pathToFileURL(join(HERE, "..", "src", "candidate-store.ts")).href;
  writeFileSync(holderScript, `
import { acquireLock } from ${JSON.stringify(storeUrl)};
const got = acquireLock(${JSON.stringify(lockPath)}, { owner: "child-holder", purpose: "模拟服务器持锁" });
process.stdout.write(JSON.stringify(got) + "\\n");
setTimeout(() => { /* 持锁不放，等待被杀 */ }, 30000);
`, "utf8");

  const child = spawn(process.execPath, [holderScript], { stdio: ["ignore", "pipe", "inherit"] });
  const line: string = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("子进程未在 15s 内报告持锁结果")), 15000);
    child.stdout.on("data", (d) => {
      buf += String(d);
      const nl = buf.indexOf("\n");
      if (nl >= 0) { clearTimeout(timer); resolve(buf.slice(0, nl)); }
    });
    child.on("error", reject);
  });
  assert.match(line, /"ok":true/, `子进程应成功持锁，实际：${line}`);

  // ① 持锁进程活着 ⇒ 本进程获取被拒
  const refused = acquireLock(lockPath, { owner: "parent", purpose: "并发写入" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "locked");
  const aliveIns = inspectLock(lockPath);
  assert.equal(aliveIns.holderAlive, true);
  assert.equal(aliveIns.lock?.owner, "child-holder");

  // ② 未确认持有者已死时，recover 必须拒绝（红线：不得按超时自动抢锁）
  const noConfirm = recoverStaleLock(lockPath, { confirmHolderDead: false, operator: "human:alice", reason: "锁卡住" });
  assert.equal(noConfirm.ok, false);
  assert.match(String(noConfirm.reason), /不得按超时自动抢锁/);
  const liveRecover = recoverStaleLock(lockPath, { confirmHolderDead: true, operator: "human:alice", reason: "试图恢复" });
  assert.equal(liveRecover.ok, false, "持有者还活着 ⇒ 不得恢复");
  assert.equal(existsSync(lockPath), true);

  // ③ 杀掉持锁进程 ⇒ 遗留锁仍在（不自动消失、不自动被抢）
  child.kill();
  // 等持有者**真的退出**：原来的固定 `sleep(800)` 在整批测试并行（node --test 多文件并发 + 密集 spawn）
  // 时不够——实测整批跑 3/6 次在这条上失败、单文件跑 3/3 全过，失败形态是"刚被 kill 就读成还活着"。
  // 改成**有界轮询**（≤5s）：只改"等多久"，**不改任何断言**（真等不到时依旧以同一条断言失败）。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && inspectLock(lockPath).holderAlive !== false) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const deadIns = inspectLock(lockPath);
  assert.equal(deadIns.exists, true, "进程死后锁文件必须仍然存在（遗留锁）");
  assert.equal(deadIns.holderAlive, false);
  const stillRefused = acquireLock(lockPath, { owner: "parent", purpose: "并发写入" });
  assert.equal(stillRefused.ok, false, "遗留锁不得被自动抢占");

  // ④ 显式 recover（确认持有者已死）⇒ 恢复成功并写审计，之后才可获取
  const recovered = recoverStaleLock(lockPath, { confirmHolderDead: true, operator: "human:alice", reason: "已核实 pid 退出、无未完成事务" });
  assert.equal(recovered.ok, true);
  const audit = readFileSync(`${lockPath}.audit.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].operator, "human:alice");
  assert.equal(audit[0].lock.owner, "child-holder");
  const ok2 = acquireLock(lockPath, { owner: "parent", purpose: "恢复后写入" });
  assert.equal(ok2.ok, true);
  if (ok2.ok) releaseLock(lockPath, ok2.lock.lockId);
  rmSync(`${lockPath}.audit.jsonl`, { force: true });
});

test("withLock：冲突即拒绝执行主体；执行完必然释放", () => {
  const lockPath = join(TMP, "t2.lock");
  const held = acquireLock(lockPath, { owner: "other", purpose: "占位" });
  let ran = false;
  const blocked = withLock(lockPath, { owner: "me", purpose: "写入" }, () => { ran = true; return 1; });
  assert.equal(blocked.ok, false);
  assert.equal(ran, false, "拿不到锁就不得执行写入主体");
  if (held.ok) releaseLock(lockPath, held.lock.lockId);

  const ok = withLock(lockPath, { owner: "me", purpose: "写入" }, () => 42);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value, 42);
  assert.equal(existsSync(lockPath), false, "执行完必须释放锁");
});

test("状态文档读写：JSON 状态与**多行** JSONL 两种形态都能载入（单行夹具曾掩盖真 bug）", () => {
  const p = join(TMP, "state.json");
  const s: CandidateStoreState = { ...stateWith(makeCandidate()), reviewMode: "manual_confirm" };
  saveState(p, s);
  const back = loadState(p);
  assert.equal(back.candidates.length, 1);
  assert.equal(back.reviewMode, "manual_confirm");

  // JSONL 形态（M3-2 迁移产物）也能载入，且默认模式是保守的 manual_confirm。
  // ⚠️ 必须用**多行**夹具：单行 JSONL 会被“整个文件当单个 JSON”的旧实现侥幸解析成功，
  //    从而掩盖真实缺陷（M3-3 用 52 行真实数据做端到端演示时才发现 loadState 抛语法错）。
  const jsonlPath = join(TMP, "cands.jsonl");
  writeFileSync(jsonlPath,
    [makeCandidate({ id: "XX-01" }), makeCandidate({ id: "XX-02" }), makeCandidate({ id: "XX-03" })].map((c) => JSON.stringify(c)).join("\n") + "\n",
    "utf8");
  const fromJsonl = loadState(jsonlPath);
  assert.equal(fromJsonl.candidates.length, 3, "多行 JSONL 必须逐行解析");
  assert.deepEqual(fromJsonl.candidates.map((c) => c.id), ["XX-01", "XX-02", "XX-03"]);
  assert.equal(fromJsonl.reviewMode, "manual_confirm");
  assert.equal(fromJsonl.autoApproveRules.enabled, false, "auto_approve 默认必须关闭");

  // 原子写：目录里不留临时文件
  const leftovers = readdirSync(TMP).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, [], `不应残留临时文件：${leftovers.join(",")}`);
  rmSync(p, { force: true });
});

// ══════════ M3-3c 加固：复核者列出的两个未测分支（损坏锁 / 文件占用） ══════════

test("损坏的锁文件：如实报告不猜、获取被拒、恢复需显式确认并留审计", () => {
  const lockPath = join(TMP, "corrupt.lock");
  writeFileSync(lockPath, "{ 这不是合法 JSON", "utf8");

  const ins = inspectLock(lockPath);
  assert.equal(ins.exists, true);
  assert.equal(ins.lock, null, "不可解析 ⇒ 不得猜出持有者");
  assert.equal(ins.holderAlive, null, "无法判定持有者是否存活");
  assert.match(ins.raw, /这不是合法 JSON/);

  const got = acquireLock(lockPath, { owner: "me", purpose: "写入" });
  assert.equal(got.ok, false, "锁文件存在（哪怕损坏）也必须拒绝写入");
  if (!got.ok) assert.equal(got.reason, "locked");

  const noConfirm = recoverStaleLock(lockPath, { confirmHolderDead: false, operator: "human:alice", reason: "锁文件损坏" });
  assert.equal(noConfirm.ok, false, "未显式确认时不得清理");

  // 损坏锁无法核实持有者 ⇒ 只能由人工确认后恢复，且必须留审计（如实记录"无法核实持有者"）
  const recovered = recoverStaleLock(lockPath, { confirmHolderDead: true, operator: "human:alice", reason: "锁文件损坏，已人工核实无进行中的事务" });
  assert.equal(recovered.ok, true);
  const audit = JSON.parse(readFileSync(`${lockPath}.audit.jsonl`, "utf8").trim().split("\n")[0]!) as { lock: unknown; rawLock?: string };
  assert.equal(audit.lock, null);
  assert.match(String(audit.rawLock), /不是合法 JSON/, "审计里要留下损坏内容原文，便于事后追溯");
  rmSync(`${lockPath}.audit.jsonl`, { force: true });
});

test("目标文件被其他进程占用时：原子写失败要干净（原文件不变、不残留临时文件）", async () => {
  const p = join(TMP, "occupied.json");
  saveState(p, { ...stateWith(makeCandidate()), reviewMode: "manual_confirm" });
  const before = readFileSync(p, "utf8");

  // 子进程持有文件句柄不放（Windows 上默认不带 FILE_SHARE_DELETE ⇒ rename 可能失败）
  const holder = join(TMP, "fh-holder.mjs");
  writeFileSync(holder, `
import { openSync } from "node:fs";
const fd = openSync(${JSON.stringify(p)}, "r");
process.stdout.write("HELD\\n");
setTimeout(() => { try { globalThis.process.exit(0); } catch {} }, 8000);
`, "utf8");
  const child = spawn(process.execPath, [holder], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));

  let thrown: Error | null = null;
  try {
    saveState(p, { ...stateWith(makeCandidate({ id: "XX-99" })), reviewMode: "auto_approve" });
  } catch (e) {
    thrown = e as Error;
  }
  child.kill();

  if (thrown) {
    // 失败路径：必须说清楚、原文件不变、不留临时文件
    assert.match(thrown.message, /原子写失败（原文件保持不变）/);
    assert.equal(readFileSync(p, "utf8"), before, "写入失败时原文件必须保持不变");
  } else {
    // 若该平台允许带句柄 rename（成功路径），则新内容必须完整可解析
    const s = loadState(p);
    assert.equal(s.reviewMode, "auto_approve");
    assert.equal(s.candidates.length, 1);
  }
  assert.deepEqual(readdirSync(TMP).filter((f) => f.includes(".tmp-")), [], "无论成功失败都不得残留临时文件");
  rmSync(p, { force: true });
});

test("清理临时目录（必须放最后：前面的用例都依赖它存在）", () => {
  rmSync(TMP, { recursive: true, force: true });
  assert.equal(existsSync(TMP), false);
});

test("v1 形状守卫：未迁移的候选要给出可执行的冲突理由，而不是崩成 500（M3-5 实测踩到）", () => {
  // 手工造一条 v1 形状（缺 version/review）的记录塞进状态里
  const legacy = { id: "EV-99", family: "direct_injection", text: "文本", goal: "leak_system_prompt", severity: 3, notes: "n", source: "native", status: "pending" };
  const state = { ...emptyState(), candidates: [legacy as never] };
  const r = applyReviews(state, [{ id: "EV-99", expectedVersion: 1, decision: "approved", mode: "manual_confirm", by: "human:alice", note: "试审 v1 记录" }]);
  assert.equal(r.report.applied.length, 0);
  assert.equal(r.report.conflicts.length, 1);
  assert.equal(r.report.conflicts[0]!.reason, "legacyRecordShape");
  assert.match(r.report.conflicts[0]!.detail, /migrate-candidates/, "错误信息必须指向迁移命令");
  assert.equal(r.state.candidates[0]!.status, "pending", "不得改动未迁移记录");
});
