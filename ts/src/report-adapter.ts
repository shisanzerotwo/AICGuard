/**
 * 报告只读适配（M2-3）。
 *
 * docs/15 §2.1 要求：新报告使用 `schemaVersion: 2`；**旧报告通过只读适配展示并标记历史版本**，
 * 且**不覆盖原文件**。
 *
 * 为什么需要适配层：v1 报告缺少 v2 才有的字段（defense_* 分母计数、versions、target_runtime…）。
 * 直接在展示层读这些字段会得到 undefined，进而被渲染成 0 或"没有缺口"这类错误结论。
 * 适配层不做静默补 0，而是：缺失 ⇒ 明确标记为「不可用/不可计算」+ 记一条 warning。
 *
 * 本模块是**纯函数**：只吃已解析对象，不读盘也不写盘（原文件不可能被它改动）。
 */

/** 当前报告 schema 版本 */
export const REPORT_SCHEMA_VERSION = 2;

export interface ReportWarning {
  /** 缺失或不可用的字段路径 */
  field: string;
  /** 人读原因 */
  reason: string;
}

export interface ReportView {
  /** 报告自报的 schema 版本；缺失时按 1 记（历史版本） */
  schemaVersion: number;
  /** true = 旧格式（或未识别版本）⇒ 展示层必须打「历史版本」标记 */
  isLegacy: boolean;
  runId: string;
  startedAt: string;
  target: string;
  profile: string;
  /** 原样透传的指标对象（不补 0、不删字段） */
  metrics: Record<string, unknown>;
  /** 归一化后的比率：null = 不可用/不可计算（**不是 0**） */
  rates: {
    baselineAsr: number | null;
    guardedAsr: number | null;
    defenseRate: number | null;
    falsePositiveRate: number | null;
  };
  /** 缺失字段清单（按展示顺序） */
  warnings: ReportWarning[];
  /** 供展示层直接用的标记文案；v2 报告为空串 */
  legacyLabel: string;
}

const RATE_FIELDS: Array<[keyof ReportView["rates"], string]> = [
  ["baselineAsr", "baseline_asr"],
  ["guardedAsr", "guarded_asr"],
  ["defenseRate", "defense_rate"],
  ["falsePositiveRate", "false_positive_rate"],
];

/** v1 报告里没有、展示层常读的字段（缺失时必须显式告警，不能当 0） */
const V2_ONLY_FIELDS = [
  "baseline_decided", "guarded_decided", "baseline_coverage", "guarded_coverage",
  "baseline_call_errors", "guarded_call_errors", "benign_evaluated", "benign_call_errors",
  "defense_defended", "defense_comparable", "defense_unknown", "asr_computable",
];

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 把任意 report.json 解析结果适配成展示视图（只读）。
 * - 缺失的 schemaVersion ⇒ 按 1（历史版本）；
 * - 未知的更高版本 ⇒ 保留版本号但同样打标记（不假装理解它的语义）；
 * - 缺失字段一律为 null + warning，**绝不补 0**。
 */
export function adaptReport(raw: unknown): ReportView {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const metricsObj = (obj.metrics && typeof obj.metrics === "object" ? obj.metrics : {}) as Record<string, unknown>;
  const metaObj = (obj.meta && typeof obj.meta === "object" ? obj.meta : {}) as Record<string, unknown>;

  const declared = numOrNull(obj.schemaVersion);
  const schemaVersion = declared ?? 1;
  const isLegacy = declared === null || declared < REPORT_SCHEMA_VERSION;

  const warnings: ReportWarning[] = [];
  const rates: ReportView["rates"] = {
    baselineAsr: null, guardedAsr: null, defenseRate: null, falsePositiveRate: null,
  };
  for (const [key, field] of RATE_FIELDS) {
    const v = numOrNull(metricsObj[field]);
    rates[key] = v;
    if (v === null) {
      warnings.push({ field: `metrics.${field}`, reason: declared === null ? "历史报告无该字段" : "该值为空/不可计算" });
    }
  }
  if (isLegacy) {
    for (const f of V2_ONLY_FIELDS) {
      if (!(f in metricsObj)) warnings.push({ field: `metrics.${f}`, reason: "v1 报告缺该字段（v2 才有）：展示为不可用，不补 0" });
    }
    for (const f of ["versions", "target_runtime"]) {
      if (!(f in obj)) warnings.push({ field: f, reason: "v1 报告缺来源元信息（M2-2 起写入）" });
    }
  }
  if (declared !== null && declared > REPORT_SCHEMA_VERSION) {
    warnings.push({
      field: "schemaVersion",
      reason: `报告声明的版本（${declared}）高于本程序支持的 ${REPORT_SCHEMA_VERSION}：只读展示已知字段，不假设其余语义`,
    });
  }

  return {
    schemaVersion,
    isLegacy,
    runId: typeof metaObj.run_id === "string" ? metaObj.run_id : "(未知)",
    startedAt: typeof metaObj.started_at === "string" ? metaObj.started_at : "(未知)",
    target: typeof metaObj.target === "string" ? metaObj.target : "(未知)",
    profile: typeof metaObj.profile === "string" ? metaObj.profile : "(未知)",
    metrics: metricsObj,
    rates,
    warnings,
    legacyLabel: isLegacy ? `历史版本报告（schema v${schemaVersion}）` : "",
  };
}
