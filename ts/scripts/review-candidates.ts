/**
 * 候选审核 CLI（M3-3，docs/21 §M3-3）：与服务器**共用同一个写入模块与跨进程独占锁**。
 *
 * 为什么要有这个 CLI：审核可能来自控制台（服务器进程）与命令行（另一个进程）。
 * 契约要求两者共用一套写入模块 + 跨进程独占锁，否则会出现"两次审核互相覆盖""读到半份文件"。
 *
 * 事务纪律（全部命令都遵守）：
 *   1. 读取 + 决策**不持锁**（AI 请求可能很慢，不能占着锁）；
 *   2. 只有"重新读盘 → 应用 → 原子写盘"这一段持锁；
 *   3. 锁冲突 ⇒ 拒绝写入，打印持有者信息（不等待、不夺锁）；
 *   4. 版本不一致 ⇒ 只报冲突清单，**不覆盖别人的决定**；
 *   5. 遗留锁必须 `--confirm-holder-dead` + 确认真死才可恢复，并写审计。
 *
 * 用法（状态文件默认 ts/runs/candidates-state.json；锁文件在 ts/runs/locks/ 下）：
 *   node scripts/review-candidates.ts --list
 *   node scripts/review-candidates.ts --mode auto_approve --rules-conf 0.9
 *   node scripts/review-candidates.ts --review EV-01 --action approved --expect-version 1 --by human:alice --note "已核对语义"
 *   node scripts/review-candidates.ts --review EV-02 --action approved --expect-version 1 --by ai:jev --confidence 0.95
 *   node scripts/review-candidates.ts --merge-plan --items EV-01:2 --confirm human:alice
 *   node scripts/review-candidates.ts --lock-info
 *   node scripts/review-candidates.ts --unlock --operator human:alice --reason "已核实持有者退出" --confirm-holder-dead
 */
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyReviews,
  emptyState,
  inspectLock,
  loadState,
  planMerge,
  recoverStaleLock,
  saveState,
  setReviewMode,
  withLock,
  type CandidateStoreState,
  type ReviewRequest,
} from "../src/candidate-store.ts";
import type { CandidateStatus, ReviewMode } from "../src/candidates.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");

const argv = process.argv.slice(2);
const has = (n: string): boolean => argv.includes(n);
const argOf = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

const stateArg = argOf("--state");
// 相对路径必须按**当前工作目录**解析；早期写法在“相对路径”时静默回落到默认路径
//（演示时真的把状态写到了 ts/runs/candidates-state.json）——M3-3 自查发现并修正。
const statePath = stateArg
  ? resolve(isAbsolute(stateArg) ? stateArg : join(process.cwd(), stateArg))
  : join(TS_ROOT, "runs", "candidates-state.json");
/** 锁文件统一放 runs/locks/：既满足"跨进程独占"，又不在 data/ 里产生未跟踪文件 */
const lockPath = join(TS_ROOT, "runs", "locks", `${basename(statePath)}.lock`);

const fail = (msg: string, code = 2): void => {
  process.stderr.write(msg + "\n");
  process.exitCode = code;
};

/** 持锁做"重读 → 变更 → 原子写"；锁冲突则拒绝（不等待、不夺锁） */
function mutate(owner: string, purpose: string, fn: (s: CandidateStoreState) => CandidateStoreState): boolean {
  const got = withLock(lockPath, { owner, purpose }, () => {
    const cur = loadState(statePath);
    const next = fn(cur);
    saveState(statePath, next);
    return next;
  });
  if (!got.ok) {
    fail(`拒绝写入：${got.reason}\n（红线：锁冲突不等待、不夺锁；若确认持有者已退出，请用 --lock-info 核实后 --unlock --confirm-holder-dead）`, 3);
    return false;
  }
  return true;
}

function printState(s: CandidateStoreState): void {
  const byStatus = s.candidates.reduce<Record<string, number>>((a, c) => ((a[c.status] = (a[c.status] ?? 0) + 1), a), {});
  console.log(`状态文件：${statePath}`);
  console.log(`审核模式：${s.reviewMode}（auto_approve.enabled=${s.autoApproveRules.enabled}，minConfidence=${s.autoApproveRules.minConfidence}）`);
  console.log(`候选：${s.candidates.length} 条 ｜ 状态分布：${JSON.stringify(byStatus)}`);
  console.log(`可自动合并：${s.candidates.filter((c) => c.merge.autoMergeable).length} 条`);
}

/** 纯函数式变更的包装：返回 {ok,state}，避免每个分支都写一遍锁定逻辑 */
function mutatePure(owner: string, purpose: string, fn: (s: CandidateStoreState) => { state: CandidateStoreState; done: boolean }): void {
  const ok = mutate(owner, purpose, (s) => {
    const r = fn(s);
    if (!r.done) process.exitCode = 4; // 有冲突：不写盘（fn 内部已打印）
    return r.state;
  });
  if (!ok) return;
}

function main(): void {
  if (has("--help") || argv.length === 0) {
    console.log("用法见文件头注释（scripts/review-candidates.ts）");
    return;
  }

  // ── 只读命令 ──
  if (has("--lock-info")) {
    const ins = inspectLock(lockPath);
    console.log(JSON.stringify({ lockPath, ...ins }, null, 2));
    return;
  }
  if (has("--list")) {
    const s = loadState(statePath);
    printState(s);
    for (const c of s.candidates) {
      console.log(`  ${c.id} v${c.version} [${c.status}] ${c.family}/${c.goal} ｜ review=${c.review.mode}/${c.review.by}`
        + ` ｜ mergeable=${c.merge.autoMergeable}${c.merge.blockers.length ? ` blockers=${c.merge.blockers.join(",")}` : ""}`);
    }
    return;
  }

  // ── 遗留锁恢复（必须显式确认持有者已死）──
  if (has("--unlock")) {
    const operator = argOf("--operator") ?? "";
    const reason = argOf("--reason") ?? "";
    if (!operator.startsWith("human:")) return void fail("--operator 必须是 human:<name>");
    if (!reason) return void fail("--reason 必填（恢复动作要留痕）");
    const r = recoverStaleLock(lockPath, { confirmHolderDead: has("--confirm-holder-dead"), operator, reason });
    if (!r.ok) return void fail(`恢复失败：${r.reason}`, 3);
    console.log(`已恢复（审计：${r.auditRecord ?? "无锁文件，无需恢复"}）`);
    return;
  }

  // ── 切换审核模式（不追溯批准）──
  if (has("--mode")) {
    const mode = argOf("--mode") as ReviewMode;
    if (!["manual_confirm", "auto_approve"].includes(mode)) return void fail("--mode 只能是 manual_confirm / auto_approve");
    const conf = argOf("--rules-conf");
    const fams = argOf("--rules-families");
    mutate("cli", "切换审核模式", (s) => setReviewMode(s, mode, {
      ...(conf ? { minConfidence: Number(conf) } : {}),
      ...(fams ? { allowedFamilies: fams.split(",").filter(Boolean) } : {}),
      ...(has("--allow-trace-conflict") ? { allowTraceConflict: true } : {}),
    }));
    if (process.exitCode === 3) return;
    const after = loadState(statePath);
    console.log(`模式已切到 ${after.reviewMode}（auto_approve.enabled=${after.autoApproveRules.enabled}）；现有候选状态未被追溯修改`);
    printState(after);
    return;
  }

  // ── 审核一条候选 ──
  if (has("--review")) {
    const id = argOf("--review") ?? "";
    const action = (argOf("--action") ?? "") as CandidateStatus;
    const by = argOf("--by") ?? "";
    const expect = Number(argOf("--expect-version") ?? "NaN");
    const note = argOf("--note") ?? "";
    const confRaw = argOf("--confidence");
    if (!id) return void fail("--review 需要候选 id");
    if (!["approved", "rejected", "pending"].includes(action)) return void fail("--action 只能是 approved / rejected / pending");
    if (!Number.isInteger(expect)) return void fail("--expect-version 必填（你看到的版本号）");
    const mode: ReviewRequest["mode"] = by.startsWith("ai:") ? "auto_approve" : "manual_confirm";
    const request: ReviewRequest = {
      id, expectedVersion: expect, decision: action, mode, by,
      note: note || (mode === "auto_approve" ? "AI 代审（auto_approve）" : "人工审核"),
      confidence: confRaw ? Number(confRaw) : null,
    };
    mutatePure("cli", `审核 ${id}`, (s) => {
      const r = applyReviews(s, [request]);
      if (r.report.conflicts.length) {
        console.log(`❌ 未应用（冲突 ${r.report.conflicts.length} 条）：`);
        for (const c of r.report.conflicts) console.log(`   - ${c.id} ${c.reason}：${c.detail}（保留 ${c.kept.by || "原记录"} 的决定 version=${c.kept.version}）`);
        return { state: s, done: false };
      }
      const a = r.report.applied[0]!;
      console.log(`✅ 已应用：${a.id} v${a.fromVersion} → v${a.toVersion} ｜ ${a.decision} ｜ mode=${a.mode} by=${a.by}`);
      return { state: r.state, done: true };
    });
    return;
  }

  // ── 合并计划（只出计划，不写语料；真写入属 M3-4 快照发布）──
  if (has("--merge-plan")) {
    const items = (argOf("--items") ?? "").split(",").filter(Boolean).map((kv) => {
      const [id, v] = kv.split(":");
      return { id: id!, expectedVersion: Number(v), confirmedBy: argOf("--confirm") ?? "" };
    });
    if (!items.length) return void fail("--items 形如 EV-01:2,EV-02:1");
    const s = loadState(statePath);
    const plan = planMerge(s, items);
    console.log(`合并计划：允许 ${plan.planned.length} 条 / 拒绝 ${plan.refused.length} 条`);
    for (const p of plan.planned) console.log(`  ✅ ${p.id} v${p.version} 由 ${p.confirmedBy} 确认`);
    for (const r of plan.refused) console.log(`  ❌ ${r.id} ${r.reason}：${r.detail}`);
    if (plan.refused.length) process.exitCode = 4;
    console.log("（注意：本命令只生成计划，不写任何语料；语料写入与快照发布属 M3-4）");
    return;
  }

  fail(`未知命令组合：${argv.join(" ")}`);
}

if (!existsSync(dirname(statePath))) {
  // 只读命令不需要创建目录；写入命令由 saveState(原子写) 自动建目录
}
main();
void emptyState;
