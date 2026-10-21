/**
 * 不可变快照与单一提交记录（M3-4，docs/21-M3任务卡（保护数据）.md §M3-4；契约 docs/15 §3.1）。
 *
 * 契约的五步（docs/15 §3.1）：
 *   1. 在**暂存目录**生成语料、候选池及审计记录；
 *   2. 对暂存快照执行**回归与评测**、检查**文件哈希**；
 *   3. 全部成功后，发布一个**指向该快照的提交记录**；
 *   4. 每次读取先**固定同一提交**，禁止混读；
 *   5. 发布前中断继续使用旧提交；发布后以有效提交记录确定状态。
 *      日志由提交记录生成，**不作为另一个独立事务**。
 *
 * 目录布局（`root` 默认 `<repo>/snapshots`，由调用方决定）：
 * ```
 *   <root>/snapshots/<commitId>/   内容（不可变；被提交记录引用后才算发布）
 *   <root>/commits/<commitId>.json 提交记录（引用快照 + 哈希清单 + 门禁结果 + 审计）
 *   <root>/current.json            当前有效提交的**指针**（原子替换；唯一可变点）
 *   <root>/staging/<commitId>/     暂存区（发布失败/中断时残留，读者永远看不到）
 * ```
 * 读者只能通过 `openSnapshot()` 拿到"已固定的提交"，这条路径**只读** `snapshots/<commitId>/`，
 * 所以不存在"读到一半新一半旧"的混读。
 *
 * commitId 是**内容寻址**的：由（父提交 + 内容清单哈希）派生 ⇒ 同内容重复发布得到同一 id（幂等），
 * 也使得"试图用不同内容覆盖同名提交"能被检出并拒绝（不可变性）。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";

import type { CandidateV2 } from "./candidates.ts";

export interface SnapshotEntry {
  /** 快照内相对路径（POSIX 风格，固定 /） */
  rel: string;
  sha256: string;
  bytes: number;
  /** 文本文件的行数（语料/候选池用），二进制可省略 */
  lines?: number;
}

export interface SnapshotCommit {
  commitId: string;
  createdAt: string;
  /** 上一个有效提交；首次发布为 null */
  parentCommitId: string | null;
  reason: string;
  /** 发布者：必须 `human:<name>`（发布是人做的决定） */
  operator: string;
  entries: SnapshotEntry[];
  /** 汇总哈希：`rel:sha256` 排序后拼接的 sha256（与 runmeta 的口径一致） */
  corpusHash: string;
  gates: { ok: boolean; detail: string; ranAt: string } | null;
  /** 审计记录（例如"哪些候选从哪个状态变成什么"），由提交记录承载 */
  audit: string[];
}

/** 故障注入缝：测试用它们模拟"写失败 / 发布前中断 / 发布后中断" */
export interface PublishHooks {
  afterStagingWrite?: (stagingDir: string) => void;
  afterVerify?: (stagingDir: string) => void;
  beforeCommitRecord?: (commit: SnapshotCommit) => void;
  beforePointerSwap?: (commit: SnapshotCommit) => void;
  afterPointerSwap?: (commit: SnapshotCommit) => void;
}

export interface PublishOptions {
  root: string;
  /** 要纳入快照的文件：{from: 绝对路径, rel: 快照内相对路径} */
  sources: Array<{ from: string; rel: string }>;
  reason: string;
  operator: string;
  /**
   * 对**暂存快照**跑回归/评测（契约五步的第 2 步）。
   * 参数是暂存目录的绝对路径——调用方应对**它**跑门禁/评测，而不是对工作区。
   */
  gates: (stagingDir: string) => { ok: boolean; detail: string };
  audit?: string[];
  hooks?: PublishHooks;
}

export interface PublishResult {
  ok: boolean;
  commitId?: string;
  error?: string;
  /** 本次是否为"同内容重复发布"（幂等命中，未改动任何东西） */
  reused?: boolean;
}

const now = (): string => new Date().toISOString();
const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");
const toPosix = (p: string): string => p.split("\\").join("/");

const paths = (root: string) => ({
  root,
  commits: join(root, "commits"),
  snapshots: join(root, "snapshots"),
  staging: join(root, "staging"),
  current: join(root, "current.json"),
});

/**
 * 内容寻址的 commitId：**只由内容清单决定**。
 * 为什么不含父提交：含父子会让"同内容再次发布"得到一个**不同**的 id，从而失去幂等性
 * （M3-4a 测试当场拓出这个设计冲突）。父子关系仍完整记在提交记录的 `parentCommitId` 里，
 * 可用于追溯，不参与不可变快照的身份。
 */
export function computeCommitId(entries: SnapshotEntry[]): string {
  const manifest = entries.slice().sort((a, b) => a.rel.localeCompare(b.rel)).map((e) => `${e.rel}:${e.sha256}`).join("\n");
  return sha256(manifest).slice(0, 16);
}

/** 汇总哈希：与 runmeta 的 corpusHash 同算法（便于对照） */
export function computeCorpusHash(entries: SnapshotEntry[]): string {
  return sha256(entries.slice().sort((a, b) => a.rel.localeCompare(b.rel)).map((e) => `${e.rel}:${e.sha256}`).join("\n"));
}

/** 收集目录下文件清单（跳过 lock/tmp 等临时产物） */
export function listSnapshotFiles(dir: string, prefix = ""): SnapshotEntry[] {
  const out: SnapshotEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith(".lock") || name.includes(".tmp-") || name === "MANIFEST.json") continue;
    const abs = join(dir, name);
    const rel = toPosix(prefix ? `${prefix}/${name}` : name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...listSnapshotFiles(abs, rel));
    } else {
      const buf = readFileSync(abs);
      const entry: SnapshotEntry = { rel, sha256: sha256(buf), bytes: buf.length };
      if (/\.(jsonl|json|md|txt)$/.test(name)) entry.lines = buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim()).length;
      out.push(entry);
    }
  }
  return out;
}

/** 原子写（临时文件 + rename）；失败时清理临时文件并把原因说清楚 */
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
    const err = e as NodeJS.ErrnoException;
    throw new Error(`原子写失败（原文件保持不变）：${err.code ?? ""} ${err.message}`.trim());
  }
}

/**
 * 发布快照：暂存 → 校验哈希 → 门禁 → 写快照目录 → 写提交记录 → **原子替换指针**。
 * 任一步失败/抛错 ⇒ **指针不动**（读者仍看旧提交），暂存区保留现场供排查。
 */
export function publishSnapshot(opts: PublishOptions): PublishResult {
  const p = paths(opts.root);
  if (!opts.operator.startsWith("human:")) {
    return { ok: false, error: `发布必须由人工发起：operator 形如 human:<name>，收到 ${opts.operator}` };
  }
  if (!opts.sources.length) return { ok: false, error: "sources 不能为空（没有内容就没有快照）" };
  for (const s of opts.sources) {
    if (!existsSync(s.from)) return { ok: false, error: `待发布文件不存在：${s.from}` };
  }

  const current = resolveCurrentCommit(opts.root);
  const parentCommitId = current?.commitId ?? null;

  // ① 暂存：写入 staging/<id>——先按内容算候选 id，再核对
  mkdirSync(p.staging, { recursive: true });
  const stagingDir = join(p.staging, `stage-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(stagingDir, { recursive: true });
  /** 本次发布是否已把内容落到 snapshots/<id>；用于失败时清理（指针未换 ⇒ 不该留下可被误认的提交） */
  let snapshotDir = "";
  let commitFile = "";
  let createdSnapshot = false;
  let pointerSwapped = false;
  /** 失败清理：只要指针没换，就清掉本次新建的快照目录与提交记录，保证“要么旧提交、要么新提交” */
  const rollback = (): void => {
    rmSync(stagingDir, { recursive: true, force: true });
    if (!pointerSwapped && createdSnapshot) {
      rmSync(snapshotDir, { recursive: true, force: true });
      rmSync(commitFile, { force: true });
    }
  };
  try {
    for (const s of opts.sources) {
      const dest = join(stagingDir, s.rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(s.from));
    }
    // ⚠️ 审计记录**只写进提交记录**（commit.audit），不写成快照内的文件：
    //    审计含时间戳，一旦落成文件就会被算进内容寻址清单，导致“同内容重复发布”得到一个新 commitId
    //    （M3-4b 端到端实测发现；单元测试当时没传 audit，所以漏掉了——现已补上带 audit 的回归用例）。
    opts.hooks?.afterStagingWrite?.(stagingDir);

    // ② 校验：暂存内容的哈希清单（此时还没算 commitId，先算 entries）
    const entries = listSnapshotFiles(stagingDir);
    const commitId = computeCommitId(entries);
    const corpusHash = computeCorpusHash(entries);
    opts.hooks?.afterVerify?.(stagingDir);

    // ③ 门禁：对**暂存快照**跑回归/评测
    const gate = opts.gates(stagingDir);
    if (!gate.ok) {
      rmSync(stagingDir, { recursive: true, force: true });
      return { ok: false, error: `门禁未通过，未发布（旧提交继续生效）：${gate.detail}` };
    }

    snapshotDir = join(p.snapshots, commitId);
    commitFile = join(p.commits, `${commitId}.json`);
    const commit: SnapshotCommit = {
      commitId, createdAt: now(), parentCommitId, reason: opts.reason, operator: opts.operator,
      entries, corpusHash, gates: { ...gate, ranAt: now() }, audit: opts.audit ?? [],
    };

    // 幂等：同内容（同 commitId）已存在 ⇒ 校验一致后直接复用，不重写
    if (existsSync(snapshotDir) || existsSync(commitFile)) {
      const v = verifySnapshot(opts.root, commitId);
      rmSync(stagingDir, { recursive: true, force: true });
      if (!v.ok) return { ok: false, error: `同名提交已存在但内容不一致（拒绝覆盖）：${v.problems.join("; ")}` };
      if (current?.commitId !== commitId) writeAtomic(p.current, JSON.stringify({ commitId, at: now() }, null, 2) + "\n");
      return { ok: true, commitId, reused: true };
    }

    // ④ 把暂存目录变成正式快照目录（同盘 rename，尽量原子）
    mkdirSync(p.snapshots, { recursive: true });
    try {
      renameSync(stagingDir, snapshotDir);
      createdSnapshot = true;
    } catch (e) {
      // rename 失败（例如跨设备）：退回拷贝 + 删除暂存
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EXDEV" || err.code === "EPERM" || err.code === "EACCES") {
        mkdirSync(snapshotDir, { recursive: true });
        createdSnapshot = true;
        for (const s of opts.sources) {
          const dest = join(snapshotDir, s.rel);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, readFileSync(s.from));
        }
        rmSync(stagingDir, { recursive: true, force: true });
      } else {
        rollback();
        return { ok: false, error: `快照落地失败（未发布）：${err.code ?? ""} ${err.message}` };
      }
    }
    // 快照目录内写一份自校验清单（内容寻址 ⇒ 与提交记录一致）
    writeFileSync(join(snapshotDir, "MANIFEST.json"), JSON.stringify({ commitId, entries }, null, 2) + "\n", "utf8");

    // ⑤ 提交记录：**先写记录，再换指针** ⇒ 换指针后读者一定能看到完整的新提交
    opts.hooks?.beforeCommitRecord?.(commit);
    mkdirSync(p.commits, { recursive: true });
    writeFileSync(commitFile, JSON.stringify(commit, null, 2) + "\n", "utf8");

    // ⑥ 指针原子替换（唯一可变点）。被占用/写失败 ⇒ 未发布，旧提交继续生效
    opts.hooks?.beforePointerSwap?.(commit);
    try {
      writeAtomic(p.current, JSON.stringify({ commitId, at: now() }, null, 2) + "\n");
    } catch (e) {
      rollback();
      return { ok: false, error: `指针替换失败，未发布（旧提交继续生效）：${(e as Error).message}` };
    }
    pointerSwapped = true;
    opts.hooks?.afterPointerSwap?.(commit);
    return { ok: true, commitId };
  } catch (e) {
    // 发布前/中的任何异常：回滚本次未生效的产物，指针不动
    rollback();
    return { ok: false, error: `发布中断，未生效（旧提交继续生效）：${(e as Error).message}` };
  }
}

/** 解析"当前有效提交"（只读指针 + 记录；日志/状态都从这里派生） */
export function resolveCurrentCommit(root: string): { commitId: string; commit: SnapshotCommit } | null {
  const p = paths(root);
  if (!existsSync(p.current)) return null;
  let commitId: string;
  try {
    commitId = (JSON.parse(readFileSync(p.current, "utf8")) as { commitId?: string }).commitId ?? "";
  } catch {
    return null; // 指针不可解析：视为"没有有效提交"，不猜测
  }
  if (!commitId) return null;
  const commitFile = join(p.commits, `${commitId}.json`);
  if (!existsSync(commitFile)) return null; // 记录缺失 ⇒ 该提交无效（发布后中断也能自证）
  try {
    return { commitId, commit: JSON.parse(readFileSync(commitFile, "utf8")) as SnapshotCommit };
  } catch {
    return null;
  }
}

export function verifySnapshot(root: string, commitId: string): { ok: boolean; problems: string[] } {
  const p = paths(root);
  const problems: string[] = [];
  const snapshotDir = join(p.snapshots, commitId);
  const commitFile = join(p.commits, `${commitId}.json`);
  if (!existsSync(snapshotDir)) problems.push(`快照目录缺失：${snapshotDir}`);
  if (!existsSync(commitFile)) problems.push(`提交记录缺失：${commitFile}`);
  if (problems.length) return { ok: false, problems };
  const commit = JSON.parse(readFileSync(commitFile, "utf8")) as SnapshotCommit;
  for (const e of commit.entries) {
    const abs = join(snapshotDir, e.rel);
    if (!existsSync(abs)) { problems.push(`条目缺失：${e.rel}`); continue; }
    const buf = readFileSync(abs);
    if (sha256(buf) !== e.sha256) problems.push(`哈希不符：${e.rel}`);
  }
  const actual = listSnapshotFiles(snapshotDir);
  const actualSet = new Set(actual.map((a) => `${a.rel}:${a.sha256}`));
  for (const e of commit.entries) if (!actualSet.has(`${e.rel}:${e.sha256}`)) problems.push(`提交记录里的条目在快照里对不上：${e.rel}`);
  // **双向核对（M3-4c，复核者 D3 拓出的真缺口）**：不可变快照里多出清单外的文件也是被篡改/污染的信号。
  //  早期实现只查“清单里的条目是否存在”，手工塞一个额外文件进去不会被 --verify 发现。
  //  例外：`MANIFEST.json` 是发布时随快照写的自校验清单（发布后写、因此不在 entries 里），显式放过。
  const expected = new Set(commit.entries.map((e) => e.rel));
  for (const a of actual) {
    if (a.rel === "MANIFEST.json") continue;
    if (!expected.has(a.rel)) problems.push(`快照里有清单外的文件（不可变快照不应出现）：${a.rel}`);
  }
  return { ok: problems.length === 0, problems };
}

/** 打开"当前已固定的提交"：一次解析，之后所有读取都在这个 commitId 内（禁止混读） */
export interface OpenedSnapshot {
  commitId: string;
  commit: SnapshotCommit;
  dir: string;
  listFiles(): string[];
  read(rel: string): string;
  readJsonl<T = unknown>(rel: string): T[];
  readCandidates(): CandidateV2[];
}

export function openSnapshotAt(root: string, commitId: string): OpenedSnapshot | null {
  const p = paths(root);
  const dir = join(p.snapshots, commitId);
  const commitFile = join(p.commits, `${commitId}.json`);
  if (!existsSync(dir) || !existsSync(commitFile)) return null;
  const commit = JSON.parse(readFileSync(commitFile, "utf8")) as SnapshotCommit;
  const allowed = new Set(commit.entries.map((e) => e.rel));
  const guard = (rel: string): string => {
    const norm = toPosix(rel);
    if (!allowed.has(norm)) throw new Error(`该文件不在提交 ${commitId} 的清单里（禁止跨提交/越界读取）：${rel}`);
    return join(dir, norm);
  };
  return {
    commitId, commit, dir,
    listFiles: () => [...allowed].sort(),
    read: (rel) => readFileSync(guard(rel), "utf8"),
    readJsonl: <T,>(rel: string): T[] =>
      readFileSync(guard(rel), "utf8").trim().split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as T),
    readCandidates: () => {
      const rel = commit.entries.find((e) => basename(e.rel) === "probes_candidates.jsonl")?.rel;
      if (!rel) return [];
      return readFileSync(guard(rel), "utf8").trim().split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as CandidateV2);
    },
  };
}

export function openSnapshot(root: string): OpenedSnapshot | null {
  const cur = resolveCurrentCommit(root);
  if (!cur) return null;
  return openSnapshotAt(root, cur.commitId);
}

/** 发布日志：**由提交记录生成**（不是另一个独立事务） */
export function renderReleaseLog(root: string): string {
  const p = paths(root);
  if (!existsSync(p.commits)) return "# 发布日志\n\n（暂无提交记录）\n";
  const files = readdirSync(p.commits).filter((f) => f.endsWith(".json")).sort();
  const commits = files.map((f) => JSON.parse(readFileSync(join(p.commits, f), "utf8")) as SnapshotCommit)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const current = resolveCurrentCommit(root);
  const lines = ["# 发布日志（由提交记录生成）", ""];
  lines.push(`当前有效提交：**${current?.commitId ?? "无"}**（共 ${commits.length} 次发布）`, "");
  for (const c of commits) {
    lines.push(`## ${c.commitId} — ${c.createdAt}`);
    lines.push(`- 说明：${c.reason}`);
    lines.push(`- 发布者：${c.operator} ｜ 父提交：${c.parentCommitId ?? "（首次发布）"}`);
    lines.push(`- 内容：${c.entries.length} 个文件 ｜ corpusHash：\`${c.corpusHash.slice(0, 16)}…\``);
    lines.push(`- 门禁：${c.gates ? `${c.gates.ok ? "通过" : "未通过"}（${c.gates.detail}，${c.gates.ranAt}）` : "未记录"}`);
    if (c.audit.length) lines.push(`- 审计：${c.audit.join("；")}`);
    lines.push(`- 文件：${c.entries.map((e) => `${e.rel}(${e.sha256.slice(0, 8)})`).join("、")}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** 未发布的残留（暂存区/未被指针引用的快照目录）：读者看不到，但要能查出来 */
export function listUnpublished(root: string): { staging: string[]; orphanSnapshots: string[] } {
  const p = paths(root);
  const staging = existsSync(p.staging) ? readdirSync(p.staging) : [];
  const published = new Set(existsSync(p.commits) ? readdirSync(p.commits).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : []);
  const orphanSnapshots = existsSync(p.snapshots) ? readdirSync(p.snapshots).filter((d) => !published.has(d)) : [];
  return { staging, orphanSnapshots };
}

/** 清理未发布残留（发布失败后的人工收尾；不动任何已发布内容） */
export function cleanupUnpublished(root: string, opts: { operator: string; reason: string }): { removed: string[]; audit: string } {
  const p = paths(root);
  const { staging, orphanSnapshots } = listUnpublished(root);
  const removed: string[] = [];
  for (const d of staging) { rmSync(join(p.staging, d), { recursive: true, force: true }); removed.push(`staging/${d}`); }
  for (const d of orphanSnapshots) { rmSync(join(p.snapshots, d), { recursive: true, force: true }); removed.push(`snapshots/${d}`); }
  const auditFile = join(p.root, "cleanup-audit.jsonl");
  const rec = { at: now(), operator: opts.operator, reason: opts.reason, removed };
  mkdirSync(p.root, { recursive: true });
  writeFileSync(auditFile, (existsSync(auditFile) ? readFileSync(auditFile, "utf8") : "") + JSON.stringify(rec) + "\n", "utf8");
  return { removed, audit: auditFile };
}

/** 供 CLI/测试使用：root 下的相对展示路径 */
export const relOf = (root: string, abs: string): string => toPosix(relative(resolve(root), resolve(abs)));
