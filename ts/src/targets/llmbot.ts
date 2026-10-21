/**
 * 靶子应用 LlmBot —— 真实大模型（OpenAI 兼容 /chat/completions 接口）。
 *
 * 为什么接真实模型：离线 AgroBot 靶子证明了评测引擎与防御流水线可用，
 * 但"规则挡不挡得住真实模型"必须用真实模型验证（docs/01 里程碑 M0b）。
 *
 * 同步与异步的边界：评测引擎 / Pipeline / 判分器全部是同步签名，而 HTTP
 * 天然异步。这里用 spawnSync 调 llm-bridge.mjs（独立子进程做 fetch 与
 * 退避重试），让同步世界零改动。进程开销 ~50ms/次，远小于 API 延迟。
 *
 * 成本控制（docs/01 §11）：
 *   - **落盘缓存**：相同 (模型, 系统提示, messages) 的回复缓存到本地，
 *     开发调试期不重复付费，中断续跑也不重复计费（§11.2 / §5.3 断点续跑）。
 *   - **用量统计**：requests / cacheHits / tokens 累计，跑批后汇报真实用量，
 *     供 M0 成本标定外推（§11.1）。
 *
 * 密钥管理：key 不写进任何源码文件。从环境变量或 ts/.env.local 读取
 * （AICGUARD_API_KEY / AICGUARD_BASE_URL / AICGUARD_MODEL）。
 */

import { spawnSync } from "node:child_process";
import { DEFAULT_BUDGET_PATH } from "../budget.ts";
import { normalizeBridgeUsage } from "../usage.ts";
import { cacheKey, isCacheMode, normalizeEndpoint, replayMissError, type CacheMode } from "../cache.ts";
import type { TargetRuntimeInfo } from "../runmeta.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChatMessage, Target, TargetResponse, UsageSource } from "../types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = join(HERE, "..", "..");
/**
 * 传输桥路径。
 *
 * `AICGUARD_BRIDGE` 是**离线测试缝**：指向替身脚本即可捕获「最终发给模型的请求正文」，
 * 用于断言多轮历史的 role / content / 顺序 / 数量（M1-4 验收：审查 R2 的回归防线）。
 * 不设该变量时用真实桥，生产行为与之前完全一致。
 *
 * 为什么写成函数而不是模块级常量：模块级常量会在 import 时被钉死，而测试必须在
 * import 之前设值——但任何静态导入链（例如 agentbot → llmbot）都可能在测试体执行前
 * 就把它加载了。**调用时解析**让测试缝不依赖加载顺序。
 */
const bridgePath = (): string => process.env.AICGUARD_BRIDGE || join(HERE, "llm-bridge.mjs");

/** 解析 ts/.env.local（KEY=VALUE，# 注释）；调用方须保证真实环境变量优先 */
export function loadLocalEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = join(TS_ROOT, ".env.local");
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export interface LlmBotOptions {
  model: string;
  baseUrl: string;
  apiKey: string;
  systemPrompt: string;
  /** 回复缓存目录；为空则不缓存 */
  cacheDir?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  /**
   * 缓存键盐：同一批请求想强制绕开旧缓存（如榜单抽样审计要测模型随机性）
   * 时给不同的盐即可，互不串缓存。fresh 模式下它就是"本次实验的独立采样标识"。
   */
  salt?: string;
  /**
   * 缓存模式（M2-1）：fresh = 允许发请求（默认）；replay = 只读缓存，缺失即失败（不联网）。
   * 未指定时读环境变量 AICGUARD_CACHE_MODE，仍缺省为 fresh。
   */
  cacheMode?: CacheMode;
  /**
   * 预算账本（P1，`docs/15` §5.2）：给定时，**每次底层 HTTP 尝试前**由 bridge 原子占用 1 次额度，
   * 不足即**不发请求**。口径是 HTTP 尝试次数（一次 spawn 最多 3 次尝试），不是 spawn 次数。
   */
  budget?: { path: string; runId: string; limit?: number };
  /**
   * dry-run（P2 接线验证）：`respond()` 只组"本会发出的"桥侧负载（**脱敏**进 `transportBody`），
   * **不 spawn、不联网、不碰预算账本与缓存**，返回带标记的 `error`（判定一律 unclear，不污染 ASR 分母）。
   * 真发属 M6（额度另行报批）。
   */
  dryRun?: boolean;
}

/**
 * 从环境变量 / ts/.env.local 构造 LlmBot 的工厂。run.ts 与
 * scripts/llm-leaderboard.ts 共用，避免「env 合并→校验→拼 cacheDir」散落多处。
 * 缺配置时抛错，调用方决定怎么向用户报告。
 */
export function createLlmBotFromEnv(
  systemPrompt: string,
  opts?: { model?: string; salt?: string; cacheMode?: CacheMode; budget?: { path: string; runId: string; limit?: number } },
): LlmBot {
  const env = { ...loadLocalEnv(), ...process.env };
  const baseUrl = env.AICGUARD_BASE_URL ?? "";
  const apiKey = env.AICGUARD_API_KEY ?? "";
  const model = opts?.model || env.AICGUARD_MODEL || "";
  if (!apiKey || !baseUrl || !model) {
    throw new Error("LLM 靶子缺配置：需要 AICGUARD_API_KEY / AICGUARD_BASE_URL / AICGUARD_MODEL"
      + "（环境变量或 ts/.env.local），或用 --model 指定模型名。");
  }
  // 缓存模式：显式参数 > 环境变量 > fresh。非法值直接报错，不静默降级（降到 fresh 会意外烧钱）
  const modeRaw = opts?.cacheMode ?? env.AICGUARD_CACHE_MODE ?? "fresh";
  if (!isCacheMode(modeRaw)) {
    throw new Error(`未知缓存模式：${String(modeRaw)}（只支持 fresh / replay）`);
  }
  return new LlmBot({
    model, baseUrl, apiKey, systemPrompt,
    // 缓存目录：`createLlmBotFromEnv` 是各入口共用工厂，故预算也从环境解析（默认 runs/budget.json，200）
    cacheDir: join(TS_ROOT, "runs", "llm-cache", model.replace(/[^\w.-]/g, "_")),
    ...(opts?.salt ? { salt: opts.salt } : {}),
    cacheMode: modeRaw,
    // replay 不发请求 ⇒ 不需要额度（也不应因缺账本而失败）
    ...(modeRaw === "fresh" ? { budget: opts?.budget ?? budgetFromEnv() } : {}),
  });
}

/**
 * 从环境解析预算账本（相对路径按 `ts/` 解析，与三态环境变量同一纪律）。
 * 默认 `ts/runs/budget.json` + 上限 200 —— 即 `docs/15` §5.2 的“所有入口共享一个额度池”。
 * P3 起导出：`agent-eval` 的 real 模式与 LlmBot 共用同一解析口径（CLI 参数只收紧覆盖）。
 */
export function budgetFromEnv(): { path: string; runId: string; limit?: number } {
  const env = { ...loadLocalEnv(), ...process.env };
  const chat = env.AICGUARD_BUDGET?.trim();
  const path = chat ? (isAbsolute(chat) ? chat : join(TS_ROOT, chat)) : join(TS_ROOT, DEFAULT_BUDGET_PATH);
  const rawLimit = env.AICGUARD_BUDGET_LIMIT?.trim();
  const limit = rawLimit ? Number(rawLimit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`AICGUARD_BUDGET_LIMIT 必须是正整数，收到 ${rawLimit}`);
  }
  return { path, runId: env.AICGUARD_BUDGET_RUN?.trim() || "default", ...(limit !== undefined ? { limit } : {}) };
}

export class LlmBot implements Target {
  readonly name: string;
  private model: string;
  private baseUrl: string;
  private apiKey: string;
  private systemPrompt: string;
  private cacheDir: string;
  private timeoutMs: number;
  private maxTokens: number;
  private temperature: number;
  private salt: string;
  /** 缓存模式（M2-1）：replay 时缓存缺失一律失败，不联网 */
  private cacheMode: CacheMode;
  /** 预算账本（P1）：非空时，bridge 每次 HTTP 尝试前原子占用 1 次额度 */
  private budget: { path: string; runId: string; limit?: number } | null;
  /** dry-run（P2）：只组负载不发请求（不 spawn、不碰预算/缓存） */
  private dryRun: boolean;
  /** 用量统计（不含缓存命中），供成本标定外推 */
  requests = 0;
  /** **真实 HTTP 尝试次数**（一次 spawn 最多 3 次尝试）；口径与账本一致，`requests` 数的是 spawn */
  httpAttempts = 0;
  cacheHits = 0;
  errors = 0;
  promptTokens = 0;
  completionTokens = 0;

  constructor(opts: LlmBotOptions) {
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.systemPrompt = opts.systemPrompt;
    this.cacheDir = opts.cacheDir ?? "";
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxTokens = opts.maxTokens ?? 500;
    this.temperature = opts.temperature ?? 0.7;
    this.salt = opts.salt ?? "";
    this.cacheMode = opts.cacheMode ?? "fresh";
    this.budget = opts.budget ?? null;
    this.dryRun = opts.dryRun ?? false;
    this.name = `LLM(${opts.model})`;
    if (this.cacheDir) mkdirSync(this.cacheDir, { recursive: true });
  }

  /** 网关地址（报告展示用） */
  get endpoint(): string { return this.baseUrl; }

  /** 运行信息（M2-2）：模型身份 + 规范化端点 + 采样参数 + 请求/缓存计数（**不含密钥**） */
  describe(): TargetRuntimeInfo {
    return {
      kind: "llm",
      name: this.name,
      ...(this.dryRun ? { dryRun: true } : {}),
      model: this.model,
      endpoint: normalizeEndpoint(this.baseUrl),
      ...(this.salt ? { salt: this.salt } : {}),
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      cacheMode: this.cacheMode,
      requests: this.requests,
      httpAttempts: this.httpAttempts,
      cacheHits: this.cacheHits,
      errors: this.errors,
    };
  }

  /**
   * 组桥侧请求负载（**单一构造点**）：真实发送与 dry-run 预览共用同一构造，
   * 避免"预览说一套、实际发另一套"。
   */
  private bridgePayload(messages: ChatMessage[]): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      system: this.systemPrompt,
      messages,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      timeoutMs: this.timeoutMs,
      ...(this.budget
        ? { budget: { path: this.budget.path, runId: this.budget.runId, source: "llm", ...(this.budget.limit !== undefined ? { limit: this.budget.limit } : {}) } }
        : {}),
    };
  }

  /**
   * 预览用文本：从**同一份桥侧负载数据**解码（系统提示 + 各消息内容）。
   * 只用于 dry-run 的接线展示：它不包含 apiKey（那是 header/负载字段，不在文本内容里）。
   */
  private decodedOf(messages: ChatMessage[]): string {
    return [this.systemPrompt, ...messages.map((m) => m.content)].filter((s) => s !== "").join("\n");
  }

  respond(prompt: string, history?: ChatMessage[]): TargetResponse {
    const t0 = performance.now();
    const messages: ChatMessage[] = [];
    // 历史按角色原样透传（审查 R2：旧实现把每个 [role, content] 二元组当作
    // 「(用户问题, 助手回复)」展开，导致角色错位且消息数翻倍）。
    for (const m of history ?? []) messages.push({ role: m.role, content: m.content });
    messages.push({ role: "user", content: prompt });

    // dry-run（P2 接线验证）：只组负载，不发、不碰预算/缓存；
    // `state="dry-run"` 使得**送达判据一律不算送达**（一个字节都没发）。
    if (this.dryRun) {
      return {
        text: "",
        latencyMs: performance.now() - t0,
        error: "dry-run：未发送真实请求（接线验证；真发属 M6，额度另行报批）",
        transport: {
          state: "dry-run", requestSha256: "", requestBytes: 0, attemptId: "",
          decodedText: this.decodedOf(messages),
        },
      };
    }

    // 缓存键（v2）：版本 + 盐 + 模型 + **规范化端点** + 采样参数 + 系统提示 + 全部 messages。
    // 任一项变化即失效 ⇒ 换模型/换网关/改参数都不会串结果（审查 R3）。
    const key = cacheKey({
      salt: this.salt, model: this.model, endpoint: this.baseUrl,
      systemPrompt: this.systemPrompt, messages,
      temperature: this.temperature, maxTokens: this.maxTokens,
    });
    if (this.cacheDir) {
      const p = join(this.cacheDir, `${key}.json`);
      if (existsSync(p)) {
        try {
          this.cacheHits++;
          const hit = JSON.parse(readFileSync(p, "utf8")) as TargetResponse;
          // 缓存命中没有产生新 API 消耗：本次动作的用量增量记 0（口径见 types.TokenUsage）。
          // 送达证据：本次未发请求 ⇒ 标 `cache-replay`（证据来自历史请求，不得冒充本次实际发出）。
          return {
            ...hit,
            latencyMs: performance.now() - t0,
            ...(hit.transport
              ? { transport: { ...hit.transport, state: "cache-replay" as const, fromCache: true } }
              : {}),
            usage: { requests: 0, promptTokens: 0, completionTokens: 0 },
            usageSource: "none",
            usageLowerBound: undefined,
          };
        } catch { /* 缓存损坏视为未命中 */ }
      }
    }

    // replay：只读缓存——缺失不得偷偷联网（docs/15 §2.3）；也不需预算（不发请求）
    if (this.cacheMode === "replay") {
      this.errors++;
      return { text: "", latencyMs: performance.now() - t0, error: replayMissError(key) };
    }

    // ★ 发送前硬前置（P3 返工）：fresh 真实发送**必须**挂额度账本；没挂就拒绝发送。
    //   为什么要在靶子层也要拦一道：桥侧只能管“自己有账本时”的纪律，而“忘了传账本”这种
    //   绕过大体发生在调用方（实测：workloop-eval 裸调 createAgentBridgeCall()）。
    if (!this.budget) {
      this.errors++;
      return {
        text: "", latencyMs: performance.now() - t0,
        error: "budget_missing: fresh 真实发送必须挂额度账本（未提供预算配置）—— 已在发送前拒绝",
        budgetExhausted: true,
        budgetStopReason: "missing",
        transport: { state: "refused", requestSha256: "", requestBytes: 0, attemptId: "", decodedText: "" },
      };
    }

    const req0 = this.requests, pTok0 = this.promptTokens, cTok0 = this.completionTokens;
    // 第四轮 R3 返工：桥回报的**尝试计数**是协议事实，必须原样往上传（老/兼容桥可能不报 request）
    let reportedAttempts: number | undefined;
    this.requests++;
    const r = spawnSync(process.execPath, [bridgePath()], {
      input: JSON.stringify(this.bridgePayload(messages)),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: this.timeoutMs * 4 + 30_000, // 覆盖 3 次重试 + 退避的总和
    });
    let text = "";
    let error = "";
    let budgetExhausted = false;
    let budgetStopReason: string | undefined;
    let transport: TargetResponse["transport"];
    let usageSource: UsageSource = "unknown";
    let usageLowerBound: TargetResponse["usageLowerBound"];
    // ★ 传输层失败必须如实上报（Codex 复核项 1）：`spawnSync` 的 error（如 bridge 路径不存在 ENOENT）、
    //   非零退出、被信号终止、空 stdout —— **都不是"正常空响应"**。实测复现过：桥路径写错时
    //   原先会 `JSON.parse("{}")` 成功、error 为空 ⇒ 下游 `runSingle` 记 status=ok/verdict=fail
    //   ⇒ **"桥坏了"被读成"没被攻破"（防御成绩虚高）**。
    const transportFailure = ((): string => {
      if (r.error) return `bridge 启动失败：${(r.error as Error).message ?? String(r.error)}`;
      if (r.signal) return `bridge 被信号终止：${r.signal}`;
      if (typeof r.status === "number" && r.status !== 0) {
        return `bridge 退出码 ${r.status}：${(r.stderr ?? "").toString().trim().slice(0, 200) || "（无 stderr）"}`;
      }
      if (r.status === null) return "bridge 未产生退出码（被信号/异常中断）";
      if (!r.stdout || r.stdout.trim() === "") return "bridge 无输出（stdout 为空）";
      return "";
    })();
    try {
      if (transportFailure) throw new Error(transportFailure);
      const out = JSON.parse(r.stdout || "{}") as {
        text?: string; error?: string;
        usage?: unknown; usageLowerBound?: unknown; usageSource?: unknown;
        attempts?: number; budgetExhausted?: boolean; budgetStop?: string | null;
        request?: { state?: string; sha256?: string; bytes?: number; attemptId?: string; decodedText?: string };
        attemptsLog?: Array<{ n?: number; outcome?: string; attemptId?: string; sha256?: string; bytes?: number; decodedText?: string; responseError?: string; responseErrorKind?: import("../types.ts").ResponseErrorKind }>;
      };
      text = out.text ?? "";
      error = out.error ?? "";
      // 口径对账：attempts = 真实 HTTP 尝试次数（含重试），与账本一致；requests = spawn 次数
      if (typeof out.attempts === "number") reportedAttempts = out.attempts;
      this.httpAttempts += out.attempts ?? 0;
      budgetExhausted = out.budgetExhausted === true;
      if (typeof out.budgetStop === "string" && out.budgetStop !== "") budgetStopReason = out.budgetStop;
      // 送达证据：**只认桥在 fetch 构造点报回的 request**（IPC 包装不是 HTTP 正文）。
      if (out.request && typeof out.request.state === "string") {
        const st = out.request.state;
        const state = (st === "submitted" || st === "unknown-after-submit" || st === "not-connecting"
          || st === "refused" || st === "dry-run" ? st : "not-connecting") as NonNullable<TargetResponse["transport"]>["state"];
        transport = {
          state,
          requestSha256: out.request.sha256 ?? "",
          requestBytes: out.request.bytes ?? 0,
          attemptId: out.request.attemptId ?? "",
          decodedText: out.request.decodedText ?? "",
          ...(Array.isArray(out.attemptsLog)
            ? { attempts: out.attemptsLog.map((a) => ({
              n: a.n ?? 0,
              outcome: (a.outcome ?? "not-connecting") as NonNullable<TargetResponse["transport"]>["state"],
              attemptId: a.attemptId ?? "",
              requestSha256: a.sha256 ?? "",
              requestBytes: a.bytes ?? 0,
              ...(typeof a.decodedText === "string" ? { decodedText: a.decodedText } : {}),
              ...(a.responseError ? { responseError: a.responseError } : {}),
              ...(a.responseErrorKind ? { responseErrorKind: a.responseErrorKind } : {}),
            })) }
            : {}),
        };
      }
      const facts = normalizeBridgeUsage(out, transport);
      usageSource = facts.source;
      usageLowerBound = facts.lowerBound;
      this.promptTokens += facts.usage.prompt_tokens;
      this.completionTokens += facts.usage.completion_tokens;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      error = msg.startsWith("bridge ") ? msg
        : `bridge 输出解析失败: ${msg.slice(0, 200)}${(r.stderr ? `｜stderr: ${r.stderr.toString().slice(0, 120)}` : "")}`;
    }
    if (error && !text) {
      this.errors++;
      return {
        text: "", latencyMs: performance.now() - t0, error,
        bridgeProcess: { exitCode: r.status, signal: r.signal,
          ...((r.error as NodeJS.ErrnoException | undefined)?.code ? { errorCode: (r.error as NodeJS.ErrnoException).code } : {}) },
        usageSource,
        usageLowerBound,
        ...(transport ? { transport } : {}),
        ...(reportedAttempts === undefined ? {} : { httpAttempts: reportedAttempts }),
        ...(budgetExhausted ? { budgetExhausted: true } : {}),
        ...(budgetStopReason ? { budgetStopReason } : {}),
        usage: { requests: this.requests - req0, promptTokens: this.promptTokens - pTok0, completionTokens: this.completionTokens - cTok0 },
      };
    }
    const out: TargetResponse = {
      text,
      latencyMs: performance.now() - t0,
      usageSource,
      usageLowerBound,
      ...(transport ? { transport } : {}),
      ...(reportedAttempts === undefined ? {} : { httpAttempts: reportedAttempts }),
      usage: {
        requests: this.requests - req0,
        promptTokens: this.promptTokens - pTok0,
        completionTokens: this.completionTokens - cTok0,
      },
    };
    if (this.cacheDir && text) {
      try { writeFileSync(join(this.cacheDir, `${key}.json`), JSON.stringify(out), "utf8"); }
      catch { /* 缓存写失败不影响评测 */ }
    }
    return out;
  }

  /** 跑批后打印真实用量（M0 标定数据来源） */
  usageLine(): string {
    const parts = [
      `API 请求 ${this.requests} 次（缓存命中 ${this.cacheHits}）`,
      // 口径提醒：额度账本记的是 HTTP 尝试（含重试），不是 spawn 次数
      `底层 HTTP 尝试 ${this.httpAttempts} 次（口径与预算账本一致）`,
      `tokens ~${this.promptTokens}入/${this.completionTokens}出`,
    ];
    if (this.errors) parts.push(`失败 ${this.errors}`);
    return parts.join("，");
  }
}
