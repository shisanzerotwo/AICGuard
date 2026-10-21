/**
 * Run 元信息（M2-2）：让"这份报告是哪份代码、哪份语料、哪版护栏与判据、哪个模型、什么参数"可追溯。
 *
 * 依据 docs/15 §2.3：每个 run 保存
 *   代码 SHA、语料哈希、护栏与判据版本、模型身份、采样参数、请求/缓存计数和逐条证据；
 *   **不保存认证头或密钥**。
 *
 * 为什么必须落盘：没有这些字段时，"旧结果能不能与新结果并列比较""能不能直接重判"
 * 都只能靠人回忆；有了之后，报告本身就能回答来源问题（也让 M2-4 的历史重判有据可依）。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { CacheMode } from "./cache.ts";
import { resolveDataRoot } from "./data-root.ts";
import { RAG_CONFIG } from "./rag.ts";
import type { Target } from "./types.ts";

export interface CorpusFileInfo {
  file: string;
  sha256: string;
  /** 非空行数（含注释行） */
  lines: number;
}

export interface RunVersions {
  /** 代码快照：git HEAD；取不到时为 "(unknown)" */
  codeSha: string;
  /** 工作区是否有未提交改动（脏树跑出的结果必须能被识别出来） */
  codeDirty: boolean;
  /** 语料整体哈希：逐文件 sha256 按文件名排序拼接后再哈希 */
  corpusHash: string;
  corpusFiles: CorpusFileInfo[];
  /**
   * 语料来源的**不可变快照提交**（M3-4）。
   * 未启用快照（读工作区 data/）时为 undefined —— 引用数字时必须说清是
   * “快照提交 X”还是“工作区当前内容”。
   */
  snapshotCommitId?: string;
  /** 护栏组合指纹（档位定义 + 注册表组件名） */
  guardVersion: string;
  /** 判据版本（judge 语义版本号 + 推荐语境词表指纹） */
  judgeVersion: string;
  /** agent 通道的工具契约版本 */
  toolContractVersion: string;
  /** 缓存键版本（升级即旧条目失效） */
  cacheKeyVersion: number;
}

/** 目标运行信息：只含非敏感身份与计数（**绝不含 apiKey / Authorization**） */
export interface TargetRuntimeInfo {
  kind: "offline" | "llm" | "agent" | "unknown";
  /** 目标展示名 */
  name: string;
  model?: string;
  /** 规范化端点（不含查询串与密钥） */
  endpoint?: string;
  salt?: string;
  temperature?: number;
  maxTokens?: number;
  cacheMode?: CacheMode;
  toolContractVersion?: string;
  requests?: number;
  /**
   * **底层 HTTP 尝试次数**（P1）：一次 spawn 最多 3 次尝试（429/5xx 退避重试）。
   * 与 `requests`（spawn 次数）**不是一个口径**；额度账本记的是本字段。
   */
  httpAttempts?: number;
  cacheHits?: number;
  errors?: number;
  /**
   * dry-run（P2）：true ⇒ 该目标**从未**发出真实请求（只组脱敏负载）。
   * 报告/控制台必须把它显式标出，防止"零发送"被误读成"已实测"。
   */
  dryRun?: boolean;
}

/** 一次 git 查询（失败不抛错：报告生成不应因为拿不到 git 信息而失败） */
function git(args: string[], cwd: string): string | null {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

/** 代码信息：SHA + 是否脏树（脏树跑出的报告不能与干净树的结果混为一谈） */
export function collectCodeInfo(repoRoot: string): { codeSha: string; codeDirty: boolean } {
  const sha = git(["rev-parse", "HEAD"], repoRoot);
  const status = git(["status", "--porcelain"], repoRoot);
  return {
    codeSha: sha ?? "(unknown)",
    codeDirty: status === null ? true : status.length > 0,
  };
}

/** 语料哈希：逐文件 sha256（按文件名排序）+ 整体哈希 */
export function hashCorpus(dataDir: string, files?: string[]): { corpusHash: string; corpusFiles: CorpusFileInfo[] } {
  const names = (files ?? readdirSync(dataDir).filter((f) => f.endsWith(".jsonl"))).slice().sort();
  const corpusFiles: CorpusFileInfo[] = [];
  for (const file of names) {
    const p = join(dataDir, file);
    const buf = readFileSync(p);
    corpusFiles.push({
      file,
      sha256: createHash("sha256").update(buf).digest("hex"),
      lines: buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim().length > 0).length,
    });
  }
  const corpusHash = createHash("sha256")
    .update(corpusFiles.map((f) => `${f.file}:${f.sha256}`).join("\n"))
    .digest("hex");
  return { corpusHash, corpusFiles };
}

/** 从 Target 取运行信息（靶子未实现 describe 时给最小占位，不编造身份） */
export function targetRuntimeInfo(target: Target): TargetRuntimeInfo {
  const d = typeof target.describe === "function" ? target.describe() : undefined;
  return d ?? { kind: "unknown", name: target.name };
}

/** 组装完整版本块（run.ts / agent-eval / 多采样脚本共用） */
export function collectRunVersions(opts: {
  repoRoot: string;
  dataDir: string;
  guardVersion: string;
  judgeVersion: string;
  toolContractVersion: string;
  cacheKeyVersion: number;
  /** M3-4：语料来自哪个不可变快照提交（走工作区时为 undefined） */
  snapshotCommitId?: string;
}): RunVersions {
  const { codeSha, codeDirty } = collectCodeInfo(opts.repoRoot);
  const { corpusHash, corpusFiles } = hashCorpus(opts.dataDir);
  return {
    codeSha,
    codeDirty,
    corpusHash,
    corpusFiles,
    guardVersion: opts.guardVersion,
    judgeVersion: opts.judgeVersion,
    toolContractVersion: opts.toolContractVersion,
    cacheKeyVersion: opts.cacheKeyVersion,
    ...(opts.snapshotCommitId ? { snapshotCommitId: opts.snapshotCommitId } : {}),
  };
}

// ============================================================ RAG 元信息（M5-5）
//
// 依据 docs/15 §4.1："配置及文档快照进入 run 元信息"。三件事必须可追溯：
//   ① **检索配置**（400/50/stride/topK/1000 + 归一化口径名）——跑的时候用的是哪套配置，不能靠报告作者回忆；
//   ② **文档快照哈希**——逐文件 sha256（文档变了哈希必须变）；
//   ③ **文档来源三态**，与 M3-4 的语料三态同纪律：显式 > 快照 > 工作区，且**拒绝静默回落**。

export type RagDocSource = "explicit" | "snapshot" | "worktree";

export interface RagDocInfo {
  file: string;
  sha256: string;
  /** 文档字符数（按码点计；文档是自由文本，行数没有语料那么有意义） */
  chars: number;
}

export interface RagMeta {
  config: {
    chunkChars: number;
    overlapChars: number;
    stride: number;
    topK: number;
    contextChars: number;
    /** 计分口径名：字符二元组**多重集交集**（见 rag.ts）；改口径必须改这个名字 */
    normalizer: string;
  };
  docsDir: string;
  source: RagDocSource;
  /** 读快照时固定到的提交；工作区来源时为 undefined（**不编造**） */
  snapshotCommitId?: string;
  docHash: string;
  docFiles: RagDocInfo[];
}

/** 文档哈希：只收 `.md`（按文件名排序）→ 逐文件 sha256 → 整体哈希 */
export function hashRagDocs(docsDir: string, files?: string[]): { docHash: string; docFiles: RagDocInfo[] } {
  const names = (files ?? readdirSync(docsDir).filter((f) => f.endsWith(".md"))).slice().sort();
  const docFiles: RagDocInfo[] = [];
  for (const file of names) {
    const buf = readFileSync(join(docsDir, file));
    docFiles.push({
      file,
      sha256: createHash("sha256").update(buf).digest("hex"),
      chars: Array.from(buf.toString("utf8")).length,
    });
  }
  const docHash = createHash("sha256").update(docFiles.map((f) => `${f.file}:${f.sha256}`).join("\n")).digest("hex");
  return { docHash, docFiles };
}

/**
 * 解析 RAG 文档根目录（三态，纪律同 M3-4 的 `resolveDataRoot`）：
 *   `AICGUARD_RAG_DOCS_DIR`（显式） > `AICGUARD_SNAPSHOT_ROOT` 对应提交里的 `docs/` > 调用方给的默认根。
 * **拒绝静默回落**：显式目录不存在、或快照里没有 `docs/`，一律抛错 —— 否则"以为读了快照、实际读了工作区"。
 */
export function resolveRagDocs(opts: {
  repoRoot: string;
  /** 第三态（工作区）用的默认文档根，通常是 `<repo>/materials` */
  defaultDocsDir: string;
  env?: NodeJS.ProcessEnv;
}): { dir: string; source: RagDocSource; snapshotCommitId?: string } {
  const env = opts.env ?? process.env;
  const explicit = env.AICGUARD_RAG_DOCS_DIR;
  if (explicit) {
    const dir = isAbsolute(explicit) ? explicit : resolve(opts.repoRoot, explicit);
    if (!existsSync(dir)) {
      throw new Error(`AICGUARD_RAG_DOCS_DIR 指向的目录不存在：${dir}（拒绝静默回落到工作区文档）`);
    }
    return { dir, source: "explicit" };
  }
  if (env.AICGUARD_SNAPSHOT_ROOT) {
    // 复用 M3-4 的统一入口拿到"固定到哪个提交"，错误信息也共用
    const dataRoot = resolveDataRoot({ repoRoot: opts.repoRoot, env });
    const docsDir = join(dirname(dataRoot.dir), "docs");
    if (!existsSync(docsDir)) {
      throw new Error(
        `快照提交 ${dataRoot.commitId} 里没有 docs/ 目录：${docsDir}` +
        "（拒绝静默回落到工作区文档 —— 否则报告会声称读了快照、实际读的是当前内容）",
      );
    }
    return { dir: docsDir, source: "snapshot", snapshotCommitId: dataRoot.commitId };
  }
  return { dir: opts.defaultDocsDir, source: "worktree" };
}

/** 组装 RAG 元信息块（供 run 报告写入；不含任何密钥/认证信息） */
export function collectRagMeta(opts: {
  docsDir: string;
  source: RagDocSource;
  snapshotCommitId?: string;
}): RagMeta {
  const { docHash, docFiles } = hashRagDocs(opts.docsDir);
  return {
    // **派生自 `RAG_CONFIG`**（单一真相）：元信息里的配置必须就是检索器真正用的那套，
    // 否则"报告说 400/50、实际跑 512/64"这种漂移没人能发现。值本身的冻结由 rag-retrieval.test.ts 把关。
    config: {
      chunkChars: RAG_CONFIG.chunkChars,
      overlapChars: RAG_CONFIG.overlapChars,
      stride: RAG_CONFIG.stride,
      topK: RAG_CONFIG.topK,
      contextChars: RAG_CONFIG.contextChars,
      normalizer: "bigram-multiset-v1",
    },
    docsDir: opts.docsDir,
    source: opts.source,
    ...(opts.snapshotCommitId ? { snapshotCommitId: opts.snapshotCommitId } : {}),
    docHash,
    docFiles,
  };
}
