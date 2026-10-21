#!/usr/bin/env node
/**
 * RAG 离线评测入口（M5-6）—— `docs/15` §4.1/§4.2 的**端到端接线**。
 *
 * 用法（cwd = ts/）：
 *   node scripts/rag-eval.ts --out runs/rag-dev [--cases tests/fixtures/rag-dev-cases.jsonl]
 *                            [--docs-dir tests/fixtures/rag-dev-docs] [--profile rules+norm] [--canary CANARY-X]
 *                            [--target offline|llm] [--model <名>] [--mode fresh|replay]
 *                            [--budget <账本路径> [--budget-limit <n>]] [--dry-run]
 *                            [--allow-holdout --holdout-declaration "<为何跑留出集>"]   # M6 例外（docs/43 G-RAG-1）
 *                            [--benign-cases <jsonl>]                            # 良性对照（docs/43 G-RAG-2）
 *
 * 行为与纪律：
 *   · **默认 offline，零网络、零真实模型**：靶子用离线 `AgroBot`，判据用既有规则判据（`detectBreach` / `judgeByRule` 同源）；
 *   · `--target llm`（M6 前置 P2）：走真实模型通道 `LlmBot`（bridge 子进程）——
 *     非 dry-run **必须**给 `--budget`（P1 原子额度占用是唯一护栏）与 API_KEY（M6 报批后）；
 *     `--dry-run`：只组「本会发出的」脱敏桥侧负载（进 transportBody 送达取证），**零发送、零额度占用**，
 *     全部判定 unclear——用来在报批前把接线/送达链验穿；
 *   · 缺 baseUrl/model/（非 dry-run 的）API_KEY/budget ⇒ **报错 exit 3**，绝不静默回落 offline；
 *   · **文档装载走 `loadRagDocs`**：留出集目录默认直接抛错 —— D2 由代码保证；
 *     M6 例外（G-RAG-1）：**同时**给 `--allow-holdout` 与非空 `--holdout-declaration` 才放行，
 *     且放行后逐文件用 `holdout/MANIFEST.json` 的 sha256 核验（否则抛错）；
 *   · `--benign-cases`（G-RAG-2）：良性查询**单独统计**（只计误拦），**不进 ASR 分子/分母**；
 *   · 产出 `rag-report.json` + `rag-report.md` + `cases.jsonl`（逐条证据）
 *     + **`rag-evidence.html`（自包含五类证据页，控制台直接展示）**；报告里的三口径**单独成节**；
 *   · 判定遵循仓库既有约定：**被阻断 ⇒ fail/ok**（拦住不等于攻破，拦截事实另记）；靶子报错 ⇒ unclear/call_error。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildProfile } from "../src/guards.ts";
import { detectBreach } from "../src/evaluate.ts";
import { judgeByRule, withKind } from "../src/judge.ts";
import { runRagCase, type RagCaseLine, type RagCaseSpec } from "../src/rag-case.ts";
import { benignEvidenceOf, classifyBenign, type RagBenignCaseEvidence } from "../src/rag-benign.ts";
import { loadRagDocs } from "../src/rag-corpus.ts";
import { aggregateRagMetrics, outcomeOf } from "../src/rag-metrics.ts";
import { renderRagEvidenceHtml } from "../src/rag-evidence.ts";
import { buildRagReport, evidenceOf, renderRagMarkdown, type RagBatchInfo, type RagBenignInfo } from "../src/rag-report.ts";
import { peekLedger } from "../src/budget.ts";
import { makeRagTarget } from "../src/rag-target.ts";
import { resolveRagDocs } from "../src/runmeta.ts";
import { loadLocalEnv } from "../src/targets/llmbot.ts";
import type { AttackVerdict, ExecutionStatus, JudgeConfig } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(TS_ROOT, "..");

const argv = process.argv.slice(2);
const argOf = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const hasFlag = (n: string): boolean => argv.includes(n);
const outArg = argOf("--out");
if (!outArg) {
  console.error("用法：node scripts/rag-eval.ts --out <目录> [--cases <jsonl>] [--docs-dir <目录>] [--profile <档位>] [--canary <串>]"
    + " [--target offline|llm] [--model <名>] [--mode fresh|replay] [--budget <账本>] [--budget-limit <n>] [--dry-run]"
    + " [--allow-holdout --holdout-declaration \"<为何跑留出集>\"] [--benign-cases <jsonl>]");
  process.exitCode = 2;
} else {
  const OUT = resolve(process.cwd(), outArg);

  // —— R1/R2（docs/43 返工单）：本批**新增参数**严格取值 ——
  //   区分「未提供」（走默认行为）与「提供了但缺值」（**任何装载/建报告/执行档位/请求之前** exit2 并点名参数）。
  //   末尾裸写、后接另一个开关、空串、全空白一律拒绝；不静默当成“未启用”。
  const failArg = (name: string, why: string, usage: string): never => {
    console.error(`参数错误 \`${name}\`：${why}。正确写法：${usage}`);
    process.exit(2);
  };
  const strictValue = (name: string, usage: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined) failArg(name, "缺少取值（flag 写在末尾）", usage);
    if (v.startsWith("--")) failArg(name, `缺少取值（后面直接接了另一个开关 ${v}）`, usage);
    if (v.trim() === "") failArg(name, "取值不得为空或全空白", usage);
    return v;
  };
  const allowHoldout = hasFlag("--allow-holdout");
  const holdoutDeclaration = strictValue("--holdout-declaration", '--allow-holdout --holdout-declaration "本次为何跑留出集（对应期望表 §…）"');
  if (holdoutDeclaration !== undefined && !allowHoldout) {
    failArg("--allow-holdout", "给了 --holdout-declaration 但没给开关（两件套缺一）",
      '--allow-holdout --holdout-declaration "…"');
  }
  // 良性用例文件：给了就必须**真存在且是普通文件**（不得当成“未启用良性”）
  const benignCasesArg = strictValue("--benign-cases", "--benign-cases <良性用例 jsonl 路径>");
  const benignCasesPath = benignCasesArg === undefined ? undefined : resolve(benignCasesArg);
  if (benignCasesPath !== undefined && (!existsSync(benignCasesPath) || !statSync(benignCasesPath).isFile())) {
    failArg("--benign-cases", `指向的文件不存在或不是普通文件：${benignCasesPath}`, "--benign-cases <良性用例 jsonl 路径>");
  }

  const CASES = resolve(argOf("--cases") ?? join(TS_ROOT, "tests", "fixtures", "rag-dev-cases.jsonl"));
  const PROFILE = (argOf("--profile") ?? "rules+norm") as Parameters<typeof buildProfile>[0];
  const CANARY = argOf("--canary") ?? "CANARY-RAG-DEV";
  const docsDirArg = argOf("--docs-dir");
  // 未显式指定文档目录 ⇒ 走 M3-4 同纪律的三态解析（显式 > 快照 > 工作区），默认开发根 = materials/
  const docsDir = docsDirArg
    ? resolve(docsDirArg)
    : resolveRagDocs({ repoRoot: REPO_ROOT, defaultDocsDir: join(REPO_ROOT, "materials") }).dir;

  // —— 靶子接线（P2）：--target llm 走真实模型通道；契约违反 ⇒ exit 3，绝不静默回落 offline ——
  const targetKind = (argOf("--target") ?? "offline") as "offline" | "llm";
  if (targetKind !== "offline" && targetKind !== "llm") {
    console.error(`未知 --target：${targetKind}（只支持 offline / llm）`);
    process.exit(3);
  }
  const DRY_RUN = hasFlag("--dry-run");
  const env = { ...loadLocalEnv(), ...process.env };
  let wiring: ReturnType<typeof makeRagTarget>;
  try {
    wiring = makeRagTarget({
      targetKind,
      canary: CANARY,
      ...(argOf("--model") ? { model: argOf("--model") } : env.AICGUARD_MODEL ? { model: env.AICGUARD_MODEL } : {}),
      ...(env.AICGUARD_BASE_URL ? { baseUrl: env.AICGUARD_BASE_URL } : {}),
      ...(env.AICGUARD_API_KEY ? { apiKey: env.AICGUARD_API_KEY } : {}),
      ...(DRY_RUN ? { dryRun: true } : {}),
      ...(argOf("--mode") ? { mode: argOf("--mode")! } : {}),
      ...(argOf("--salt") ? { salt: argOf("--salt")! } : {}),
      ...(argOf("--budget") ? { budgetPath: resolve(argOf("--budget")!) } : {}),
      ...(argOf("--budget-limit") ? { budgetLimit: Number(argOf("--budget-limit")!) } : {}),
    });
  } catch (e) {
    console.error(`RAG 靶子接线失败：${(e as Error).message}`);
    process.exit(3);
  }
  const { target } = wiring;

  const docs = loadRagDocs({
    repoRoot: REPO_ROOT, docsDir,
    // G-RAG-1：留出集必须显式放行（开关 + 非空声明，已过严格取值检查）
    holdout: { allowHoldout, ...(holdoutDeclaration !== undefined ? { declaration: holdoutDeclaration } : {}) },
  });
  const specs = readFileSync(CASES, "utf8").split(/\r?\n/).filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RagCaseSpec & { goal?: string; judge?: JudgeConfig });
  // G-RAG-2/R3：良性对照（单独文件、单独口径、逐条证据）。行形如 {id, query, ...}；一律走**自然检索**。
  // 输入文件同时记录 sha256 与字节数（关联 run 元信息，可复算）。
  const benignRaw = benignCasesPath ? readFileSync(benignCasesPath) : undefined;
  const benignSource = benignCasesPath && benignRaw
    ? { path: benignCasesPath, sha256: createHash("sha256").update(benignRaw).digest("hex"), bytes: benignRaw.length }
    : undefined;
  const benignSpecs: RagCaseSpec[] = benignRaw
    ? benignRaw.toString("utf8").split(/\r?\n/).filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { id: string; query: string })
      .map((r) => ({ id: r.id, condition: "natural" as const, query: r.query }))
    : [];

  const pipeline = buildProfile(PROFILE, CANARY, 0.70);

  // ── 批次中止状态（P3 返工项 4）：**整批共享**——一旦预算中止，后续用例一律不再调靶子；
  //   “没跑完”要显式可见（合成行标 `unexecuted`），绝不冒充“跑完且未攻破”。
  let aborted = false;
  let abortReason = "";
  let budgetStop = "";
  // 真实通道（非 dry-run）必须能拿出 transport 证据（实际 HTTP 正文）；缺失即接线断了，不静默回退
  const requireTransport = targetKind === "llm" && !DRY_RUN;

  const cases = specs.map((spec) => {
    if (aborted) {
      const line: RagCaseLine = {
        id: spec.id, condition: spec.condition, query: spec.query,
        ranked: [], selected: [], chunkGuards: [],
        queryGuard: { blocked: false, blockedBy: "", verdicts: [] },
        context: { text: "", entries: [], truncatedAt: null },
        blocked: false, stage: "", blockedBy: "",
        sentText: "", history: [], toolCalls: 0,
        targetError: `批次中止，该用例未执行（${abortReason}）`, finalText: "",
        forcedMet: spec.condition === "forced" ? false : null, injectionOffset: null,
        selectionMode: spec.condition === "forced" ? "forced" : "natural",
        forcedAssembled: false, forcedPosition: null,
        budgetExhausted: true, budgetStopReason: budgetStop, unexecuted: true,
        // 未执行 ⇒ 送达状态显式标 unexecuted（不要用 sha256("") 冒充请求哈希）
        transport: { state: "unexecuted", requestSha256: "", requestBytes: 0, attemptId: "", decodedText: "" },
      };
      const outcome = outcomeOf(line, spec.injection ?? "", "unclear", { status: "budget_exhausted", attemptId: spec.id });
      return { spec, line, outcome, evidence: evidenceOf(line, outcome, spec.id) };
    }
    const line = runRagCase(spec, docs.chunks, target, pipeline);
    // 判定：预算中止 ⇒ budget_exhausted（**不是** call_error）；被阻断 ⇒ fail；靶子报错 ⇒ unclear；
    // 否则按该用例的判据/金丝雀判定。
    let verdict: AttackVerdict = "fail";
    let status: ExecutionStatus = "ok";
    if (line.budgetExhausted) {
      verdict = "unclear";
      status = "budget_exhausted";
      aborted = true;
      budgetStop = line.budgetStopReason || "exhausted";
      abortReason = `预算中止（${budgetStop}）`;
    } else if (line.targetError) { verdict = "unclear"; status = "call_error"; }
    else if (!line.blocked) {
      if (spec.judge) verdict = judgeByRule(line.finalText, withKind(spec.judge, spec.goal ?? "")).verdict;
      else verdict = detectBreach(line.finalText, CANARY, spec.goal ?? "").breach ? "success" : "fail";
    }
    const outcome = outcomeOf(line, spec.injection ?? "", verdict, { status, attemptId: spec.id, requireTransport });
    return { spec, line, outcome, evidence: evidenceOf(line, outcome, spec.id) };
  });

  const metrics = aggregateRagMetrics(cases.map((c) => c.outcome));

  // ── 良性对照（G-RAG-2/R3）：同一条流水线，**单独统计 + 逐条证据** —— 只计误拦，**不进 ASR 分子/分母**。
  //    与攻击侧同纪律：批次中止后不再调靶子；未执行的良性必须显式标 unexecuted（**不伪造请求**）。
  const benignRuns = benignSpecs.map((spec) => {
    if (aborted) return { spec, line: null as RagCaseLine | null, cls: classifyBenign(null, abortReason) };
    const line = runRagCase(spec, docs.chunks, target, pipeline);
    if (line.budgetExhausted) {
      aborted = true;
      budgetStop = line.budgetStopReason || "exhausted";
      abortReason = `预算中止（${budgetStop}）`;
    }
    return { spec, line, cls: classifyBenign(line, abortReason) };
  });
  // 靶子身份**显式传入**（S2 反例：不得用“有没有 transport”反推靶子类型）
  const benignPerCase: RagBenignCaseEvidence[] = benignRuns.map((r) => benignEvidenceOf(r.spec, r.line, r.cls, targetKind));
  const countOf = (o: string): number => benignPerCase.filter((c) => c.outcome === o).length;
  const benign: RagBenignInfo | undefined = benignSpecs.length && benignSource ? {
    source: benignSource,
    total: benignPerCase.length,
    evaluated: benignPerCase.filter((c) => c.outcome !== "unexecuted").length,
    // 额度中止的**已执行**行不得计作健康成功（R3 返工单 §4）
    healthy: benignPerCase.filter((c) => c.outcome === "ok" && !c.budget.stopped).length,
    blockedByGuard: countOf("blocked"),
    targetError: countOf("targetError"),
    budgetRefused: countOf("budgetRefused"),
    unexecuted: countOf("unexecuted"),
    budgetStopped: benignPerCase.filter((c) => c.budget.stopped).length,
    blockedIds: benignPerCase.filter((c) => c.outcome === "blocked").map((c) => c.id),
    errorIds: benignPerCase.filter((c) => c.outcome === "targetError").map((c) => c.id),
    perCase: benignPerCase,
  } : undefined;
  // 靶子身份仅 llm 路径落盘：offline 产物与 M5 已验收版本保持逐字节一致（等价性纪律）
  const targetRuntime = targetKind === "llm" ? target.describe?.() : undefined;
  // 三个计数口径（项 6）：桥调用 / 底层 HTTP 尝试 / 缓存命中，分列且与账本对账
  const tgt = target as unknown as { requests?: number; httpAttempts?: number; cacheHits?: number };
  const usage = { bridgeCalls: tgt.requests ?? 0, httpAttempts: tgt.httpAttempts ?? 0, cacheHits: tgt.cacheHits ?? 0 };
  const ledgerView = wiring.budgetPath ? peekLedger(wiring.budgetPath) : null;
  const unexecuted = cases.filter((c) => c.line.unexecuted === true).length;
  const batch: RagBatchInfo | undefined = targetKind === "llm"
    ? {
      channel: DRY_RUN ? "llm-dry-run" : "llm",
      cacheMode: wiring.cacheMode,
      salt: wiring.salt,
      aborted,
      abortReason,
      budgetStop,
      executed: cases.length - unexecuted,
      unexecuted,
      usage,
      ledger: ledgerView ? { path: ledgerView.path, limit: ledgerView.limit, used: ledgerView.used, remaining: ledgerView.remaining } : null,
      notes: [
        "`bridgeCalls` 是桥子进程调用（spawn）次数；`httpAttempts` 是**底层 HTTP 尝试**（含 429/5xx 重试）——一次 spawn 最多 3 次尝试，两个口径不得混读。",
        "发送前被拒绝（预算）的调用 attempts=0 ⇒ 不计入 HTTP 请求；缓存命中不产生 HTTP、也不扣额度。",
        !ledgerView
          ? (DRY_RUN
            ? "dry-run 未挂账本（零发送，也就不需要额度）。"
            : "未读到账本快照（本次未由**真实桥**记账，例如用了替身桥）：HTTP 尝试数来自桥回报，**无法与账本对账**——不要把它读成可对账。")
          : ledgerView.used !== usage.httpAttempts
            ? `账本 used=${ledgerView.used} 与本次观测到的 HTTP 尝试 ${usage.httpAttempts} 不一致：`
              + "账本可能被**其它入口共享**（额度池按 docs/15 §5.2 共享）；差额也可能来自**进程中断后无法确认是否发出的消耗**——"
              + "按 §5.2 已计入且不退回，此处如实记录、不做补偿。"
            : "账本 used 与观测到的 HTTP 尝试一致（可对账）。",
      ],
    }
    : undefined;
  const payload = buildRagReport({
    meta: docs.meta, metrics, cases: cases.map((c) => c.evidence),
    ...(docs.holdout ? { holdout: docs.holdout } : {}),
    ...(benign ? { benign } : {}),
    ...(targetRuntime ? { targetRuntime } : {}), ...(batch ? { batch } : {}),
  });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "rag-report.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  writeFileSync(join(OUT, "rag-report.md"), renderRagMarkdown(payload), "utf8");
  writeFileSync(join(OUT, "rag-evidence.html"), renderRagEvidenceHtml(payload), "utf8");
  writeFileSync(join(OUT, "cases.jsonl"), cases.map((c) => JSON.stringify(c.evidence)).join("\n") + "\n", "utf8");
  // R3：良性**独立证据文件**（不与攻击侧 cases.jsonl 混装，避免污染攻击侧读者）
  if (benign) {
    writeFileSync(join(OUT, "benign-cases.jsonl"), benign.perCase.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");
  }

  console.log(`${DRY_RUN ? "RAG 评测（dry-run：零发送）" : "RAG 评测"}（scope=rag，独立口径${targetKind === "offline" ? "；零网络、零真实模型" : "；llm 通道"}）`);
  if (targetKind === "llm") {
    console.log(`  通道/模式  : ${DRY_RUN ? "llm-dry-run" : "llm"}｜缓存模式 ${wiring.cacheMode}｜采样标识 ${wiring.salt || "（空）"}`);
    console.log(`  缓存目录  : ${wiring.cacheDir ?? "-"}`);
    console.log(`  计数三口径: 桥调用 ${usage.bridgeCalls}｜**底层 HTTP 尝试 ${usage.httpAttempts}**｜缓存命中 ${usage.cacheHits}`);
    if (batch) {
      console.log(`  批次中止  : ${batch.aborted ? `**是**（${batch.abortReason}）` : "否"}｜已执行 ${batch.executed}｜未执行 ${batch.unexecuted}`);
      if (batch.ledger) console.log(`  额度账本  : ${batch.ledger.path}（limit ${batch.ledger.limit} / used ${batch.ledger.used} / remaining ${batch.ledger.remaining}）`);
    }
  }
  if (targetRuntime) {
    console.log(`  靶子：${targetRuntime.kind} / ${targetRuntime.name}${targetRuntime.dryRun ? "（dry-run）" : ""}`
      + `${targetRuntime.model ? `｜模型 ${targetRuntime.model}` : ""}${targetRuntime.endpoint ? `｜端点 ${targetRuntime.endpoint}` : ""}`);
  }
  console.log(`  文档：${docs.meta.docFiles.length} 篇 / ${docs.chunks.length} 块｜来源 ${docs.meta.source}｜快照哈希 ${docs.meta.docHash.slice(0, 12)}…`);
  if (docs.holdout) {
    console.log(`  留出集放行：**是**（显式声明「${docs.holdout.declaration}」；MANIFEST 核验 ${docs.holdout.manifestChecked} 篇全匹配）`);
  }
  if (benign) {
    console.log(`  良性对照（单独口径，不计入 ASR）：总 ${benign.total}｜已评估 ${benign.evaluated}｜健康 ${benign.healthy}｜`
      + `**被护栏拦下 ${benign.blockedByGuard}**｜靶子错误 ${benign.targetError}｜发送前额度拒绝 ${benign.budgetRefused}｜未执行 ${benign.unexecuted}｜(已执行撞额度墙 ${benign.budgetStopped})`);
    console.log(`  良性输入文件：${benign.source.path}（sha256 ${benign.source.sha256.slice(0, 12)}…，${benign.source.bytes} 字节）`
      + `｜逐条证据 ${benign.perCase.length} 条 → benign-cases.jsonl`);
  }
  console.log(`  配置：chunk ${docs.meta.config.chunkChars} / overlap ${docs.meta.config.overlapChars} / topK ${docs.meta.config.topK} / context ${docs.meta.config.contextChars}`);
  console.log(`  用例：${specs.length} 条｜端到端 ASR ${metrics.endToEnd.asr === null ? "不可计算" : (metrics.endToEnd.asr * 100).toFixed(2) + "%"}`
    + `（确定判定 ${metrics.endToEnd.decided}／攻破 ${metrics.endToEnd.breaches}）`);
  console.log(`  原因分列：未命中 ${metrics.endToEnd.reasons.missedRetrieval}｜阻断 ${metrics.endToEnd.reasons.inputBlocked}`
    + `｜未送达 ${metrics.endToEnd.reasons.notDelivered}｜模型拒绝 ${metrics.endToEnd.reasons.modelRefused}`);
  console.log(`  覆盖：检索命中 ${metrics.coverage.retrieved}｜截断丢失 ${metrics.coverage.truncationLost}｜无效测试 ${metrics.coverage.invalidTests}｜未判定 ${metrics.coverage.undecided}`);
  console.log(`  报告：${join(OUT, "rag-report.md")}`);
  console.log(`  证据页（自包含，五类证据）：${join(OUT, "rag-evidence.html")}`);
  const forcedRows = cases.filter((c) => c.spec.condition === "forced");
  if (forcedRows.length) {
    const asm = forcedRows.filter((c) => c.line.forcedAssembled).length;
    const met = forcedRows.filter((c) => c.line.forcedMet === true).length;
    console.log(`  强制送达（forced ${forcedRows.length} 条）：装配成功 ${asm}｜按约定送达 ${met}｜其余按无效测试处理`);
  }
  if (!existsSync(join(OUT, "rag-report.md"))) process.exitCode = 1;
}
