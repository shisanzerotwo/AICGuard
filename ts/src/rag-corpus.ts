/**
 * RAG 文档装载（M5-6，`docs/31` §2 D2；M6 例外见 `docs/43` G-RAG-1）。
 *
 * 三条**由代码保证**的纪律（不靠"我们会记得"）：
 *   ① 开发侧文档**绝不来自 `holdout/`** —— 留出集在 M5 只读不用（D3）；
 *   ② 跑留出集属 M6：必须**同时**给「显式开关」与「非空声明」，且逐文件用 `holdout/MANIFEST.json`
 *      的 sha256 核验（跑的是**冻结字节**，不是被改过的副本）；
 *   ③ 给了**显式清单**就逐文件校验：缺一篇 ⇒ 抛错，不许悄悄少读。
 *
 * 文档来源三态复用 M3-4 的 `resolveRagDocs`（显式 > 快照 > 工作区，且拒绝静默回落）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { chunkDocument, type RagChunk } from "./rag.ts";
import { collectRagMeta, type RagDocSource, type RagMeta } from "./runmeta.ts";

/** 留出集显式放行（G-RAG-1，`docs/43`）：**开关 + 非空声明**两件套，缺一不可 */
export interface HoldoutAllow {
  allowHoldout: boolean;
  /** 写清本次为何要跑留出集（M6 期望表里的那句话） */
  declaration?: string;
}

/** 判定目录是否落在 `<repoRoot>/holdout` 之内 */
function insideHoldout(docsDir: string, repoRoot: string): boolean {
  const holdout = resolve(repoRoot, "holdout");
  const dir = resolve(docsDir);
  const rel = relative(holdout, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 硬守卫：文档目录落在 `<repoRoot>/holdout` 之内时——
 *   · 没给 `allowHoldout` ⇒ 抛错（D2：M5 只读不用）；
 *   · 给了开关但**声明为空** ⇒ 抛错（M6 的例外是"**显式声明**"，不是"随手加个开关"）。
 * 不在 holdout 内 ⇒ 直接返回（既有行为不变）。
 */
export function assertDocsNotFromHoldout(
  docsDir: string,
  repoRoot: string,
  opts: Partial<HoldoutAllow> = {},
): void {
  if (!insideHoldout(docsDir, repoRoot)) return;
  const dir = resolve(docsDir);
  if (!opts.allowHoldout) {
    throw new Error(
      `RAG 开发文档不得来自 holdout/：${dir}（D2：留出集在 M5 只读不用；` +
      `要跑留出集属 M6，必须显式声明：--allow-holdout 且同时给 --holdout-declaration "<本次为何跑留出集>"）`,
    );
  }
  if (!opts.declaration || !opts.declaration.trim()) {
    throw new Error(
      `跑留出集必须同时给出**非空声明**（--holdout-declaration）：${dir}——只有开关没有声明一律拒绝`,
    );
  }
}

/**
 * 用 `holdout/MANIFEST.json` 的 sha256 逐文件核验（G-RAG-1）：
 * 文件未登记 / 哈希不符 ⇒ 抛错。**这是"跑的是冻结字节"的自证**，不是形式主义：
 * 缺了它，"显式开关"就退化成"随便指一个被改过的目录也能跑"。
 */
export function verifyHoldoutFiles(docsDir: string, repoRoot: string, files: readonly string[]): { checked: number } {
  const holdoutRoot = resolve(repoRoot, "holdout");
  const manifestPath = join(holdoutRoot, "MANIFEST.json");
  if (!existsSync(manifestPath)) throw new Error(`留出集核验失败：找不到 ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    files?: Array<{ path?: string; sha256?: string }>;
  };
  const byPath = new Map<string, { sha256?: string }>();
  for (const e of manifest.files ?? []) {
    if (typeof e?.path === "string") byPath.set(e.path.replace(/\\/g, "/"), e);
  }
  let checked = 0;
  for (const f of files) {
    const abs = join(resolve(docsDir), f);
    const key = relative(holdoutRoot, abs).replace(/\\/g, "/");
    const entry = byPath.get(key);
    if (!entry || !entry.sha256) {
      throw new Error(`留出集核验失败：${key} 不在 MANIFEST.files 里（拒绝跑未登记文件）`);
    }
    const got = createHash("sha256").update(readFileSync(abs)).digest("hex");
    if (got !== entry.sha256) {
      throw new Error(
        `留出集核验失败：${key} 哈希不符（MANIFEST ${entry.sha256.slice(0, 12)}… vs 实际 ${got.slice(0, 12)}…）` +
        "——拒绝用被改动过的留出集跑批",
      );
    }
    checked++;
  }
  return { checked };
}

export interface LoadedRagDocs {
  meta: RagMeta;
  chunks: RagChunk[];
  /** 仅当本次**显式放行**了留出集目录时出现（供报告落盘，证明确实声明并核验过） */
  holdout?: { explicit: true; declaration: string; manifestChecked: number };
}

/**
 * 装载文档并切块。
 * `files` 给了就**只读这些**（缺一个即报错）；没给则枚举目录内 `.md`（**仅限显式传入的目录**，
 * 不做任何跨目录自动发现）。
 */
export function loadRagDocs(opts: {
  repoRoot: string;
  docsDir: string;
  files?: string[];
  source?: RagDocSource;
  snapshotCommitId?: string;
  /** G-RAG-1：留出集显式放行（开关 + 声明）；不给 ⇒ 落在 holdout 内一律抛错 */
  holdout?: Partial<HoldoutAllow>;
}): LoadedRagDocs {
  assertDocsNotFromHoldout(opts.docsDir, opts.repoRoot, opts.holdout ?? {});
  const files = opts.files
    ?? readdirSync(opts.docsDir).filter((f) => f.endsWith(".md")).slice().sort();
  const missing = files.filter((f) => !existsSync(join(opts.docsDir, f)));
  if (missing.length) {
    throw new Error(`显式清单里的文档不存在：${missing.join("、")}（拒绝静默少读一篇）`);
  }
  const chunks = files.flatMap((f) => chunkDocument(f, readFileSync(join(opts.docsDir, f), "utf8")));
  const meta = collectRagMeta({
    docsDir: opts.docsDir,
    source: opts.source ?? "worktree",
    snapshotCommitId: opts.snapshotCommitId,
  });
  const inHoldout = insideHoldout(opts.docsDir, opts.repoRoot);
  if (!inHoldout) return { meta, chunks };
  // 走到这里 ⇒ 已通过"开关 + 声明"检查；继续做冻结字节核验，并把事实落在返回值里
  const { checked } = verifyHoldoutFiles(opts.docsDir, opts.repoRoot, files);
  return {
    meta, chunks,
    holdout: { explicit: true, declaration: (opts.holdout?.declaration ?? "").trim(), manifestChecked: checked },
  };
}
