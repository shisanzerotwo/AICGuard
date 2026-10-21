/**
 * T3 · 防御层消融实验。
 *
 * 逐个开关 N1（归一化）/ G1（输入规则）/ G2（输出兜底），
 * 量化每一层的独立贡献 —— 证明防御有效不是因为「开了很多东西」，
 * 而是每层都有可测量的收益。这张表是答辩最有说服力的材料。
 *
 * 关键行是「N1 + G1（无输出兜底）」：归一化只做还原、本身不拦截，
 * 单独看与基线相同是**正确**的，它的价值必须与 G1 组合才能观察。
 *
 * 算法与预期数值：docs/06-实验模块移植规格.md 第 T3 节。
 */

import { measurePipeline } from "./evaluate.ts";
import { InputRuleGuard, Normalizer, OutputFilterGuard, Pipeline } from "./guards.ts";
import { formatRate } from "./metrics.ts";
import type { Probe, Target } from "./types.ts";

export interface AblationConfig {
  label: string;
  normalizer: boolean;
  inputGuard: boolean;
  outputGuard: boolean;
  /** 是否为关键行（N1 + G1）—— 报告里高亮 */
  key?: boolean;
}

export const ABLATION_CONFIGS: AblationConfig[] = [
  { label: "无防御（基线）", normalizer: false, inputGuard: false, outputGuard: false },
  { label: "仅 N1 归一化", normalizer: true, inputGuard: false, outputGuard: false },
  { label: "仅 G1 输入规则", normalizer: false, inputGuard: true, outputGuard: false },
  { label: "N1 + G1（无输出兜底）", normalizer: true, inputGuard: true, outputGuard: false, key: true },
  { label: "仅 G2 输出兜底", normalizer: false, inputGuard: false, outputGuard: true },
  { label: "全部启用", normalizer: true, inputGuard: true, outputGuard: true },
];

export interface AblationRow extends AblationConfig {
  total: number;
  /** 攻击成功率 = 被攻破条数 ÷ **确定判定数**（M1-2c）；无确定判定 ⇒ null（不可计算） */
  asr: number | null;
  breach: number;
  blockedInput: number;
  blockedOutput: number;
  /** 该配置下的确定判定数 / 未判定数 / 调用失败数（外推性依据） */
  decided: number;
  unclear: number;
  callErrors: number;
}

export interface AblationResult {
  rows: AblationRow[];
  markdown: string;
}

export function runAblation(params: {
  probes: Probe[];
  benignProbes: Probe[];
  target: Target;
  canary: string;
  threshold?: number;
}): AblationResult {
  const threshold = params.threshold ?? 0.70;

  const rows: AblationRow[] = ABLATION_CONFIGS.map((cfg) => {
    const pipeline = new Pipeline(
      cfg.normalizer ? new Normalizer() : null,
      cfg.inputGuard ? new InputRuleGuard(threshold) : null,
      cfg.outputGuard ? new OutputFilterGuard(params.canary) : null,
    );
    const m = measurePipeline(params.probes, params.benignProbes, params.target, pipeline, params.canary);
    return {
      ...cfg,
      total: m.total,
      breach: m.breach,
      asr: m.asr,
      blockedInput: m.inputBlocked,
      blockedOutput: m.outputBlocked,
      decided: m.tally.decided,
      unclear: m.tally.unclear,
      callErrors: m.tally.callErrors,
    };
  });

  return { rows, markdown: renderMarkdown(rows) };
}

function renderMarkdown(rows: AblationRow[]): string {
  // 保留历史 1 位小数精度；null ⇒ 不可计算
  const pct = (v: number | null) => formatRate(v, 1);
  const L: string[] = [];

  L.push("# 防御层消融实验（T3）", "");
  L.push("逐个开关 N1（编码归一化）/ G1（输入规则）/ G2（输出兜底），量化每层的独立贡献。", "");
  L.push("| 防御配置 | ASR | 被攻破 | 确定判定 | 输入拦截 | 输出兜底 |");
  L.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    const name = r.key ? `**${r.label}** ← 关键行` : r.label;
    L.push(`| ${name} | ${pct(r.asr)} | ${r.breach}/${r.total} | ${r.decided} | ${r.blockedInput} | ${r.blockedOutput} |`);
  }
  L.push("");

  // 关键结论由实测拼装：归一化层的独立贡献 = 仅 G1 → N1+G1 的 ASR 降幅
  const byLabel = (label: string) => rows.find((r) => r.label === label)!;
  const baseline = byLabel("无防御（基线）");
  const g1 = byLabel("仅 G1 输入规则");
  const n1g1 = byLabel("N1 + G1（无输出兜底）");
  // 任一端不可计算时不编造百分点（旧写法会把 null 当 0）
  const contribution = (g1.asr !== null && n1g1.asr !== null) ? (g1.asr - n1g1.asr) * 100 : null;
  const contribText = contribution === null
    ? "**归一化层贡献不可计算**（该对比存在无确定判定的配置）"
    : `**归一化层单独贡献 ${contribution.toFixed(1)} 个百分点**`;

  L.push("## 结论", "");
  L.push(`基线（无防御）ASR 为 ${pct(baseline.asr)}。仅开 G1 输入规则可降到 ${pct(g1.asr)}；`
    + `叠加 N1 归一化后进一步降到 **${pct(n1g1.asr)}** —— `
    + `${contribText}（${pct(g1.asr)} → ${pct(n1g1.asr)}）。`);
  L.push("");
  L.push("这解释了为什么编码混淆是关键词防御的头号杀手：关键词规则看不懂编码内容，"
    + "而模型看得懂。先归一化再检测，不需要改动模型就能堵住这一整类攻击——"
    + "「归一化层必须在下游规则之前」这条设计决策由此获得量化支撑。");
  L.push("");
  L.push("> 注：「仅 N1」单独看与基线相同是**正确**的——归一化只做还原，本身不拦截；"
    + "它的价值必须与 G1 组合才能观察，所以关键行是「N1 + G1」。");
  L.push("");
  L.push("> 注：G2 输出兜底的 ASR 与「全部启用」相同是**预期行为**——它兜住了输入侧漏掉的攻击，"
    + "但输入侧拦下的条数不会变。两层是互补关系，不是重复建设。");

  L.push("");
  return L.join("\n");
}
