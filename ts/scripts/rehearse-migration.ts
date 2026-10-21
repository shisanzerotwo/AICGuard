/**
 * 迁移预演（M3-5，docs/21 §M3-5；契约 docs/15 §3.1 + §5.1 M3 进入条件）。
 *
 * 目的：在**不动正式语料**的前提下，把"拷贝 → 迁移 → 快照发布 → 审核预演 → 回滚"整条链路跑一遍，
 * 并产出**可逐项复算**的报告（每步命令、退出码、文件哈希前后对照）。
 *
 * 三条硬约束（脚本自己保证并在报告里自证）：
 *   1. **只读现场**：只读取 `--live`（默认主仓 `D:/GitHub/xiangmu/rjcx/data`），并在首尾各算一次哈希；
 *      任何"现场被改动"都会让脚本以退出码 1 结束（预演失败）。
 *   2. **写入全部限制在 `--work` 内**（默认 `ts/runs/m3-5-rehearsal`），不碰 `data/`、不碰正式快照根。
 *   3. **可回滚且可验证**：`pristine/` 是拷贝后未改动的原始副本；回滚 = 用它替换 `live-copy/`，
 *      然后逐字节校验与"预演前"一致（不一致即失败）。
 *
 * 用法：
 *   node scripts/rehearse-migration.ts                        # 默认现场=主仓 data，工作目录=ts/runs/m3-5-rehearsal
 *   node scripts/rehearse-migration.ts --live D:\GitHub\xiangmu\rjcx\data --work <dir>
 *   node scripts/rehearse-migration.ts ... --skip-gates       # 只演练流程（门禁仍会用轻量替代并如实标注）
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateCandidates, verifyDistributionPreserved, type CandidateV1 } from "../src/candidates.ts";
import { applyReviews, emptyState, loadState, saveState, setReviewMode, planMerge, type CandidateStoreState } from "../src/candidate-store.ts";
import { openSnapshotAt, publishSnapshot, verifySnapshot } from "../src/snapshot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const REPO_ROOT = join(TS_ROOT, "..");

const argv = process.argv.slice(2);
const argOf = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n: string): boolean => argv.includes(n);

const LIVE = resolve(argOf("--live") ?? join(REPO_ROOT, "data"));
// 注意：`join(cwd, 绝对路径)` 会拼出畸形路径（实测：...\ts\D:\...\runs\...）；
// 相对路径按 cwd 解析、绝对路径原样使用（与 migrate-candidates/review-candidates 保持同一约定）。
const workArg = argOf("--work");
const WORK = workArg
  ? resolve(isAbsolute(workArg) ? workArg : join(process.cwd(), workArg))
  : join(TS_ROOT, "runs", "m3-5-rehearsal");

/** 报告条目：每步都留命令/退出码/哈希对照 */
interface StepRecord {
  step: string;
  command: string;
  exitCode: number;
  detail: string;
  hashes?: Record<string, string>;
}
const steps: StepRecord[] = [];
let failed = false;
const step = (s: string, command: string, exitCode: number, detail: string, hashes?: Record<string, string>): void => {
  steps.push({ step: s, command, exitCode, detail, ...(hashes ? { hashes } : {}) });
  console.log(`${exitCode === 0 ? "✅" : "❌"} ${s} ｜ exit=${exitCode} ｜ ${detail}`);
  if (exitCode !== 0) failed = true;
};

const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

/** 目录内所有文件的 {相对路径: sha256}（跳过临时/锁文件，保证可复算） */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (name.endsWith(".lock") || name.includes(".tmp-")) continue;
      out[relative(dir, p).split("\\").join("/")] = sha256(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const eqTrees = (a: Record<string, string>, b: Record<string, string>): { same: boolean; diff: string[] } => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff: string[] = [];
  for (const k of keys) if (a[k] !== b[k]) diff.push(k);
  return { same: diff.length === 0, diff };
};

function main(): void {
  console.log(`迁移预演：现场=${LIVE} ｜ 工作目录=${WORK}`);
  if (!existsSync(LIVE)) { console.error(`现场目录不存在：${LIVE}`); process.exit(2); }

  // 工作目录干净起步（幂等：重复跑不会叠加）
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  // ── 步骤 1：现场只读快照（哈希 + 行数）───────────────────────────────
  const liveBefore = hashTree(LIVE);
  step("1. 现场只读快照", `hashTree(${LIVE})`, 0,
    `${Object.keys(liveBefore).length} 个文件；候选池 sha256=${liveBefore["probes_candidates.jsonl"]?.slice(0, 12) ?? "(无)"}`,
    liveBefore);

  // ── 步骤 2：拷贝到演练目录（+ 保留 pristine 原始副本）───────────────
  const liveCopy = join(WORK, "live-copy");
  const pristine = join(WORK, "pristine");
  cpSync(LIVE, join(liveCopy, "data"), { recursive: true });
  cpSync(LIVE, join(pristine, "data"), { recursive: true });
  const copyHashes = hashTree(join(liveCopy, "data"));
  const copyCheck = eqTrees(liveBefore, copyHashes);
  step("2. 拷贝到演练目录", `cpSync(${LIVE} → ${liveCopy}/data) + pristine 副本`, copyCheck.same ? 0 : 1,
    copyCheck.same ? `拷贝与现场逐字节一致（${Object.keys(copyHashes).length} 个文件）` : `拷贝不一致：${copyCheck.diff.join(",")}`);

  // ── 步骤 3：迁移候选池 v1 → v2（M3-2 逻辑，纯函数 + 原子写）──────────
  const candPath = join(liveCopy, "data", "probes_candidates.jsonl");
  if (!existsSync(candPath)) {
    step("3. 候选池迁移", "migrateCandidates()", 1, "演练目录里没有 probes_candidates.jsonl（现场是否缺文件？）");
  } else {
    const raws = readFileSync(candPath, "utf8").trim().split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as CandidateV1);
    const { items, summary } = migrateCandidates(raws);
    const dist = verifyDistributionPreserved(summary);
    const tmp = `${candPath}.tmp-migration`;
    writeFileSync(tmp, items.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");
    rmSync(candPath, { force: true });
    cpSync(tmp, candPath);
    rmSync(tmp, { force: true });
    step("3. 候选池迁移 v1→v2", "migrateCandidates() + 原子替换", dist.ok ? 0 : 1,
      `迁移前 ${JSON.stringify(summary.statusBeforeMigration)} → 迁移后 ${JSON.stringify(summary.statusAfterMigration)}；`
      + `来源 结构化${summary.provenanceRecorded}/自由文本${summary.provenanceInNotes}/未知${summary.provenanceLegacy}；`
      + `阻断项 ${JSON.stringify(summary.blockers)}；${dist.reason}`);
  }

  // ── 步骤 4：快照发布（对暂存跑门禁；快照根在演练目录内）────────────
  const snapRoot = join(WORK, "snapshots");
  const sources = ["probes_zh.jsonl", "probes_mt_zh.jsonl", "probes_agro.jsonl", "probes_garak_mt.jsonl",
    "probes_tool_abuse.jsonl", "probes_workloop.jsonl", "benign_zh.jsonl", "sanity_positive.jsonl", "probes_candidates.jsonl"]
    .map((f) => ({ from: join(liveCopy, "data", f), rel: `data/${f}` }))
    .filter((s) => existsSync(s.from));
  const skipGates = has("--skip-gates");
  const pub = publishSnapshot({
    root: snapRoot,
    sources,
    reason: "M3-5 迁移预演（隔离数据）",
    operator: "human:rehearsal",
    audit: [`现场=${LIVE}`, `演练目录=${WORK}`, "预演：不发布到正式快照根"],
    gates: (stagingDir) => {
      if (skipGates) return { ok: true, detail: "（--skip-gates：跳过真实门禁，仅演练流程）" };
      try {
        const out = execFileSync(process.execPath, [join(TS_ROOT, "scripts", "fp-regression.ts")], {
          env: { ...process.env, AICGUARD_DATA_DIR: join(stagingDir, "data") }, cwd: TS_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        const summary = out.split(/\r?\n/).filter((l) => /阴性误拦|输入侧拦截/.test(l)).join(" ｜ ");
        execFileSync(process.execPath, [join(TS_ROOT, "scripts", "harness-sanity.ts")], {
          env: { ...process.env, AICGUARD_DATA_DIR: join(stagingDir, "data") }, cwd: TS_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        return { ok: true, detail: `误报回归通过（${summary}）；阳性自检通过` };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return { ok: false, detail: `门禁失败：${(err.stdout ?? "") + (err.stderr ?? "") || err.message}` };
      }
    },
  });
  const commitId = pub.commitId ?? "";
  step("4. 快照发布（隔离根）", `publishSnapshot(root=${snapRoot})`, pub.ok ? 0 : 1,
    pub.ok ? `提交 ${commitId}${pub.reused ? "（同内容复用）" : ""}` : String(pub.error));
  if (pub.ok && commitId) {
    const v = verifySnapshot(snapRoot, commitId);
    const snap = openSnapshotAt(snapRoot, commitId)!;
    step("4b. 快照自校验", `verifySnapshot(${commitId})`, v.ok ? 0 : 1,
      v.ok ? `一致；快照内文件 ${snap.listFiles().length} 个（含候选池：${snap.listFiles().some((f) => f.endsWith("probes_candidates.jsonl"))}）` : v.problems.join("; "));
  }

  // ── 步骤 5：审核预演（人工 / 冲突 / AI 代审 / 合并计划）─────────────
  const statePath = join(WORK, "candidates-state.json");
  const snap = commitId ? openSnapshotAt(snapRoot, commitId) : null;
  const candidates = snap ? snap.readCandidates() : [];
  let state: CandidateStoreState = { ...emptyState(), candidates };
  saveState(statePath, state);
  const pick = (status: string): string | undefined => candidates.find((c) => c.status === status)?.id;

  const humanId = pick("pending") ?? candidates[0]?.id ?? "";
  const aiId = candidates.find((c) => c.id !== humanId && c.status === "pending")?.id ?? candidates[1]?.id ?? "";
  step("5. 审核预演-准备", `loadState → candidates=${candidates.length}`, candidates.length ? 0 : 1,
    `待审/可用候选：human=${humanId} ai=${aiId}（状态分布 ${JSON.stringify(candidates.reduce<Record<string, number>>((a, c) => ((a[c.status] = (a[c.status] ?? 0) + 1), a), {}))}）`);

  // 5a 人工审核（human:*）
  const r1 = applyReviews(state, [{ id: humanId, expectedVersion: 1, decision: "approved", mode: "manual_confirm", by: "human:rehearsal", note: "预演：人工确认" }]);
  state = r1.state;
  saveState(statePath, state);
  step("5a. 人工审核", `applyReviews(human:rehearsal ${humanId} expected=1)`, r1.report.applied.length === 1 ? 0 : 1,
    r1.report.applied.length ? `已应用 v1→v${r1.report.applied[0]!.toVersion}` : `冲突：${JSON.stringify(r1.report.conflicts)}`);

  // 5b 过期版本再审（模拟第二个标签页）⇒ 必须冲突
  const r2 = applyReviews(state, [{ id: humanId, expectedVersion: 1, decision: "rejected", mode: "manual_confirm", by: "human:tab2", note: "预演：过期版本" }]);
  step("5b. 版本冲突", `applyReviews(human:tab2 ${humanId} expected=1（过期）)`, r2.report.conflicts.length === 1 ? 0 : 1,
    r2.report.conflicts.length ? `冲突理由=${r2.report.conflicts[0]!.reason}，保留 ${r2.report.conflicts[0]!.kept.by}` : "本应冲突但没有冲突");

  // 5c AI 代审（auto_approve：先切模式，再以 ai:* 提交）
  state = setReviewMode(state, "auto_approve", { minConfidence: 0.9 });
  saveState(statePath, state);
  const r3 = applyReviews(state, [{ id: aiId, expectedVersion: 1, decision: "approved", mode: "auto_approve", by: "ai:jev", confidence: 0.95, note: "预演：AI 代审" }]);
  state = r3.state;
  saveState(statePath, state);
  step("5c. AI 代审", `setReviewMode(auto_approve) + applyReviews(ai:jev ${aiId})`, r3.report.applied.length === 1 ? 0 : 1,
    r3.report.applied.length ? `已应用；review.mode=${state.candidates.find((c) => c.id === aiId)?.review.mode}，needsRecheck=${state.candidates.find((c) => c.id === aiId)?.review.needsRecheck}` : `冲突：${JSON.stringify(r3.report.conflicts)}`);

  // 5d 合并：先"失败"（AI 那条仍带 needsRecheck） ⇒ 再"恢复"（人工复核后通过）
  const failPlan = planMerge(state, [
    { id: humanId, expectedVersion: state.candidates.find((c) => c.id === humanId)!.version, confirmedBy: "human:rehearsal" },
    { id: aiId, expectedVersion: state.candidates.find((c) => c.id === aiId)!.version, confirmedBy: "human:rehearsal" },
  ]);
  const aiRefused = failPlan.refused.some((r) => r.id === aiId && r.reason === "blocked");
  step("5d. 合并失败（预期）", `planMerge([${humanId}, ${aiId}])`, aiRefused ? 0 : 1,
    `允许 ${failPlan.planned.length} 条 / 拒绝 ${failPlan.refused.length} 条：${failPlan.refused.map((r) => `${r.id}(${r.reason})`).join("、")}`);

  // 5e 恢复：人工复核 AI 那条（清 needsRecheck）后再合并 ⇒ 通过
  const aiCur = state.candidates.find((c) => c.id === aiId)!;
  const r4 = applyReviews(state, [{ id: aiId, expectedVersion: aiCur.version, decision: "approved", mode: "manual_confirm", by: "human:rehearsal", note: "预演：人工复核 AI 代审结果" }]);
  state = r4.state;
  saveState(statePath, state);
  const after = state.candidates.find((c) => c.id === aiId)!;
  const okPlan = planMerge(state, [{ id: aiId, expectedVersion: after.version, confirmedBy: "human:rehearsal" }]);
  const blocked = okPlan.refused.filter((r) => !/needsRecheck/.test(r.detail));
  step("5e. 恢复：人工复核后合并", `applyReviews(manual_confirm ${aiId}) + planMerge()`, okPlan.planned.length === 1 ? 0 : 1,
    okPlan.planned.length === 1
      ? `人工复核后 needsRecheck=${after.review.needsRecheck}，合并计划通过（${okPlan.planned[0]!.id} v${okPlan.planned[0]!.version}）`
      : `仍被拒：${blocked.map((r) => `${r.id}(${r.reason}:${r.detail})`).join("、")}`);

  // ── 步骤 6：回滚 —— 用 pristine 覆盖 live-copy，并逐字节校验 ────────
  rmSync(liveCopy, { recursive: true, force: true });
  cpSync(pristine, liveCopy, { recursive: true });
  const rollbackHashes = hashTree(join(liveCopy, "data"));
  const rollbackCheck = eqTrees(liveBefore, rollbackHashes);
  const pristineCheck = eqTrees(liveBefore, hashTree(join(pristine, "data")));
  step("6. 回滚并校验", `rmSync(liveCopy) + cpSync(pristine → liveCopy)`, rollbackCheck.same && pristineCheck.same ? 0 : 1,
    rollbackCheck.same
      ? `回滚后与预演前**逐字节一致**（${Object.keys(rollbackHashes).length} 个文件）；pristine 未被污染=${pristineCheck.same}`
      : `回滚后不一致：${rollbackCheck.diff.join(",")}`);

  // ── 步骤 7：现场未被改动（只读自证）────────────────────────────
  const liveAfter = hashTree(LIVE);
  const liveCheck = eqTrees(liveBefore, liveAfter);
  step("7. 现场只读自证", `hashTree(${LIVE}) 前后对照`, liveCheck.same ? 0 : 1,
    liveCheck.same ? "现场（含候选池）逐字节未变 ✅" : `现场被改动：${liveCheck.diff.join(",")}`);

  // ── 报告 ──
  const report = {
    generatedAt: new Date().toISOString(),
    live: LIVE, work: WORK,
    candidatePoolSha256: liveBefore["probes_candidates.jsonl"] ?? null,
    snapshot: commitId ? { root: snapRoot, commitId, verifyOk: verifySnapshot(snapRoot, commitId).ok } : null,
    rollbackByteIdentical: rollbackCheck.same,
    liveUntouched: liveCheck.same,
    steps,
  };
  writeFileSync(join(WORK, "rehearsal-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  const md = [
    "# 迁移预演报告（M3-5，隔离数据）", "",
    `- 生成时间：${report.generatedAt}`,
    `- 现场（只读）：\`${LIVE}\` ｜ 候选池 sha256：\`${report.candidatePoolSha256}\``,
    `- 演练目录（全部写入都在这里）：\`${WORK}\``,
    `- 快照：${commitId ? `\`${commitId}\`（自校验 ${report.snapshot!.verifyOk ? "通过" : "失败"}）` : "未发布"}`,
    `- **回滚后与预演前逐字节一致**：${report.rollbackByteIdentical ? "是 ✅" : "否 ❌"}`,
    `- **现场未被改动**：${report.liveUntouched ? "是 ✅" : "否 ❌"}`, "",
    "| 步骤 | 命令 | 退出码 | 说明 |", "|---|---|---|---|",
    ...steps.map((s) => `| ${s.step} | \`${s.command}\` | ${s.exitCode} | ${s.detail.replace(/\|/g, "\\|")} |`),
    "", "## 哈希对照（现场 → 拷贝 → 回滚）", "",
    "```",
    `现场/拷贝/回滚 三者一致：${copyCheck.same && rollbackCheck.same ? "是 ✅" : "否 ❌"}`,
    ...Object.entries(liveBefore).map(([f, h]) => `${h.slice(0, 16)}  ${f}${copyHashes[f] === h ? "" : `  （拷贝差异：${copyHashes[f]?.slice(0, 16) ?? "缺失"}）`}${rollbackHashes[f] === h ? "" : `  （回滚差异：${rollbackHashes[f]?.slice(0, 16) ?? "缺失"}）`}`),
    "```", "",
  ].join("\n");
  writeFileSync(join(WORK, "rehearsal-report.md"), md, "utf8");

  console.log(`\n报告：${join(WORK, "rehearsal-report.md")}`);
  console.log(`结论：回滚逐字节一致=${rollbackCheck.same} ｜ 现场未改动=${liveCheck.same} ｜ 全部步骤成功=${!failed}`);
  process.exit(failed ? 1 : 0);
}

main();

void basename;
