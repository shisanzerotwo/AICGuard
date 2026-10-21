/**
 * 历史重判 CLI（M2-4）。
 *
 * 用法：
 *   cd ts && node scripts/rejudge.ts --report <旧 report.json 路径> --out <新输出目录> [--corpus <data 目录>] [--judge <记录声明的判据版本>]
 *
 * 行为：
 *   - **只读**旧报告（绝不改写、绝不覆盖）；结果写到 --out 指向的**新目录**；
 *   - 优先用新 run 的 `cases.jsonl`（全量逐条证据，含未攻破样本）；
 *     若同目录没有，则退化为旧报告的 `breached_cases`（只有攻破样本 ⇒ 只能重判正面，负面记证据不足）；
 *   - 分类：rejudgeable（输入与回答可核实且仅判据变化）/ needs_resample（多轮或 agent 通道）/
 *     insufficient（缺原始回答或无判据）；
 *   - 输出标记 provenance（legacy = 记录未声明版本）与「不得参与修复版模型排名」的提示；
 *   - 全程零网络调用（重判只在本地跑判据）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveDataRoot } from "../src/data-root.ts";
import { fileURLToPath } from "node:url";

import { loadJsonl } from "../src/attacks.ts";
import { JUDGE_VERSION } from "../src/judge.ts";
import { recordsFromBreachedCases, rejudgeAll, type CaseRecord } from "../src/rejudge.ts";
import type { JudgeConfig } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
// M3-4：语料根目录走唯一解析入口（显式 > 快照提交 > 工作区），避免与其他入口混读
const DATA_DIR = resolveDataRoot({ repoRoot: join(TS_ROOT, "..") }).dir;

const argv = process.argv.slice(2);
let reportPath = "";
let outDir = "";
let corpusDir = DATA_DIR;
let declaredJudgeVersion: string | undefined;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--report") { reportPath = argv[i + 1]; i++; }
  else if (argv[i] === "--out") { outDir = argv[i + 1]; i++; }
  else if (argv[i] === "--corpus") { corpusDir = argv[i + 1]; i++; }
  else if (argv[i] === "--judge") { declaredJudgeVersion = argv[i + 1]; i++; }
  else if (argv[i] === "--help") {
    console.log("用法：node scripts/rejudge.ts --report <report.json> --out <新目录> [--corpus <data 目录>] [--judge <记录声明的判据版本>]");
    process.exit(0);
  }
}
if (!reportPath || !outDir) {
  console.error("必须指定 --report 与 --out（结果写到新目录，绝不覆盖旧报告）");
  process.exit(2);
}
if (!existsSync(reportPath)) {
  console.error(`旧报告不存在：${reportPath}`);
  process.exit(2);
}

/** 语料里的判据索引：probeId → {judge, goal} */
function buildJudgeIndex(): Map<string, { judge?: JudgeConfig; goal: string }> {
  const idx = new Map<string, { judge?: JudgeConfig; goal: string }>();
  for (const f of ["probes_zh.jsonl", "probes_mt_zh.jsonl", "probes_agro.jsonl", "probes_garak_mt.jsonl", "probes_tool_abuse.jsonl"]) {
    const p = join(corpusDir, f);
    if (!existsSync(p)) continue;
    for (const probe of loadJsonl(p)) idx.set(probe.id, { judge: probe.judge, goal: probe.goal });
  }
  return idx;
}

/** 逐条记录来源：优先 cases.jsonl（全量），退化到 breached_cases（只有攻破样本） */
function collectRecords(reportDir: string, report: Record<string, unknown>): { records: CaseRecord[]; source: string } {
  const casesPath = join(reportDir, "cases.jsonl");
  if (existsSync(casesPath)) {
    const records = readFileSync(casesPath, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      const o = JSON.parse(l) as Record<string, unknown>;
      return {
        probeId: String(o.probeId ?? ""),
        mode: typeof o.mode === "string" ? o.mode : undefined,
        text: typeof o.input === "string" ? o.input : undefined,
        response: typeof o.response === "string" ? o.response : undefined,
        verdict: typeof o.verdict === "string" ? o.verdict : undefined,
        breachKind: typeof o.breachKind === "string" ? o.breachKind : undefined,
        inputBlocked: o.inputBlocked === true,
        outputFiltered: o.outputFiltered === true,
      } satisfies CaseRecord;
    });
    return { records, source: "cases.jsonl（全量逐条证据，含未攻破样本）" };
  }
  const breached = Array.isArray(report.breached_cases) ? (report.breached_cases as Array<Record<string, unknown>>) : [];
  return {
    records: recordsFromBreachedCases(
      breached,
      String((report.meta as Record<string, unknown> | undefined)?.target ?? "").includes("agent") ? "agent" : undefined,
    ),
    source: "breached_cases（仅有攻破样本：未攻破结论的证据缺失，无法重判）",
  };
}

const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
const reportDir = dirname(resolve(reportPath));
// 记录声明的判据版本：新报告从 versions.judgeVersion 取；旧报告没有 ⇒ legacy
const versionsObj = report.versions as { judgeVersion?: string } | undefined;
const effectiveJudgeVersion = declaredJudgeVersion ?? versionsObj?.judgeVersion;

const { records, source } = collectRecords(reportDir, report);
const judgeIndex = buildJudgeIndex();
const out = rejudgeAll(records, judgeIndex, effectiveJudgeVersion);
// 已知限制（必须写明）：breached_cases 里的 response 在报告里被截断到 300 字符，
// 据它重判可能与原始回答不一致；新 run 的 cases.jsonl 保存完整回答。
if (source.startsWith("breached_cases")) {
  out.summary.notes.push("本报告没有 cases.jsonl，只能从 breached_cases 重判：其中的 response 在报告里已被截断到 300 字符，"
    + "重判可能因截断而与原始回答不一致；结论仅供判据语义核对，**不得当作修复版新采样**。");
}

const summaryLines = [
  "# 历史重判报告（M2-4）",
  "",
  `- 原报告：\`${reportPath}\`（**只读，未改写**）`,
  `- 逐条记录来源：${source}`,
  `- 记录声明的判据版本：${effectiveJudgeVersion ?? "（未声明 ⇒ legacy/provenance_unknown）"}`,
  `- 重判使用的判据版本：\`${JUDGE_VERSION}\``,
  "",
  "## 分类汇总",
  "",
  "| 分类 | 条数 | 含义 |",
  "|---|---|---|",
  `| rejudgeable | ${out.summary.rejudgeable} | 输入与回答可核实、且仅判据变化 ⇒ 已重判 |`,
  `| needs_resample | ${out.summary.needsResample} | 多轮/工具通道：模型输入或工具协议已变 ⇒ 必须新采样 |`,
  `| insufficient | ${out.summary.insufficient} | 缺原始回答或无判据 ⇒ 无法重建逐条结论 |`,
  `| 判定发生变化 | ${out.summary.changed} | 仅统计 rejudgeable（旧判定与新判定的差异条数） |`,
  `| provenance=legacy | ${out.summary.legacy} | **不得参与修复版模型排名** |`,
  "",
  ...out.summary.notes.map((n) => `> ${n}`),
  "",
  "## 逐条结果（最多列出 200 条）",
  "",
  "| 用例 | 模式 | 分类 | 旧判定 | 新判定 | 变化 | 原因 |",
  "|---|---|---|---|---|---|---|",
];
for (const r of out.rows.slice(0, 200)) {
  summaryLines.push(`| ${r.probeId} | ${r.mode} | ${r.classify} | ${r.oldVerdict ?? "—"} | ${r.newVerdict ?? "—"} | ${r.changed === true ? "**是**" : r.changed === false ? "否" : "—"} | ${r.reason.replace(/\|/g, "\\|")} |`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "rejudge.json"), JSON.stringify(out, null, 2), "utf8");
writeFileSync(join(outDir, "rejudge.md"), summaryLines.join("\n") + "\n", "utf8");

console.log(`重判完成（未改写原报告）：`);
console.log(`  记录来源：${source}`);
console.log(`  分类：rejudgeable ${out.summary.rejudgeable} / needs_resample ${out.summary.needsResample} / insufficient ${out.summary.insufficient}（变化 ${out.summary.changed}）`);
console.log(`  输出：${join(outDir, "rejudge.json")} 与 rejudge.md`);
process.exit(0);
