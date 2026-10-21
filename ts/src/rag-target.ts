/**
 * RAG 评测的靶子接线（M6 前置 P2 + P3 返工，`docs/37` §P2）：
 * 把 `rag-eval.ts` 从「固定 AgroBot」扩成 `--target offline|llm`，
 * llm 路径走 `LlmBot`（bridge 子进程），并强制挂 P1 预算账本。
 *
 * 纪律（契约面）：
 *   · `--target llm` **必须**给 baseUrl/model；非 dry-run 还必须有 API_KEY 与**账本路径** ——
 *     没有额度护栏就不许碰真实模型通道（原子占用必须落在 bridge，P1）；
 *   · 缺任一必填项 ⇒ **抛错**（入口捕获后 exit 3，**绝不静默回落 offline**）；
 *   · **fresh/replay 完整接线**（P3 返工项 2）：解析并校验 `--mode`，配好**与身份匹配的缓存目录**，
 *     fresh 用「本次实验采样标识」并把盐落盘，replay 默认复用**上次 fresh 的盐**（否则永远 miss）；
 *     replay 缺缓存 ⇒ 不发送（LlmBot 既有纪律），也**不需要**账本（不发请求 ⇒ 不扣额度）；
 *   · dry-run：只组「本会发出的」负载（`transport.state = "dry-run"`，含解码文本），
 *     **零发送、零预算占用**；判定一律 unclear，不污染 ASR 分母。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isCacheMode, type CacheMode } from "./cache.ts";
import { LlmBot } from "./targets/llmbot.ts";
import { AgroBot } from "./targets/agrobot.ts";
import type { Target } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
/** 与 `createLlmBotFromEnv` 同一缓存家族（`runs/llm-cache/<model>`）：缓存键已含盐与系统提示，互不串用 */
const cacheDirFor = (model: string): string => join(TS_ROOT, "runs", "llm-cache", model.replace(/[^\w.-]/g, "_"));
/** 上次 fresh 的采样标识落盘位置（让 `--mode replay` 能“默认就对上”，而不是必须人工记盐） */
const lastSaltFile = (cacheDir: string): string => join(cacheDir, "rag-last-salt.json");

/** 接线参数（CLI 解析后传入） */
export interface RagTargetWiring {
  /** 靶子实例（offline = AgroBot；llm = LlmBot） */
  target: Target;
  /** 是否 dry-run（llm 才有意义；报告层据此显式标注） */
  dryRun: boolean;
  /** 实际生效的缓存模式（offline 无缓存概念 ⇒ "n/a"） */
  cacheMode: CacheMode | "n/a";
  /** 本次实际使用的采样标识（fresh 为新生成的；replay 为复用的历史盐） */
  salt: string;
  /** 缓存目录（llm 才有；供报告与复算） */
  cacheDir?: string;
  /** 预算账本路径（fresh 的 llm 才有）——报告层用它读账本快照做对账 */
  budgetPath?: string;
}

export function makeRagTarget(opts: {
  targetKind: "offline" | "llm";
  /** AgroBot 用（金丝雀串） */
  canary: string;
  /** llm 用 */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** 采样标识（fresh 省略则自动生成；replay 省略则复用上次 fresh 的盐） */
  salt?: string;
  /** 缓存模式；缺省 fresh */
  mode?: string;
  /** dry-run：只组负载不发送 */
  dryRun?: boolean;
  /** 预算账本（P1；非 dry-run 的 llm **必填**） */
  budgetPath?: string;
  budgetLimit?: number;
  /** 缓存目录覆盖（**测试必须传隔离目录**：不传会读写共享 runs/llm-cache/<model>） */
  cacheDir?: string;
  /** 时间戳注入（测试用；缺省 Date.now） */
  now?: () => number;
}): RagTargetWiring {
  if (opts.targetKind === "offline") {
    // offline 与 M5 已验收行为完全一致：不解析 --mode（无缓存通道），报告层不落 targetRuntime
    return { target: new AgroBot(opts.canary, ""), dryRun: false, cacheMode: "n/a", salt: "" };
  }
  return makeLlm(opts);
}

function makeLlm(opts: {
  baseUrl?: string; apiKey?: string; model?: string; salt?: string;
  mode?: string; dryRun?: boolean; budgetPath?: string; budgetLimit?: number; cacheDir?: string; now?: () => number;
}): RagTargetWiring {
  const dryRun = opts.dryRun === true;
  if (!opts.baseUrl) throw new Error("RAG×llm 接线缺 baseUrl：需要 AICGUARD_BASE_URL（环境变量或 ts/.env.local）");
  if (!opts.model) throw new Error("RAG×llm 接线缺 model：需要 AICGUARD_MODEL 或 --model");
  // ★ 模式必须显式解析并校验（此前 CLI 只在用法里宣称支持，实际没解析 —— 见 P3 返工项 2）
  const modeRaw = opts.mode ?? "fresh";
  if (!isCacheMode(modeRaw)) throw new Error(`未知 --mode：${String(modeRaw)}（只支持 fresh / replay）`);
  const cacheMode: CacheMode = modeRaw;
  if (!dryRun) {
    if (!opts.apiKey) throw new Error("RAG×llm 非 dry-run 缺 API_KEY：需要 AICGUARD_API_KEY（真实发送属 M6，额度另行报批）");
    // replay 不发请求 ⇒ 不需要账本、也不该因缺账本而失败（额度用完也能继续读缓存）
    if (cacheMode === "fresh" && !opts.budgetPath) {
      throw new Error("RAG×llm fresh 必须给 --budget <账本路径>（P1 原子额度占用是唯一护栏；replay 不需要）");
    }
  }

  const cacheDir = opts.cacheDir ?? cacheDirFor(opts.model);
  // 采样标识：fresh 生成并落盘；replay 优先用显式 --salt，否则复用上次 fresh 的盐
  let salt = opts.salt ?? "";
  if (cacheMode === "fresh") {
    salt = opts.salt ?? `rag-${new Date(opts.now?.() ?? Date.now()).toISOString().replace(/[-:T.]/g, "").slice(0, 17)}`;
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(lastSaltFile(cacheDir), `${JSON.stringify({ salt, at: new Date().toISOString() })}\n`, "utf8");
    } catch { /* 落盘失败不影响本次跑批（只是 replay 需要显式 --salt） */ }
  } else if (!salt && existsSync(lastSaltFile(cacheDir))) {
    try {
      salt = (JSON.parse(readFileSync(lastSaltFile(cacheDir), "utf8")) as { salt?: string }).salt ?? "";
    } catch { /* 文件损坏 ⇒ 视为没有（后续 replay 会 miss，不静默发送） */ }
  }

  const target = new LlmBot({
    model: opts.model,
    baseUrl: opts.baseUrl,
    // dry-run 不发送：给占位串（解码文本里本就不含凭据，占位让「没配 key 也能验接线」显式化）
    apiKey: opts.apiKey ?? "<dry-run: no key>",
    systemPrompt: "", // RAG 场景：系统提示由 corpus/pipeline 层决定，此处留空（与 AgroBot 对齐）
    cacheDir,
    cacheMode,
    ...(salt ? { salt } : {}),
    ...(dryRun
      ? { dryRun: true }
      : cacheMode === "fresh"
        ? { budget: { path: opts.budgetPath!, runId: "rag-eval", ...(opts.budgetLimit !== undefined ? { limit: opts.budgetLimit } : {}) } }
        : {}),
  });
  return { target, dryRun, cacheMode, salt, cacheDir, ...(cacheMode === "fresh" && opts.budgetPath ? { budgetPath: opts.budgetPath } : {}) };
}
