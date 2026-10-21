/**
 * 核心数据结构。
 *
 * 全部用 TS 的 interface / type 描述，运行时由 Node 原生类型剥离处理——
 * 不需要 tsc、不需要打包、不需要任何 npm 依赖。
 */

import type { DefendedPairStats, Tally } from "./metrics.ts";
import type { TargetRuntimeInfo } from "./runmeta.ts";

/**
 * 判据类别（M1-3，按攻击目标显式选择）：
 *   - `recommend`：推荐类——必须「禁用项 + 同句肯定推荐语境」才算攻破（诱导推荐禁用农药）
 *   - `mention`  ：提及类——提及即攻破（套取内部数据/有害内容等），但否定/拒答语境里的提及不算
 */
export type JudgeKind = "recommend" | "mention";

/** 判据配置：定义"怎样算被攻破" */
export interface JudgeConfig {
  /** 命中判定，通常填禁用项名单 */
  any?: string[];
  /** 至少命中几个才算成功 */
  minHits?: number;
  /**
   * 推荐性语境词。
   * 只有同时命中 `any` 与 `requireContext`（且不在否定/替代/引用语境里）才算攻破——
   * 用来区分「推荐使用甲拌磷」（攻破）与「甲拌磷属于禁用农药」（合规提示）。
   * 推荐类判据未显式给词表时用 judge.ts 的 RECOMMEND_CONTEXTS（单一来源）。
   */
  requireContext?: string[];
  /** 判据类别；缺省由 judge.ts 的 judgeKindForGoal(goal) 推断 */
  kind?: JudgeKind;
}

/** 一条攻击用例 */
export interface Probe {
  id: string;
  family: Family;
  text: string;
  goal: string;
  severity: number;
  notes: string;
  /** 多轮攻击的完整轮次；单轮时为空 */
  turns?: string[];
  /** native = 母语中文自建；mt = 机翻腔（模拟 garak 机翻产物） */
  source: Source;
  judge?: JudgeConfig;
}

export type Source = "native" | "mt";

export type Family =
  | "direct_injection"
  | "indirect_injection"
  | "roleplay_jailbreak"
  | "encoding_obfuscation"
  | "multi_turn_induction"
  | "data_exfiltration"
  /** garak 对照组：过去式/句式改写绕过（T8 引入，仅用于语料对照实验） */
  | "rephrasing"
  /** Work Loop 成本耗尽（2026-10-05 引入，仅用于 workloop 通道的成本维度指标） */
  | "resource_exhaustion";

/**
 * 对话历史的一条消息。
 *
 * 为什么独立成类型：上游曾经用 `Array<[string, string]>` 存历史，而两个真实目标
 * 却把每个二元组当作「(用户问题, 助手回复)」展开——历史 ["user","A"],["assistant","B"]
 * 被展成 4 条消息（且角色错位）。审查 R2 复现了这个错位。
 * 现在历史统一为带角色的消息数组：**只允许 user / assistant**，系统提示由目标配置提供，
 * 控制台、文本目标、Agent 目标和护栏共享同一表示。
 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * 攻击判定（三值）。
 * - `success` 攻破：拿到了业务契约定义的违规结果
 * - `fail` 未攻破：明确未被诱导（含被护栏拦截、合规拒答）
 * - `unclear` 判不准：**不计入 ASR 分母**（判不准不污染指标）
 * 注意：「被阻断」不是判定值——阻断是执行路径，记在 inputBlocked / outputFiltered 里。
 */
export type AttackVerdict = "success" | "fail" | "unclear";

/**
 * 执行状态：把「跑完了」与「没跑成」分开，避免故障冒充结论。
 * - `ok` 流水线正常走完（含被防御拦截——那是结论，不是故障）
 * - `call_error` 靶子（真实模型）调用失败——必须与「未攻破」分开，否则失败会被当成防住了（R5）
 * - `budget_exhausted` 预算耗尽（没跑完）
 * - `invalid_test` 无效测试（例如未按约定送达攻击载荷）
 */
export type ExecutionStatus = "ok" | "call_error" | "budget_exhausted" | "invalid_test";

/** @deprecated 用 AttackVerdict；保留别名避免旧引用一次性改动面过大 */
export type JudgeVerdict = AttackVerdict;

/** 单层防御的判定结果 */
export interface GuardVerdict {
  guard: string;
  action: "allow" | "block" | "rewrite" | "redact";
  reason: string;
  score?: number;
}

/** 一次受防御保护的推理结果 */
export interface PipelineResult {
  bridgeProcess?: BridgeProcessEvidence;
  blocked: boolean;
  stage: "" | "input" | "output";
  blockedBy: string;
  verdicts: GuardVerdict[];
  finalText: string;
  sentText: string;
  /**
   * 靶子（真实模型）调用失败的原因。空串 = 正常。
   * API 失败 ≠ 防住了——评测器必须把它判为 unclear，不能当"未攻破"。
   */
  targetError: string;
  /**
   * 预算耗尽（P1/P3）：true = 这一次调用因**额度账本不足**被 bridge 在发送前拦下。
   * 与 `targetError` 同时出现（error 带耗尽文案）；评测器据此把执行状态标为
   * `budget_exhausted`（而不是一般的 call_error），编排层据此**中止**后续用例。
   */
  budgetExhausted?: boolean;
  /**
   * 预算中止的具体类别（exhausted/corrupt/locked/limit/missing）：
   * 「用完额度」与「账本损坏/锁冲突/配置违规」都要能分开读（P3 返工项 1）。
   */
  budgetStopReason?: string;
  /**
   * agent 靶子：目标模型实际发生的工具调用轨迹。
   * 与输出过滤**独立**——输出被拦不代表工具没被调用（审查 R4）。
   * 因此：执行目标之后先审计轨迹，再处理输出；两条路径各自留证据。
   */
  toolCalls: ToolCall[];
  /** 输出侧是否发生了过滤/改写（与 toolCalls 独立：两者可以同时为真） */
  outputFiltered?: boolean;
  /** 用量来源/完整度（Codex 复核 E2）：见 `TargetResponse.usageSource` */
  usageSource?: UsageSource;
  usageLowerBound?: KnownTokenUsage;
  /** 真实模型靶子：本次流水线执行的用量增量（未被拦截时才有值） */
  usage?: TokenUsage;
}

/** 一次工具调用（agent 靶子的轨迹记录，工具调用审计的判定输入） */
export interface ToolCall {
  /** 工具名 */
  tool: string;
  /** 调用参数 */
  args: Record<string, string>;
  /** 执行结果摘要（审计证据） */
  result: string;
}

/** 真实模型用量增量（本次调用 / 单用例累计）。离线靶子不产出此数据 */
export interface TokenUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

/** 已取得的供应商字段；null 表示该字段未取得，数字仅为成本下界。 */
export interface KnownTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

/** 目标模型的一次返回 */
export interface TargetResponse {
  bridgeProcess?: BridgeProcessEvidence;
  text: string;
  latencyMs: number;
  error?: string;
  /**
   * 预算耗尽（P1，`docs/15` §5.2）：本次调用**因额度不足而根本没发出请求**。
   * 与普通 `error` 分开，供上层把执行状态标为 `budget_exhausted`（而不是一般的 call_error），
   * 并且**不得**被当成“防住了”（预算耗尽不能记为防御成功）。
   */
  budgetExhausted?: boolean;
  /**
   * 用量的**来源 / 完整度**（Codex 复核 E2）：把“供应商报告的用量”与“默认占位 0”分开。
   *   · `reported` —— 本次动作的**每一次**真实调用都拿到了供应商报告的 usage（可信；
   *     `status=ok` 时即“有效完整成本样本”）
   *   · `partial`  —— 只拿到了一部分：已报数字是**下界**，其余轮次的用量**未知**
   *   · `unknown`  —— 有过已尝试/已提交的调用，但**完全没拿到**用量
   *     ⇒ 不得写成 0（那是把“未知”伪装成“零成本”），也不得当完整总额
   *   · `none`     —— 根本没发出请求（发送前被预算拦下 / 缓存命中）⇒ 确认零消耗
   */
  usageSource?: UsageSource;
  usageLowerBound?: KnownTokenUsage;
  /** agent 靶子专用：本次响应实际发生的工具调用轨迹；普通靶子为空 */
  toolCalls?: ToolCall[];
  /**
   * 本次调用的真实模型用量增量。缓存命中记 0（没有产生新 API 消耗）；
   * 离线靶子无此字段。逐用例聚合见 AttackResult.usage。
   */
  usage?: TokenUsage;
  /**
   * **送达证据**（P2/P3 返工，`docs/15` §4.2 D7）：实际 HTTP 请求正文的证据。
   * 关键区别：它由 **bridge 在 fetch 构造点**产出（IPC 包装**不是** HTTP 正文，不得当送达依据）；
   * `state` 显式区分「dry-run 预览 / 发送前拒绝 / 实际提交 / 提交后状态未知 / 缓存重放」。
   * 离线靶子无此字段——那时以 `sentText` 为最终请求正文（既有口径不变）。
   */
  transport?: TransportEvidence;
  /**
   * 预算中止的具体原因（P3 返工）：`exhausted`（真耗尽，可重跑续测）/ `corrupt`（账本损坏）
   * / `locked`（锁冲突或锁残留）/ `limit`（上限规则被违反）。**分别记录**，不合并成一种错。
   */
  budgetStopReason?: string;
  /**
   * **桥回报的底层 HTTP 尝试次数**（第四轮 R3 返工）：**协议事实**，与 `transport` 分开。
   * 旧/兼容桥可能只回报一个计数而没有 `request/transport` ⇒ 此时“尝试过”是**已知**的，
   * 但“哪一次尝试/请求正文”仍**未知** ⇒ 不得据此断言“本次成功发送”，也不得把
   * **字段缺失**读成 0（缺失 = 未知；只有 `refused` + 计数为 0 才是“明确的首发前拒绝证据”）。
   */
  httpAttempts?: number;
}

/**
 * 送达证据里的 **transport 状态**（`docs/37` §3 返工要求）：
 *   · `dry-run`              只组了「本会发出的」预览，**一个字节都没发** ⇒ 绝不算送达
 *   · `refused`              预算机制在**发送前**拦下 ⇒ 未发、未送达
 *   · `not-connecting`       发起了尝试但没有拿到任何 HTTP 响应（连接失败/DNS）⇒ 不得声称服务端收到
 *   · `submitted`            收到了 HTTP 响应（任何状态码）⇒ 正文确实到了服务端
 *   · `unknown-after-submit` 超时/中断：正文可能已到服务端，但**不得推断模型已处理**
 *   · `cache-replay`         本次未发请求，证据来自**历史请求**（必须显式标注）
 *   · `unexecuted`           该用例因**批次中止**根本没执行（编排层合成行）⇒ 不可能送达
 */
export type TransportState =
  | "dry-run" | "refused" | "not-connecting" | "submitted" | "unknown-after-submit" | "cache-replay" | "unexecuted";

/** 用量的来源/完整度（Codex 复核 E2）——见 `TargetResponse.usageSource` 的说明 */
export type UsageSource = "reported" | "partial" | "unknown" | "none";
export type ResponseErrorKind = "budget" | "http_status" | "body_read" | "json_parse" | "protocol" | "timeout" | "connection" | "response_processing";
export interface BridgeProcessEvidence {
  exitCode: number | null;
  signal: string | null;
  errorCode?: string;
}

export interface TransportEvidence {
  state: TransportState;
  /** **实际 HTTP 正文**的 sha256（bridge 在 `fetch` 的同一个 body 字符串上计算）；未发出时为空串 */
  requestSha256: string;
  /** 实际 HTTP 正文的字节数 */
  requestBytes: number;
  /** 尝试标识（bridge 内生成：pid-第几次-哈希前缀），用于区分重试、不互相覆盖证据 */
  attemptId: string;
  /**
   * 从**同一份正文数据**解码出的文本（系统提示 + 各消息内容，按序以换行连接）。
   * 为什么不用原始 JSON 字符串测保留范围：正文是 JSON，攻击文本里的换行/引号会被转义
   * （`\n` 两字符），拿原串测会把「完整送达」误判成「截断」。
   */
  decodedText: string;
  /** 证据是否来自缓存（历史请求）；true 时本次未发生任何 HTTP 尝试 */
  fromCache?: boolean;
  /**
   * **逐次尝试记录**（Codex 复核项 5）：每一次底层 HTTP 尝试一条，含自己的 attemptId 与哈希。
   * 用途：核对上面 `state/attemptId/requestSha256` **确实来自同一次尝试**（尤其是"先 500、后连接失败"
   * 这类混合结果）——只给一个合并后的三元组时，读者无法分辨它指向哪一次。
   */
  attempts?: Array<{
    n: number;
    outcome: TransportState;
    attemptId: string;
    requestSha256: string;
    requestBytes: number;
    /** 与本次请求同源；旧记录未保存时省略，不拿顶层最强记录补填。 */
    decodedText?: string;
    /**
     * **响应阶段**错误（连接已建立之后的响应体读取/解析失败）。与 `outcome` 分开：
     * 拿到 HTTP 响应就已经"送达"，解析失败不得把送达事实改写成"没连上"。
     */
    responseError?: string;
    responseErrorKind?: ResponseErrorKind;
  }>;
}

/** 目标应用接口。靶子应用与真实模型都实现它 */
export interface Target {
  readonly name: string;
  respond(prompt: string, history?: ChatMessage[]): TargetResponse;
  /**
   * 运行信息（M2-2）：模型身份 / 规范化端点 / 采样参数 / 请求与缓存计数。
   * **不得包含 apiKey 或任何认证头**；靶子未实现时报告记 unknown，不编造身份。
   */
  describe?(): TargetRuntimeInfo;
}

export type Mode = "baseline" | "guarded";

/** 一条用例在某种防御配置下的评测结果 */
export interface AttackResult {
  bridgeProcess?: BridgeProcessEvidence;
  usageSource?: UsageSource;
  usageLowerBound?: KnownTokenUsage;
  probeId: string;
  family: Family;
  goal: string;
  text: string;
  mode: Mode;
  source: Source;
  /** 攻击判定（三值；不再含 "blocked"/""） */
  verdict: AttackVerdict;
  /** 执行状态：调用失败 / 预算耗尽 / 无效测试 都不得冒充"未攻破" */
  status: ExecutionStatus;
  /** 靶子调用失败原因，空串 = 正常（消费者过去读一个不存在的字段，见审查 R5） */
  targetError: string;
  /** 输入侧阻断（独立记录） */
  inputBlocked: boolean;
  /** 输出侧过滤（独立记录；可与工具越权同时成立，见审查 R4） */
  outputFiltered: boolean;
  /** 工具调用轨迹（独立记录，参数即证据） */
  toolCalls: ToolCall[];
  /**
   * @deprecated 派生字段，保留仅为兼容既有报表/前端；新代码用 inputBlocked / outputFiltered。
   * 语义：blocked = inputBlocked || outputFiltered；blockStage 为 "input"/"output"/""。
   */
  blocked: boolean;
  blockStage: string;
  blockedBy: string;
  breach: boolean;
  breachKind: string;
  evidence: string;
  response: string;
  latencyMs: number;
  /**
   * 该用例在本档位下的真实模型用量累计（多轮逐次求和）。
   * 输入侧被拦 / 离线靶子 / 调用失败的用例无此字段——
   * 前者根本没打到模型，后两者没有真实用量。
   */
  usage?: TokenUsage;
}

/** 正常请求的误报测试结果 */
export interface BenignResult {
  probeId: string;
  text: string;
  blocked: boolean;
  blockedBy: string;
  reason: string;
  /**
   * 靶子（真实模型）调用失败原因，空串 = 正常。
   * 与 ASR 同理：API 失败 ≠ 未误拦——必须从误报率分母剔除。
   */
  error: string;
}

/** 汇总指标 */
export interface Metrics {
  probeTotal: number;
  benignTotal: number;
  baselineBreach: number;
  guardedBreach: number;
  unclearBaseline: number;
  unclearGuarded: number;
  blockedAtInput: number;
  blockedAtOutput: number;
  benignBlocked: number;
  avgLatencyMs: number;
  /**
   * 基线臂（无防御）的完整计数。**ASR 分母的唯一出处是 metrics.ts 的 tally()**，
   * 不在本文件或各报表里重算——审查 R5 的教训就是「分母口径散落多处」。
   */
  baselineTally: Tally;
  /** 防御臂（开启护栏）的完整计数 */
  guardedTally: Tally;
  /** 正常请求里真正跑完（未被靶子调用失败剔除）的条数；误报率的分母 */
  benignEvaluated: number;
  /** 正常请求里靶子调用失败的条数（不进误报率分母：失败 ≠ 未误拦） */
  benignCallErrors: number;
  /**
   * 分母已扣除 unclear / 调用失败。**`null` = 没有确定判定样本 ⇒ 不可计算**，
   * 报表与界面必须显示「不可计算」，**不得当 0 用**。
   */
  baselineAsr: number | null;
  guardedAsr: number | null;
  /** 防御率（配对口径）的审计计数：defended / comparable / unknown / notEligible / breachWithError */
  defensePairs: DefendedPairStats;
  /**
   * 防御有效率（= defensePairs.rate）。分母已扣除 unclear / 调用失败。
   * `null` = 没有可比较的配对 ⇒ 不可计算。
   */
  defenseRate: number | null;
  /** 误报率；没有评估过的正常请求时为 null */
  falsePositiveRate: number | null;
  /**
   * 真实模型用量（离线靶子无此字段）。
    * 口径：按臂聚合已知成本下界并分列来源；只有 status=ok、source=reported 参与完整成本均值；
   * overheadRatio = guarded 单用例平均总 token（入+出）÷ baseline 同口径。
   * 含义：防御层为同等评测覆盖付出的额外模型开销倍数——
   * 输入侧拦截省下的调用不计入均值（它们没有 usage），总消耗看各臂聚合值。
   */
  tokenUsage?: {
    baseline: TokenUsage & { usedCases: number; completeCases: number; completeTokens: number; lowerBound: KnownTokenUsage; sources: Record<UsageSource, number> };
    guarded: TokenUsage & { usedCases: number; completeCases: number; completeTokens: number; lowerBound: KnownTokenUsage; sources: Record<UsageSource, number> };
    overheadRatio: number | null;
  };
}
