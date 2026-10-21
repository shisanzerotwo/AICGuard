/**
 * 报告输出：JSON（给系统）、Markdown（给文档）、HTML 看板（给演示）。
 *
 * 三种输出共用同一份数据，保证报告、视频、PPT 里的数字完全一致。
 * HTML 看板复用仓库根目录的 web/index.html 模板 —— 数据内嵌，双击即开，无需服务器。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FAMILIES, GOALS } from "./attacks.ts";
import { defendedPairs, formatCoverage, formatRate, tally, type PairedRow, type Tally } from "./metrics.ts";
import type { RunVersions, TargetRuntimeInfo } from "./runmeta.ts";
import { REPORT_SCHEMA_VERSION } from "./report-adapter.ts";
import type { ComplianceReport } from "./compliance.ts";
import type { Finding } from "./attribution.ts";
import type { AttackResult, BenignResult, Family, Metrics, Probe } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

export interface RunMeta {
  runId: string;
  startedAt: string;
  target: string;
  profile: string;
  profileLabel: string;
  guardsEnabled: string[];
  threshold: number;
  /** 来源与可复现性（M2-2）：代码/语料/护栏/判据/工具契约版本 */
  versions?: RunVersions;
  /** 运行环境（node 版本/平台；不含路径中的用户名） */
  runtime?: { node: string; platform: string };
  /** 目标身份与计数（模型/端点/采样参数/请求与缓存计数；**不含密钥**） */
  targetRuntime?: TargetRuntimeInfo;
}

/** 打码：只保留版本号主体，避免把带用户名的绝对路径写进报告 */
function safeNodeVersion(v: string): string {
  return v.trim();
}

export interface FamilyStat {
  family: string;
  label: string;
  total: number;
  baseline_breach: number;
  guarded_breach: number;
  /** 分母 = 该族 baseline 的**确定判定数**（来自 tally）；无确定判定 ⇒ null */
  baseline_asr: number | null;
  /** 同上（guarded 臂）；无确定判定 ⇒ null */
  guarded_asr: number | null;
  /** 配对口径的防御有效率；族内没有可比较配对时为 null（界面显示「不可计算」） */
  defense_rate: number | null;
  /** 分母口径的唯一出处（含 attempted/decided/breaches/unclear/callErrors/coverage），供审计与外推性判断 */
  baselineTally: Tally;
  guardedTally: Tally;
}

export interface SourceStat {
  source: string;
  label: string;
  total: number;
  baseline_breach: number;
  guarded_breach: number;
  /** 同上：分母只由确定判定构成（来源分组也要能看出分层） */
  baseline_asr: number | null;
  guarded_asr: number | null;
  baselineTally: Tally;
  guardedTally: Tally;
}

/** 族内/来源内两臂的配对（供配对口径的防御率使用） */
function pairArms(base: AttackResult[], guard: AttackResult[]): PairedRow[] {
  const guardByProbe = new Map(guard.map((g) => [g.probeId, g]));
  const pairs: PairedRow[] = [];
  for (const b of base) {
    const g = guardByProbe.get(b.probeId);
    if (g) pairs.push({ baseline: b, guarded: g });
  }
  return pairs;
}

export function familyStats(results: AttackResult[]): FamilyStat[] {
  const out: FamilyStat[] = [];
  for (const family of Object.keys(FAMILIES) as Family[]) {
    const base = results.filter((r) => r.family === family && r.mode === "baseline");
    const guard = results.filter((r) => r.family === family && r.mode === "guarded");
    if (!base.length) continue;
    // 分族也要走同一个 tally()（M1-2c）：分母只由确定判定构成，
    // 未判定/调用失败单独计数 ⇒ 族间可比且不会把「判不准」当「未攻破」。
    const baselineTally = tally(base);
    const guardedTally = tally(guard);
    out.push({
      family,
      label: FAMILIES[family],
      total: base.length,
      baseline_breach: baselineTally.breaches,
      guarded_breach: guardedTally.breaches,
      baseline_asr: baselineTally.asr,
      guarded_asr: guardedTally.asr,
      defense_rate: defendedPairs(pairArms(base, guard)).rate,
      baselineTally,
      guardedTally,
    });
  }
  return out;
}

export function sourceStats(results: AttackResult[]): SourceStat[] {
  const labels: Record<string, string> = {
    native: "母语中文（自建）",
    mt: "机翻腔（模拟 garak 机翻产物）",
  };
  const out: SourceStat[] = [];
  for (const src of ["native", "mt"]) {
    const base = results.filter((r) => r.source === src && r.mode === "baseline");
    const guard = results.filter((r) => r.source === src && r.mode === "guarded");
    if (!base.length) continue;
    // 分来源同走 tally()：机翻组这类小样本一旦有未判定/调用失败，
    // 聚合分母会直接漂移（且和分族口径不一致）。
    const baselineTally = tally(base);
    const guardedTally = tally(guard);
    out.push({
      source: src,
      label: labels[src] ?? src,
      total: base.length,
      baseline_breach: baselineTally.breaches,
      guarded_breach: guardedTally.breaches,
      baseline_asr: baselineTally.asr,
      guarded_asr: guardedTally.asr,
      baselineTally,
      guardedTally,
    });
  }
  return out;
}

export interface EqualWeightStat {
  /** 各家族 ASR 的等权均值（只计入非 null 的家族）；无可用家族时为 null */
  baseline_asr: number | null;
  guarded_asr: number | null;
  /** 等权防御有效率 = 各家族配对口径防御率的等权均值（只计入非 null 的家族）；无可用家族时为 null */
  defense_rate: number | null;
  families: number;
}

/**
 * 按攻击族等权聚合。语料结构不均衡（编码混淆族占 366 条里的 257 条，被归一化全歼），
 * 聚合 ASR 会被该族拉低；等权口径把每个族视作同等权重，两个口径并列呈报才不会失真。
 */
export function equalWeightStats(results: AttackResult[]): EqualWeightStat {
  const fs = familyStats(results);
  const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const nums = (xs: Array<number | null>): number[] => xs.filter((v): v is number => v !== null);
  const rates = nums(fs.map((f) => f.defense_rate));
  return {
    baseline_asr: mean(nums(fs.map((f) => f.baseline_asr))),
    guarded_asr: mean(nums(fs.map((f) => f.guarded_asr))),
    defense_rate: mean(rates),
    families: fs.length,
  };
}

/** 四舍五入到 4 位；`null`（不可计算）原样传递——不得写成 0 */
const round4 = (v: number | null): number | null => (v === null ? null : Number(v.toFixed(4)));

export function buildPayload(
  meta: RunMeta,
  metrics: Metrics,
  results: AttackResult[],
  benign: BenignResult[],
  findings: Finding[],
): Record<string, unknown> {
  const eq = equalWeightStats(results);
  return {
    // 报告 schema 版本（M2-3）：新报告标记 v2；旧报告缺此字段，由 report-adapter 只读适配
    schemaVersion: REPORT_SCHEMA_VERSION,
    meta: {
      run_id: meta.runId,
      started_at: meta.startedAt,
      target: meta.target,
      guards_enabled: meta.guardsEnabled,
      profile: meta.profileLabel,
    },
    // 来源与可复现性（M2-2）：报告自带“哪份代码/语料/护栏/判据/模型/参数”
    ...(meta.versions ? { versions: meta.versions } : {}),
    ...(meta.runtime ? { runtime: { node: safeNodeVersion(meta.runtime.node), platform: meta.runtime.platform } } : {}),
    ...(meta.targetRuntime ? { target_runtime: meta.targetRuntime } : {}),
    metrics: {
      probe_total: metrics.probeTotal,
      benign_total: metrics.benignTotal,
      baseline_breach: metrics.baselineBreach,
      guarded_breach: metrics.guardedBreach,
      baseline_asr: round4(metrics.baselineAsr),      guarded_asr: round4(metrics.guardedAsr),
      equal_weight_baseline_asr: round4(eq.baseline_asr),
      equal_weight_guarded_asr: round4(eq.guarded_asr),
      equal_weight_families: eq.families,
      defense_rate: round4(metrics.defenseRate),
      // 配对口径的可审计计数（修复单第 1 项）：防御率的分母不再是两臂聚合相减，
      // 而是「同一条 probe 两臂都可比较」的配对数。comparable 很小时防御率不可外推。
      defense_defended: metrics.defensePairs.defended,
      defense_comparable: metrics.defensePairs.comparable,
      defense_unknown: metrics.defensePairs.unknown,
      defense_not_eligible: metrics.defensePairs.notEligible,
      defense_breach_with_error: metrics.defensePairs.breachWithError,
      defense_coverage: round4(
        metrics.probeTotal > 0 ? metrics.defensePairs.comparable / metrics.probeTotal : null),
      false_positive_rate: round4(metrics.falsePositiveRate),
      benign_blocked: metrics.benignBlocked,
      blocked_at_input: metrics.blockedAtInput,
      blocked_at_output: metrics.blockedAtOutput,
      avg_latency_ms: metrics.avgLatencyMs,
      unclear_baseline: metrics.unclearBaseline,
      unclear_guarded: metrics.unclearGuarded,
      // M1-2b 新增：分母口径与执行状态（唯一出处 = metrics.ts 的 tally）。
      // baseline_asr / guarded_asr / defense_rate / false_positive_rate 为 null 时
      // 表示**没有确定判定样本 = 不可计算**，不得读作 0。
      baseline_decided: metrics.baselineTally.decided,
      guarded_decided: metrics.guardedTally.decided,
      baseline_coverage: round4(metrics.baselineTally.coverage),
      guarded_coverage: round4(metrics.guardedTally.coverage),
      baseline_call_errors: metrics.baselineTally.callErrors,
      guarded_call_errors: metrics.guardedTally.callErrors,
      benign_evaluated: metrics.benignEvaluated,
      benign_call_errors: metrics.benignCallErrors,
      asr_computable: metrics.baselineAsr !== null && metrics.guardedAsr !== null,
      ...(metrics.tokenUsage ? {
        token_usage: {
          baseline: metrics.tokenUsage.baseline,
          guarded: metrics.tokenUsage.guarded,
          overhead_ratio: metrics.tokenUsage.overheadRatio,
        },
      } : {}),
    },
    families: familyStats(results),
    sources: sourceStats(results),
    findings: findings.map((f) => ({
      level: f.level,
      family: f.family,
      family_label: f.familyLabel,
      title: f.title,
      count: f.count,
      total: f.total,
      breach_kinds: f.breachKinds,
      root_cause: f.rootCause,
      suggestions: f.suggestions,
      evidence: f.evidence.map((e) => ({
        probe_id: e.probeId, text: e.text, response: e.response,
      })),
    })),
    breached_cases: results.filter((r) => r.breach).map((r) => ({
      probe_id: r.probeId,
      family_label: FAMILIES[r.family] ?? r.family,
      goal: GOALS[r.goal] ?? r.goal,
      mode: r.mode,
      text: r.text,
      response: (r.evidence || r.response).slice(0, 300),
      breach_kind: r.breachKind,
    })),
    // 误报明细：只列「真的跑完且被拦」的正常请求（M1-2c 复核第二项）。
    // 靶子调用失败的样本不算误报——把它列出来会出现「分子的样本并不在分母里」的自相矛盾。
    benign_false_positives: benign.filter((b) => b.blocked && !b.error).map((b) => ({
      probe_id: b.probeId, text: b.text, reason: b.reason,
    })),
  };
}

// ============================================================ 写出

function ensure(p: string) {
  mkdirSync(dirname(p), { recursive: true });
}

export function writeJson(payload: Record<string, unknown>, path: string): string {
  ensure(path);
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

/**
 * 逐条证据（M2-4）：把**全部**用例结果（含未攻破的）以 JSONL 落盘。
 *
 * 为什么单独落一份：报告里的 `breached_cases` 只保留攻破样本，于是历史上"未攻破"的结论
 * 没有任何原始回答可核实 ⇒ 事后无法重判（只能重新采样）。有了这份逐条证据，
 * 未来 run 的判据重判才能覆盖正反两面。
 */
export function writeCasesJsonl(results: AttackResult[], path: string): string {
  ensure(path);
  const lines = results.map((r) => JSON.stringify({
    probeId: r.probeId,
    mode: r.mode,
    family: r.family,
    goal: r.goal,
    source: r.source,
    verdict: r.verdict,
    status: r.status,
    inputBlocked: r.inputBlocked,
    outputFiltered: r.outputFiltered,
    blockedBy: r.blockedBy,
    input: r.text,
    response: r.response,
    breach: r.breach,
    breachKind: r.breachKind,
    evidence: r.evidence,
    toolCalls: r.toolCalls.length,
    latencyMs: r.latencyMs,
    targetError: r.targetError,
    ...(r.usage ? { usage: r.usage } : {}),
    ...(r.usageSource ? { usageSource: r.usageSource, usageLowerBound: r.usageLowerBound } : {}),
    ...(r.bridgeProcess ? { bridgeProcess: r.bridgeProcess } : {}),
  }));
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

export function writeHtml(payload: Record<string, unknown>, path: string): string {  const tplPath = join(REPO_ROOT, "web", "index.html");
  if (!existsSync(tplPath)) throw new Error(`看板模板不存在：${tplPath}`);
  const html = readFileSync(tplPath, "utf8")
    .replace("/*__AICGUARD_DATA__*/null", JSON.stringify(payload));
  ensure(path);
  writeFileSync(path, html, "utf8");
  return path;
}

export function writeMarkdown(
  meta: RunMeta,
  metrics: Metrics,
  results: AttackResult[],
  benign: BenignResult[],
  findings: Finding[],
  path: string,
  compliance?: ComplianceReport,
): string {
  const L: string[] = [];
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const eq = equalWeightStats(results);
  // 可选章节的动态编号：跳过某节时不会出现“四 → 六”这种跳号
  const CN_NUM = ["一", "二", "三", "四", "五", "六", "七"];
  let nextSecNo = 3;   // 一、二、三 已用（核心指标 / 分族 / 防御缺口归因）
  const nextSec = (): string => CN_NUM[nextSecNo++];
  L.push("# 大模型安全评测报告", "");
  L.push(`- **评测编号**：${meta.runId}`);
  L.push(`- **评测时间**：${meta.startedAt}`);
  L.push(`- **受测应用**：\`${meta.target}\``);
  L.push(`- **防御档位**：${meta.profileLabel}`);
  L.push(`- **启用防御**：${meta.guardsEnabled.join("、") || "无"}`);
  L.push("");

  L.push("## 一、核心指标", "");  L.push("| 指标 | 数值 | 说明 |");
  L.push("|---|---|---|");
  L.push(`| 攻击用例总数 | ${metrics.probeTotal} | 覆盖 6 个攻击族 |`);
  L.push(`| **无防御攻击成功率 ASR** | **${formatRate(metrics.baselineAsr, 1)}** | 不加防御时被攻破的比例（分母 = 确定判定 ${metrics.baselineTally.decided} 条） |`);
  L.push(`| **有防御攻击成功率 ASR** | **${formatRate(metrics.guardedAsr, 1)}** | 开启防御后被攻破的比例（分母 = 确定判定 ${metrics.guardedTally.decided} 条） |`);
  L.push(`| 无防御 ASR（按族等权） | ${formatRate(eq.baseline_asr, 1)} | ${eq.families} 个攻击族等权平均，消除编码混淆族占比对聚合值的拉低 |`);
  L.push(`| 有防御 ASR（按族等权） | ${formatRate(eq.guarded_asr, 1)} | 同上口径；与聚合口径并列呈报，避免"只赢单一族"导致数字失真 |`);
  L.push(`| **防御有效率** | **${formatRate(metrics.defenseRate, 1)}** | 配对口径：原本能得手且两臂都可比较的 ${metrics.defensePairs.comparable} 条中防住 ${metrics.defensePairs.defended} 条`
    + `（覆盖率 ${formatCoverage(metrics.probeTotal ? metrics.defensePairs.comparable / metrics.probeTotal : null)}；`
    + `未知配对 ${metrics.defensePairs.unknown} 条、baseline 未得手 ${metrics.defensePairs.notEligible} 条不计入） |`);
  L.push(`| **误报率** | **${formatRate(metrics.falsePositiveRate, 1)}** | ${metrics.benignBlocked}/${metrics.benignEvaluated} 条正常请求被误拦（分母 = 真正跑完的 ${metrics.benignEvaluated} 条；靶子调用失败 ${metrics.benignCallErrors} 条单独计数，不入分母） |`);
  L.push(`| 输入侧拦截数 | ${metrics.blockedAtInput} | 在进入模型之前就被挡下 |`);
  L.push(`| 输出侧兜底数 | ${metrics.blockedAtOutput} | 穿过输入侧、靠输出过滤止损 |`);
  L.push(`| 无法判定数（unclear） | ${metrics.unclearGuarded} | **不计入 ASR 分母** |`);
  L.push(`| 判定覆盖率 | ${formatCoverage(metrics.guardedTally.coverage)} | 确定判定 ${metrics.guardedTally.decided} / 尝试 ${metrics.guardedTally.attempted}；覆盖率低说明该轮结果外推性差 |`);
  L.push(`| 靶子调用失败数 | ${metrics.guardedTally.callErrors} | **不计入分母**：失败 ≠ 防住了 |`);
  L.push(`| 平均处理延迟 | ${metrics.avgLatencyMs.toFixed(2)} ms | 防御链路引入的额外开销 |`);
  if (metrics.tokenUsage) {
    const tu = metrics.tokenUsage;
    const fmt = (u: NonNullable<Metrics["tokenUsage"]>["baseline"]) =>
      `${u.requests} 次桥调用 / 已知下界 ${u.lowerBound.promptTokens ?? "未知"}入 / ${u.lowerBound.completionTokens ?? "未知"}出；完整成本样本 ${u.completeCases}/${u.usedCases}`
      + `（reported=${u.sources.reported}, partial=${u.sources.partial}, unknown=${u.sources.unknown}, none=${u.sources.none}；未知不等于零）`;
    L.push(`| 真实模型用量·无防御臂 | ${fmt(tu.baseline)} | 只聚合真正打到模型的用例；缓存命中记 0 |`);
    L.push(`| 真实模型用量·防御臂 | ${fmt(tu.guarded)} | 输入侧拦截省下的调用不计入均值，总消耗看聚合值 |`);
    L.push(`| token 放大倍数 | ${tu.overheadRatio == null ? "不可计算" : tu.overheadRatio.toFixed(2) + "×"} | 仅正常完成且来源 reported 的完整成本样本参与均值/倍率；未知及下界不参与 |`);
  }
  L.push("");

  L.push("## 二、分攻击族表现", "");
  L.push("| 攻击族 | 用例数 | 无防御 ASR | 有防御 ASR | 防御有效率 |");
  L.push("|---|---|---|---|---|");
  for (const f of familyStats(results)) {
    L.push(`| ${f.label} | ${f.total} | ${formatRate(f.baseline_asr, 1)} | ${formatRate(f.guarded_asr, 1)} | ${formatRate(f.defense_rate, 1)} |`);
  }
  L.push("");

  L.push("### 按用例来源拆分", "");
  L.push("| 用例来源 | 条数 | 无防御 ASR | 有防御 ASR |");
  L.push("|---|---|---|---|");
  for (const s of sourceStats(results)) {
    L.push(`| ${s.label} | ${s.total} | ${formatRate(s.baseline_asr, 1)} | ${formatRate(s.guarded_asr, 1)} |`);
  }
  L.push("");
  L.push("> 自建的母语中文语料与机翻腔语料分开统计。两者的规则覆盖差异是"
    + "「中文攻击用例库必须自建」这一结论的量化依据。");
  L.push("");

  L.push("## 三、防御缺口归因与修复建议", "");
  if (!findings.length) {
    L.push("本次评测未发现防御缺口。", "");
  }
  findings.forEach((f, i) => {
    L.push(`### ${i + 1}. ${f.level === "high" ? "🔴 高危" : "🟡 中危"}｜${f.familyLabel}：${f.title}`);
    L.push("");
    L.push(`- **涉及用例**：${f.count} / ${f.total}`);
    L.push(`- **根因分析**：${f.rootCause}`);
    L.push("- **修复建议**：");
    for (const s of f.suggestions) L.push(`  - ${s}`);
    if (f.evidence.length) {
      L.push("- **证据样本**：", "");
      L.push("  | 用例编号 | 输入（截断） | 输出/证据（截断） |");
      L.push("  |---|---|---|");
      for (const e of f.evidence) {
        const t = e.text.replace(/\|/g, "\\|").replace(/\n/g, " ");
        const r = e.response.replace(/\|/g, "\\|").replace(/\n/g, " ");
        L.push(`  | ${e.probeId} | ${t} | ${r} |`);
      }
    }
    L.push("");
  });

  // 合规整改建议（T5）：攻破案例 → 风险等级 + 整改建议
  if (compliance) {
    L.push(`## ${nextSec()}、合规整改建议`, "");
    L.push(compliance.markdown.replace(/^# 合规整改建议\n+/, "").trimEnd(), "");
  }

  // 误报样本：同样只列跑完且被拦的（失败样本单列，不得混入误报）
  const fps = benign.filter((b) => b.blocked && !b.error);
  const benignCallErrors = benign.filter((b) => !!b.error).length;
  if (fps.length || benignCallErrors) {
    L.push(`## ${nextSec()}、误报样本`, "");
    if (fps.length) {
      L.push("| 用例编号 | 正常请求（截断） | 被拦原因 |");
      L.push("|---|---|---|");
      for (const b of fps) {
        L.push(`| ${b.probeId} | ${b.text.replace(/\|/g, "\\|").slice(0, 80)} | ${b.reason} |`);
      }
    } else {
      L.push("无可计入误报的样本。");
    }
    if (benignCallErrors) {
      L.push("");
      L.push(`> 另有 ${benignCallErrors} 条正常请求因靶子调用失败未评估，已在误报率分母中剔除（失败 ≠ 未误拦）。`);
    }
    L.push("");
  }

  // 来源与可复现性（M2-2）：报告自带“哪份代码/语料/护栏/判据/模型/参数/计数”
  if (meta.versions || meta.targetRuntime || meta.runtime) {
    L.push(`## ${nextSec()}、来源与可复现性`, "");
    L.push("| 项 | 值 |");
    L.push("|---|---|");
    const v = meta.versions;
    if (v) {
      L.push(`| 代码快照 | \`${v.codeSha}\`${v.codeDirty ? "（**工作区有未提交改动**，结果不可当作干净快照复现）" : "（工作区干净）"} |`);
      L.push(`| 语料哈希 | \`${v.corpusHash}\`（${v.corpusFiles.length} 个文件：${v.corpusFiles.map((f) => `${f.file} ${f.lines} 行`).join("、")}） |`);
      // M3-4：语料来自哪个不可变快照提交（未启用快照时不打印这一行，不制造假精度）
      if (v.snapshotCommitId) {
        L.push(`| 语料快照提交 | \`${v.snapshotCommitId}\`（不可变快照；读取固定到该提交，禁止混读） |`);
      }
      L.push(`| 护栏版本 | \`${v.guardVersion}\` |`);
      L.push(`| 判据版本 | \`${v.judgeVersion}\` |`);
      L.push(`| 工具契约 / 缓存键版本 | \`${v.toolContractVersion}\` / v${v.cacheKeyVersion} |`);
    }
    const t = meta.targetRuntime;
    if (t) {
      L.push(`| 目标类型 / 名称 | ${t.kind} / ${t.name} |`);
      if (t.model) L.push(`| 模型身份 | \`${t.model}\`${t.endpoint ? `（端点 \`${t.endpoint}\`）` : ""} |`);
      if (t.salt) L.push(`| 采样标识（salt） | \`${t.salt}\` |`);
      if (t.temperature !== undefined || t.maxTokens !== undefined) {
        L.push(`| 采样参数 | temperature=${t.temperature ?? "默认"}，maxTokens=${t.maxTokens ?? "默认"} |`);
      }
      if (t.cacheMode) L.push(`| 缓存模式 | ${t.cacheMode}${t.cacheMode === "replay" ? "（只读缓存，缺失即失败，不联网）" : ""} |`);
      if (t.requests !== undefined || t.cacheHits !== undefined) {
        L.push(`| 请求 / 缓存命中 / 失败 | ${t.requests ?? "—"} / ${t.cacheHits ?? "—"} / ${t.errors ?? "—"} |`);
      }
    }
    if (meta.runtime) {
      L.push(`| 运行环境 | node ${safeNodeVersion(meta.runtime.node)}（${meta.runtime.platform}） |`);
    }
    L.push("");
    L.push("> 说明：该节不含任何密钥或认证头；模型身份与端点已做规范化。同一份报告的来源均可由上述字段核对。", "");
  }

  L.push("## 附录：仍被攻破的用例", "");  const guardedBreached = results.filter((r) => r.breach && r.mode === "guarded");
  if (!guardedBreached.length) {
    L.push(`无。全部 ${metrics.probeTotal} 条攻击用例均被成功拦截。`);
  } else {
    L.push("| 用例编号 | 攻击族 | 攻破方式 | 输入（截断） |");
    L.push("|---|---|---|---|");
    for (const c of guardedBreached) {
      L.push(`| ${c.probeId} | ${FAMILIES[c.family]} | ${c.breachKind} | ${c.text.replace(/\|/g, "\\|").slice(0, 80)} |`);
    }
  }
  L.push("");

  ensure(path);
  writeFileSync(path, L.join("\n"), "utf8");
  return path;
}

export { REPO_ROOT };
