import type { UsageSource, TransportEvidence, KnownTokenUsage } from "./types.ts";

export const isTokenCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
export const hasValidUsageShape = (u: unknown): u is { prompt_tokens: number; completion_tokens: number } =>
  !!u && typeof u === "object" && !Array.isArray(u)
  && isTokenCount((u as { prompt_tokens?: unknown }).prompt_tokens)
  && isTokenCount((u as { completion_tokens?: unknown }).completion_tokens);

/** 协议边界统一口径；缺次数不能推断一次，矛盾证据不能宣布零（F4/F5）。 */
export function resolveUsageSource(raw: {
  usage?: unknown; usageSource?: unknown; attempts?: unknown; text?: unknown; toolCalls?: unknown;
}, transport?: TransportEvidence): UsageSource {
  const explicit = raw.usageSource;
  const actualStates = ["submitted", "unknown-after-submit", "not-connecting"];
  const nonAttemptStates = ["refused", "not-sent", "dry-run"];
  const records = transport?.attempts ?? [];
  const attemptedRecord = records.some(a => actualStates.includes(a.outcome));
  const unknownRecord = records.some(a => !actualStates.includes(a.outcome) && !nonAttemptStates.includes(a.outcome));
  // 显式的完整/部分用量仍按新协议处理；确认零不得覆盖逐次尝试或未知状态。
  if (explicit === "reported" || explicit === "partial" || explicit === "unknown") return explicit;
  if (explicit === "none" && !attemptedRecord && !unknownRecord) return "none";
  const attemptsPresent = Object.hasOwn(raw, "attempts") && raw.attempts !== undefined && raw.attempts !== null;
  const attempts = isTokenCount(raw.attempts) ? raw.attempts : undefined;
  const state = transport?.state;
  const usage = raw.usage;
  const valid = hasValidUsageShape(usage);
  const known = readKnownUsage(usage);
  const any = known.promptTokens !== null || known.completionTokens !== null;
  const positive = (known.promptTokens ?? 0) > 0 || (known.completionTokens ?? 0) > 0;
  const answered = (typeof raw.text === "string" && raw.text !== "") || (Array.isArray(raw.toolCalls) && raw.toolCalls.length > 0);
  const notSent = (attemptsPresent && attempts === 0) || state === "refused" || state === "dry-run";
  const sent = (attemptsPresent && attempts !== undefined && attempts > 0)
    || state === "submitted" || state === "unknown-after-submit" || state === "not-connecting" || positive || answered || attemptedRecord;
  if (unknownRecord) return any && (positive || sent) ? "partial" : "unknown";
  if (notSent && sent) return any ? "partial" : "unknown";
  if (notSent) return "none";
  if (!sent) return "unknown";
  if (!valid) return any ? "partial" : "unknown";
  return attemptsPresent && attempts === 1 ? "reported" : "partial";
}

/** none 不增加未知成本；完整+未知/部分只能是下界。 */
export function combineUsageSources(sources: UsageSource[]): UsageSource {
  const sent = sources.filter(s => s !== "none");
  if (!sent.length) return "none";
  if (sent.every(s => s === "reported")) return "reported";
  return sent.some(s => s === "reported" || s === "partial") ? "partial" : "unknown";
}

/** 对部分字段逐项校验；缺失/非法字段保留 null，不补成供应商报告的零。 */
export function readKnownUsage(raw: unknown): KnownTokenUsage {
  const u = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { promptTokens: isTokenCount(u.prompt_tokens) ? u.prompt_tokens : null,
    completionTokens: isTokenCount(u.completion_tokens) ? u.completion_tokens : null };
}

export function normalizeBridgeUsage(raw: { usage?: unknown; usageLowerBound?: unknown; usageSource?: unknown;
  attempts?: unknown; text?: unknown; toolCalls?: unknown }, transport?: TransportEvidence) {
  let source = resolveUsageSource(raw, transport);
  // 新桥给出的 lowerBound 优先；旧桥仅有 usage 时按原始字段逐项验证。
  const known = readKnownUsage(raw.usageLowerBound ?? raw.usage);
  const any = known.promptTokens !== null || known.completionTokens !== null;
  if (source === "reported" && (known.promptTokens === null || known.completionTokens === null)) source = any ? "partial" : "unknown";
  const lowerBound: KnownTokenUsage = source === "reported" || source === "partial" ? known : { promptTokens: null, completionTokens: null };
  return { source, lowerBound, usage: { prompt_tokens: lowerBound.promptTokens ?? 0, completion_tokens: lowerBound.completionTokens ?? 0 } };
}

export function addKnownUsage(total: KnownTokenUsage, part: KnownTokenUsage): void {
  if (part.promptTokens !== null) total.promptTokens = (total.promptTokens ?? 0) + part.promptTokens;
  if (part.completionTokens !== null) total.completionTokens = (total.completionTokens ?? 0) + part.completionTokens;
}
