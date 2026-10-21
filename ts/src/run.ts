#!/usr/bin/env node
/**
 * AICGuard 一键评测入口（TypeScript 版）。
 *
 * 用法：
 *     node src/run.ts                          # 默认：农技靶子 + 完整防御
 *     node src/run.ts --profile rules          # 只开第 1 档防御
 *     node src/run.ts --expand 0               # 不用变异体，跑得更快
 *     node src/run.ts --threshold 0.5          # 调低阈值观察误报率变化
 *
 * 零依赖：只用 Node 内置模块，.ts 由 Node 原生类型剥离直接执行。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolveDataRoot, dataRootSummary } from "./data-root.ts";
import { fileURLToPath } from "node:url";

import { runAblation } from "./ablation.ts";
import { expandProbes, familyCounts, FAMILIES, loadJsonl } from "./attacks.ts";
import { DEFAULT_BUDGET_PATH, peekLedger } from "./budget.ts";
import { analyze } from "./attribution.ts";
import { AGRO_SYSTEM_PROMPT, CANARY } from "./config.ts";
import { assessCompliance } from "./compliance.ts";
import { runCorpusCompare } from "./corpusCompare.ts";
import { runEvaluation } from "./evaluate.ts";
import { buildProfile, GUARD_VERSION, PROFILE_LABELS, PROFILES, Pipeline, type ProfileName } from "./guards.ts";
import { JUDGE_VERSION } from "./judge.ts";
import { CACHE_KEY_VERSION } from "./cache.ts";
import { collectRunVersions, targetRuntimeInfo } from "./runmeta.ts";
import { TOOL_CONTRACT_VERSION } from "./targets/agentbot.ts";
import { formatCoverage, formatRate } from "./metrics.ts";
import { buildPayload, equalWeightStats, writeCasesJsonl, writeHtml, writeJson, writeMarkdown, REPO_ROOT } from "./report.ts";
import { runThresholdSweep } from "./tuning.ts";
import { AgroBot } from "./targets/agrobot.ts";
import { LlmBot, createLlmBotFromEnv } from "./targets/llmbot.ts";
import type { Probe, Target } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
// M3-4：语料根目录走唯一解析入口（显式 > 快照提交 > 工作区），并在 run 元信息里如实记录来源
const DATA_ROOT_INFO = resolveDataRoot({ repoRoot: REPO_ROOT });
const DATA_DIR = DATA_ROOT_INFO.dir;

// ============================================================ 参数

interface Args {
  target: "agro" | "llm";
  model: string;
  profile: ProfileName;
  threshold: number;
  expand: number;
  limit: number;
  benignLimit: number;
  out: string;
  quiet: boolean;
  yes: boolean;
  /** 额度账本路径（P1）；空 = 默认 `ts/runs/budget.json`（所有入口共享） */
  budget: string;
  /** 额度硬上限（HTTP 尝试次数）；0 = 不显式指定（用账本既有值 / 默认 200） */
  budgetLimit: number;
  /**
   * 采样盐（G1，`docs/40`）：缓存键的一部分，fresh 模式下即「本次实验的独立采样标识」。
   * M6 文本组的两轮采样靠它隔离缓存键——不给 salt 时两轮是同一个键，第二轮只会命中缓存。
   */
  salt: string;
}

function parseArgs(): Args {
  const a: Args = {
    target: "agro", model: "", profile: "full", threshold: 0.70, expand: -1,
    limit: 0, benignLimit: 0, out: "", quiet: false, yes: false,
    budget: "", budgetLimit: 0, salt: "",
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--target": a.target = v as Args["target"]; i++; break;
      case "--model": a.model = v; i++; break;
      case "--profile": a.profile = v as ProfileName; i++; break;
      case "--threshold": a.threshold = Number(v); i++; break;
      case "--expand": a.expand = Number(v); i++; break;
      case "--limit": a.limit = Number(v); i++; break;
      case "--benign-limit": a.benignLimit = Number(v); i++; break;
      case "--out": a.out = v; i++; break;
      case "--quiet": a.quiet = true; break;
      case "--yes": a.yes = true; break;
      case "--budget": a.budget = v; i++; break;
      case "--budget-limit": a.budgetLimit = Number(v); i++; break;
      case "--salt":
        // 自查（与 Codex 的 G2-R2 同类，本批自己的新 flag）：缺值必须报错，
        // 不得静默当成「未指定」——那会让两轮采样实际用同一个缓存键（看似两个样本，实际一个）。
        if (v === undefined || v.startsWith("--")) {
          console.error("--salt 缺少取值：写法如 --salt m6-s1（缺值会被静默当成未指定，两次采样即同一个样本）");
          process.exit(2);
        }
        a.salt = v; i++; break;
      case "--help":
        console.log("用法：node src/run.ts [--target agro|llm] [--model X] "
          + "[--profile none|rules|rules+norm|full] [--threshold 0.70] [--expand 240] "
          + "[--limit N] [--benign-limit N] [--out runs/xxx] [--yes] [--budget 文件] [--budget-limit N] [--salt 串]");
        console.log("  --salt 串          采样盐（缓存键的一部分）：不同盐 ⇒ 不同缓存键 ⇒ 都是真请求（M6 两轮独立采样用）");
        console.log("  --target llm      真实模型靶子（密钥读环境变量或 ts/.env.local）");
        console.log("  --limit N         只跑前 N 条攻击用例（轮转抽样，覆盖各攻击族）；llm 模式标定/控费用的核心参数");
        console.log("  --yes             预估请求超过软红线时仍确认执行（**不能越过额度账本的硬上限**）");
        console.log(`  --budget 文件     额度账本（默认 ts/${DEFAULT_BUDGET_PATH}）；所有入口共享同一个额度池`);
        console.log("  --budget-limit N  账本硬上限（底层 HTTP 尝试次数口径）；只能收紧已有账本，不能抬升");
        process.exit(0);
    }
  }
  if (!PROFILES[a.profile]) {
    console.error(`未知档位：${a.profile}（可选：${Object.keys(PROFILES).join(" / ")}）`);
    process.exit(2);
  }
  // llm 模式默认不开变异体：变异体是同一模板的机械重复，烧钱不出新信息
  if (a.expand < 0) a.expand = a.target === "llm" ? 0 : 240;
  if (!a.out) {
    // 形如 20261001141250，不要带上毫秒点号
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    a.out = join(TS_ROOT, "runs", stamp);
  }
  return a;
}

/** 额度账本参数（P1）：相对路径按 `ts/` 解析（不用 cwd）；runId 记本次 run 名 */
function budgetArgs(a: Args): { path: string; runId: string; limit?: number } {
  const path = a.budget
    ? (isAbsolute(a.budget) ? a.budget : join(TS_ROOT, a.budget))
    : join(TS_ROOT, DEFAULT_BUDGET_PATH);
  return { path, runId: basename(a.out), ...(a.budgetLimit > 0 ? { limit: a.budgetLimit } : {}) };
}

// ============================================================ 主流程

function main(): number {
  const args = parseArgs();

  const nativeSeeds = loadJsonl(join(DATA_DIR, "probes_zh.jsonl"));
  const mtSeeds = loadJsonl(join(DATA_DIR, "probes_mt_zh.jsonl"));
  const agroSeeds = loadJsonl(join(DATA_DIR, "probes_agro.jsonl"));

  // 编码混淆族本身已是混淆样本，不再二次混淆
  const baseSeeds = nativeSeeds.filter((p) => p.family !== "encoding_obfuscation");
  const variants = args.expand > 0 ? expandProbes(baseSeeds, args.expand) : [];
  let probes: Probe[] = [...nativeSeeds, ...variants, ...mtSeeds, ...agroSeeds];

  // --limit：轮转抽样（每族各取一条循环），保证截断后攻击族覆盖均匀，
  // 而不是只测最前面的 direct_injection。标定与控费用时使用（docs §11）。
  if (args.limit > 0 && args.limit < probes.length) {
    const buckets = [nativeSeeds, variants, mtSeeds, agroSeeds].filter((b) => b.length);
    const picked: Probe[] = [];
    const idx = buckets.map(() => 0);
    while (picked.length < args.limit) {
      let advanced = false;
      for (let b = 0; b < buckets.length && picked.length < args.limit; b++) {
        if (idx[b] < buckets[b].length) { picked.push(buckets[b][idx[b]++]); advanced = true; }
      }
      if (!advanced) break;
    }
    probes = picked;
  }

  // 正常请求（误报测试）：llm 模式每条都是真实调用，默认抽 10 条
  const benignAll = loadJsonl(join(DATA_DIR, "benign_zh.jsonl"));
  const benign: Probe[] = args.benignLimit > 0
    ? benignAll.slice(0, args.benignLimit)
    : args.target === "llm" ? benignAll.slice(0, 10) : benignAll;

  const guarded = buildProfile(args.profile, CANARY, args.threshold);

  // 真实模型靶子：密钥从环境变量或 ts/.env.local 读，缓存落盘（docs §11.2）
  let llm: LlmBot | null = null;
  let target: Target;
  if (args.target === "llm") {
    try {
      llm = createLlmBotFromEnv(AGRO_SYSTEM_PROMPT, {
        model: args.model || undefined,
        // G1（docs/40）：未给 --salt 时不传 ⇒ 空盐，行为与加该参数前完全一致
        ...(args.salt ? { salt: args.salt } : {}),
        // P1（docs/15 §5.2）：真实模型跑批一律挂硬上限账本；未给 --budget 时用环境/默认
        ...(args.budget || args.budgetLimit > 0
          ? { budget: budgetArgs(args) }
          : {}),
      });
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
    target = llm;
  } else {
    target = new AgroBot(CANARY, AGRO_SYSTEM_PROMPT);
  }

  // 预算红线（docs §11.5）：跑批前打印预估请求数；上限来自
  // 每条用例最多 2 次调用（baseline + guarded）+ 误报集。输入侧拦截会省掉
  // 靶子调用，实际数 ≤ 预估。超红线需 --yes 人工确认。
  const estRequests = probes.length * 2 + benign.length;
  if (!args.quiet) {
    console.log("=".repeat(72));
    console.log("AICGuard · 中文大模型安全评测（TypeScript）");
    console.log("=".repeat(72));
    console.log(`受测应用    : ${target.name}`);
    console.log(`防御档位    : ${PROFILE_LABELS[args.profile]}`);
    console.log(`攻击用例    : ${probes.length} 条`
      + (args.limit > 0 ? `（--limit 轮转抽样自 ${nativeSeeds.length + variants.length + mtSeeds.length + agroSeeds.length}）` : ""));
    console.log(`正常请求    : ${benign.length} 条（用于误报率）`);
    console.log(`攻击族分布  : ${Object.entries(familyCounts(probes))
      .map(([k, v]) => `${FAMILIES[k as keyof typeof FAMILIES]} ${v}`).join("、")}`);
    console.log(`拦截阈值    : ${args.threshold}`);
    if (args.target === "llm") {
      console.log(`预估请求    : ≤${estRequests} 次（含缓存去重前；**口径 = spawn**）`);
      // G1（docs/40）：采样盐必须**可见**——两轮采样是不是同一批缓存键，靠这一行对账
      console.log(`采样盐      : ${args.salt ? args.salt : "（未指定 ⇒ 空盐）"}`);
      // 硬上限在账本里（口径 = 底层 HTTP 尝试；一次 spawn 最多 3 次尝试）。
      // 账本尚未建立时**不在此创建**（只读展示），首次真实调用时才落盘。
      const b = peekLedger(budgetArgs(args).path);
      console.log(b
        ? `额度账本    : 上限 ${b.limit} 次（HTTP 尝试口径）｜已用 ${b.used}｜余 ${b.remaining}｜${b.path}`
        : `额度账本    : 尚未建立（首次真实调用时创建：${budgetArgs(args).path}，默认上限 200）`);
    }
    console.log("-".repeat(72));
  }
  if (args.target === "llm" && estRequests > 200 && !args.yes) {
    console.error(`预估 ${estRequests} 次真实 API 请求，超过 200 次软红线（docs/01 §11.5）。`);
    console.error("确认要跑请加 --yes；或用 --limit 缩小用例数。注意：--yes 只放行这道**软门**，"
      + "真正的硬上限在额度账本里（`--budget` / `--budget-limit`）——它**不会**被 --yes 越过。");
    process.exit(2);
  }

  const t0 = performance.now();
  const { results, benign: benignResults, metrics } = runEvaluation(
    probes, benign, target, guarded, CANARY, Pipeline.disabled(),
  );
  const findings = analyze(results, benignResults);
  const compliance = assessCompliance(results);
  const elapsed = performance.now() - t0;

  // 三个移植实验（T1 语料对照 / T2 阈值扫描 / T3 消融）与主评测同源：
  // 同一批用例、同一靶子、同一阈值，数字互相可比。离线靶子下毫秒级全跑；
  // 真实模型下每个实验都是全量重跑（阈值扫描 ×10、消融 ×6），默认跳过，
  // 需要时用离线靶子跑或按 docs §11 两阶段策略单独执行。
  const runExperiments = args.target !== "llm";
  const corpus = runExperiments ? runCorpusCompare({
    // 母语侧 = 母语自建 + 其混淆变体 + 农技专属（三者 source 均为 native）
    nativeProbes: [...nativeSeeds, ...variants, ...agroSeeds],
    mtProbes: mtSeeds,
    // T8：garak 真机翻对照组（文件由人工核校后生成；缺省时实验退回两组）
    garakMtProbes: existsSync(join(DATA_DIR, "probes_garak_mt.jsonl"))
      ? loadJsonl(join(DATA_DIR, "probes_garak_mt.jsonl")) : [],
    benignProbes: benign,
    target,
    canary: CANARY,
    threshold: args.threshold,
  }) : null;
  const sweep = runExperiments ? runThresholdSweep({
    probes,
    benignProbes: benign,
    target,
    canary: CANARY,
  }) : null;
  const ablation = runExperiments ? runAblation({
    probes,
    benignProbes: benign,
    target,
    canary: CANARY,
    threshold: args.threshold,
  }) : null;

  const pctS = (v: number | null) => formatRate(v, 1);
  if (!args.quiet) {
    console.log(`无防御 ASR      : ${pctS(metrics.baselineAsr)}  (${metrics.baselineBreach}/${metrics.probeTotal})`);
    console.log(`有防御 ASR      : ${pctS(metrics.guardedAsr)}  (${metrics.guardedBreach}/${metrics.probeTotal})`);
    const eqw = equalWeightStats(results);
    console.log(`无防御 ASR(等权): ${pctS(eqw.baseline_asr)}  （${eqw.families} 族等权）`);
    console.log(`有防御 ASR(等权): ${pctS(eqw.guarded_asr)}`);
    console.log(`防御有效率      : ${pctS(metrics.defenseRate)}`
      + `（配对口径：可比较 ${metrics.defensePairs.comparable}，防住 ${metrics.defensePairs.defended}，`
      + `未知 ${metrics.defensePairs.unknown}，baseline 未得手 ${metrics.defensePairs.notEligible}）`);
    console.log(`误报率          : ${pctS(metrics.falsePositiveRate)}  (${metrics.benignBlocked}/${metrics.benignEvaluated})`);
    console.log(`输入侧拦截      : ${metrics.blockedAtInput}`);
    console.log(`输出侧兜底      : ${metrics.blockedAtOutput}`);
    console.log(`无法判定        : ${metrics.unclearGuarded}（不计入 ASR 分母）`);
    console.log(`判定覆盖率      : ${formatCoverage(metrics.guardedTally.coverage)}`
      + `（确定判定 ${metrics.guardedTally.decided}/${metrics.guardedTally.attempted}）`);
    console.log(`靶子调用失败    : ${metrics.guardedTally.callErrors}（不计入分母：失败 ≠ 防住了）`);
    console.log(`平均延迟        : ${metrics.avgLatencyMs.toFixed(2)} ms`);
    console.log(`本轮耗时        : ${(elapsed / 1000).toFixed(2)} s`);
    if (llm) console.log(`真实模型用量    : ${llm.usageLine()}`);
    if (corpus && sweep && ablation) {
      console.log("-".repeat(72));
      console.log("实验模块：");
      console.log(`  语料对照    : 仅机翻规则下母语拦截率 ${pctS(corpus.rows[0].native.input_block_rate)}，`
        + `仅母语规则下 ${pctS(corpus.rows[1].native.input_block_rate)}（详见 corpus_comparison.md）`);
      console.log(`  阈值扫描    : 推荐工作点 ${sweep.recommend.threshold === null ? "不可推荐（证据不足）" : sweep.recommend.threshold.toFixed(2)}`
        + ` / 性价比拐点 ${sweep.recommend.knee ? sweep.recommend.knee.threshold.toFixed(2) : "无"}`
        + "（详见 threshold_sweep.md）");
      // 归一化层贡献：任一端不可计算就不编造百分点（M1-2c 的 null 语义）
      const g1Asr = ablation.rows[2].asr;
      const n1g1Asr = ablation.rows[3].asr;
      const contrib = (g1Asr !== null && n1g1Asr !== null)
        ? `${((g1Asr - n1g1Asr) * 100).toFixed(1)} 个百分点`
        : "不可计算（存在无确定判定的配置）";
      console.log(`  消融实验    : N1+G1 无输出兜底 ASR `
        + `${pctS(n1g1Asr)}，归一化贡献 ${contrib}（详见 ablation.md）`);
    }
    console.log("-".repeat(72));
    if (findings.length) {
      console.log(`发现 ${findings.length} 项防御缺口：`);
      for (const f of findings) {
        console.log(`  ${f.level === "high" ? "!!" : " *"} [${f.familyLabel}] ${f.title}（${f.count}/${f.total}）`);
      }
    } else {
      console.log("未发现防御缺口。");
    }
    console.log("-".repeat(72));
  }

  const runId = args.out.split(/[\\/]/).pop() || "run";
  const meta = {
    runId,
    startedAt: new Date().toISOString(),
    target: target.name,
    profile: args.profile,
    profileLabel: PROFILE_LABELS[args.profile],
    guardsEnabled: guarded.enabledGuards,
    threshold: args.threshold,
    // 来源与可复现性（M2-2）：代码 SHA / 语料哈希 / 护栏与判据版本 / 工具契约 / 缓存键版本
    versions: collectRunVersions({
      repoRoot: REPO_ROOT,
      dataDir: DATA_DIR,
      guardVersion: GUARD_VERSION,
      judgeVersion: JUDGE_VERSION,
      toolContractVersion: TOOL_CONTRACT_VERSION,
      cacheKeyVersion: CACHE_KEY_VERSION,
      // M3-4：语料来自不可变快照时记下提交 id（未启用则为空，报告只说“工作区”）
      ...(DATA_ROOT_INFO.commitId ? { snapshotCommitId: DATA_ROOT_INFO.commitId } : {}),
    }),
    runtime: { node: process.version, platform: process.platform },
    // 目标身份与计数（离线靶子不提供模型身份与采样参数；不含密钥）
    targetRuntime: targetRuntimeInfo(target),
  };

  const payload = buildPayload(meta, metrics, results, benignResults, findings);
  // 看板已预留 renderCorpus / renderSweep，读取 DATA.corpus / DATA.sweep
  if (corpus) {
    payload.corpus = {
      rows: corpus.rows,
      native_total: corpus.nativeTotal,
      mt_total: corpus.mtTotal,
      garak_total: corpus.garakTotal,
    };
  }
  if (sweep) {
    payload.sweep = {
      rows: sweep.rows,
      recommend: {
        threshold: sweep.recommend.threshold,
        reason: sweep.recommend.reason,
        ...(sweep.recommend.note ? { note: sweep.recommend.note } : {}),
      },
    };
  }
  // 看板预留的合规整改建议区块（renderCompliance）
  payload.compliance = {
    items: compliance.items,
    summary: compliance.summary,
  };
  mkdirSync(args.out, { recursive: true });

  const jsonPath = writeJson(payload, join(args.out, "report.json"));
  // 逐条证据（M2-4）：含未攻破样本，使未来的判据重判能覆盖正反两面
  const casesPath = writeCasesJsonl(results, join(args.out, "cases.jsonl"));
  const mdPath = writeMarkdown(meta, metrics, results, benignResults, findings, join(args.out, "report.md"), compliance);
  if (corpus) writeFileSync(join(args.out, "corpus_comparison.md"), corpus.markdown, "utf8");
  if (sweep) writeFileSync(join(args.out, "threshold_sweep.md"), sweep.markdown, "utf8");
  if (ablation) writeFileSync(join(args.out, "ablation.md"), ablation.markdown, "utf8");

  let htmlPath = "";
  try {
    htmlPath = writeHtml(payload, join(args.out, "dashboard.html"));
  } catch (e) {
    console.warn(`  看板生成跳过：${(e as Error).message}`);
  }

  if (!args.quiet) {
    console.log("报告已生成：");
    console.log(`  JSON        : ${jsonPath}`);
    console.log(`  Markdown    : ${mdPath}`);
    console.log(`  逐条证据    : ${casesPath}   ← M2-4：含未攻破样本，供判据重判`);
    if (runExperiments) console.log(`  实验报告    : corpus_comparison.md / threshold_sweep.md / ablation.md（同目录）`);
    if (htmlPath) console.log(`  演示看板    : ${htmlPath}   ← 双击打开`);
    console.log("=".repeat(72));
  }

  // 供 CI / 脚本判断：有完全失守时返回 1
  return findings.some((f) => f.level === "high") ? 1 : 0;
}

process.exit(main());
