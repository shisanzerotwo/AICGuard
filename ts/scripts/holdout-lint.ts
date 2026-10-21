#!/usr/bin/env node
/**
 * M4-1 · 留出集防泄漏与卫生检查器（**只读**，零模型调用）
 *
 * 契约：`holdout/spec.md` §3（防泄漏口径与阈值依据）、§4（隔离断言）；
 *       任务卡 `docs/29-M4任务卡（冻结实验）.md` §3 M4-1。
 *
 * 做四件事：
 *   ① 隔离断言：`holdout/` 不在 `data/` 下；通用入口禁引用；RAG 显式例外检查真实 CLI 行为（docs/43）。
 *   ② 卫生：LF 行尾 / 无 BOM / 无空行 / 无密钥形态 / pairId 唯一 / 每对恰好 1 母语 + 1 译文 / 六族各 5 对。
 *   ③ 防泄漏：逐条算字符二元组**包含度**（holdout ⊆ dev），超阈即失败/警告；与全部开发语料比较（跨语言单列）。
 *   ④ 自证非恒真（阳性/阴性对照）：把一条开发原文喂进去**必须**被判定为泄漏，一条无关文本**必须**不被判泄漏。
 *
 * 用法（cwd = ts/）：
 *   node scripts/holdout-lint.ts [--dev ..\data] [--holdout ..\holdout] [--max-overlap 0.65]
 *                               [--warn-overlap 0.5] [--out ..\holdout\reports\leakage-report]
 * 退出码：0 = 全部通过（含"留出集尚未产出"的空态）；1 = 有违规；2 = 参数/IO 错误。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRagEntryIsolation } from "./rag-isolation-check.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(TS_ROOT, "..");

/** 六类文本族（holdout/spec.md §2） */
const SIX_FAMILIES = [
  "direct_injection", "indirect_injection", "roleplay_jailbreak",
  "encoding_obfuscation", "multi_turn_induction", "data_exfiltration",
] as const;

/** 隔离断言要扫的评测/门禁入口（spec §4；不含 M4 自己的两个工具） */
const ENTRY_POINTS = [
  "src/run.ts", "src/server.ts", "scripts/agent-eval.ts", "scripts/fp-regression.ts",
  "scripts/harness-sanity.ts", "scripts/llm-leaderboard.ts", "scripts/llm-multisample.ts",
  "scripts/workloop-eval.ts", "scripts/rejudge.ts", "scripts/m0-check.ts",
  // RAG 入口保留扫描记录；M6 显式例外另跑真实 CLI 隔离检查，不再把授权参数名当隐式读取。
  "scripts/rag-eval.ts",
  "package.json",
];

// ── 参数 ─────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const devDir = resolve(argOf("--dev") ?? join(REPO_ROOT, "data"));
const holdoutDir = resolve(argOf("--holdout") ?? join(REPO_ROOT, "holdout"));
const maxOverlap = Number(argOf("--max-overlap") ?? 0.45);
const warnOverlap = Number(argOf("--warn-overlap") ?? 0.3);
const outStem = argOf("--out");
const skipSelfTest = argv.includes("--no-self-test");
/** M4-2 分阶段验收用：译文侧尚未产出时（M4-3 未开工），"每对缺译文"降为提示而非违规 */
const allowUntranslated = argv.includes("--allow-untranslated");
/**
 * M5/M6 收口门用（M4 复核发现 B-4）：默认允许「留出集尚未产出」时 exit 0（M4-2 阶段需要），
 * 但那会让**路径拼错 = 静默全绿**。加此开关后：必须存在 `text/pairs.jsonl`，
 * 且若存在 `MANIFEST.json` 则**逐文件核对存在性与 sha256**（冻结自证）——任一不满足即违规。
 */
const requireHoldout = argv.includes("--require-holdout");

// ── 工具 ─────────────────────────────────────────────────────
/** 规范化：只留字母/数字（去空白与标点，含中文标点），再小写 */
const norm = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

/** 字符二元组集合（长度 <2 时退化为整体） */
function bigrams(s: string): Set<string> {
  const g = new Set<string>();
  if (s.length < 2) { if (s) g.add(s); return g; }
  for (let i = 0; i + 1 < s.length; i++) g.add(s.slice(i, i + 2));
  return g;
}

/** 包含度：|A ∩ B| / |A|（A = 留出条目，B = 开发条目） */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

interface DevItem { file: string; id: string; family: string; text: string; grams: Set<string> }
function loadDev(dir: string): DevItem[] {
  const items: DevItem[] = [];
  if (!existsSync(dir)) return items;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
    const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/).filter((l) => l.trim());
    for (const l of lines) {
      let o: Record<string, unknown>;
      try { o = JSON.parse(l) as Record<string, unknown>; } catch { continue; }
      const text = String(o.text ?? "");
      if (!text) continue;
      items.push({ file: f, id: String(o.id ?? "?"), family: String(o.family ?? "?"), text, grams: bigrams(norm(text)) });
    }
  }
  return items;
}

interface HoldoutRow { line: number; raw: string; rec: Record<string, unknown> }
function loadJsonlRaw(path: string): { rows: HoldoutRow[]; hasBom: boolean; hasCrlf: boolean; blank: number } {
  const buf = readFileSync(path);
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const txtRaw = buf.toString("utf8").replace(/^\uFEFF/, "");
  const hasCrlf = /\r\n/.test(txtRaw);
  const rows: HoldoutRow[] = [];
  let blank = 0;
  const parts = txtRaw.split(/\n/);
  // 文末的常规换行是行终止符，不是"空行"（否则任何以 \n 结尾的正常文件都会被误报）
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  parts.forEach((raw, i) => {
    if (!raw.trim()) { blank++; return; }
    let rec: Record<string, unknown> | null = null;
    try { rec = JSON.parse(raw) as Record<string, unknown>; } catch { rec = null; }
    rows.push({ line: i + 1, raw, rec: rec ?? {} });
  });
  return { rows, hasBom, hasCrlf, blank };
}

/** 密钥形态（沿用仓库既有口径：sk- 长串 / Authorization Bearer / 明显 key 赋值） */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /authorization\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._-]{16,}/gi,
  /(api[_-]?key|secret|token)\s*[:=]\s*["'][A-Za-z0-9._-]{20,}["']/gi,
];
function secretHits(s: string): string[] {
  const hits: string[] = [];
  for (const re of SECRET_PATTERNS) { const m = s.match(re); if (m) hits.push(...m.map((x) => x.slice(0, 12) + "…")); }
  return hits;
}

// ── 检查 ─────────────────────────────────────────────────────
const violations: string[] = [];
const warnings: string[] = [];
const notes: string[] = [];

/** ① 隔离断言 */
function checkIsolation() {
  const rel = (p: string) => p.replace(/\\/g, "/");
  const inData = rel(holdoutDir).startsWith(rel(devDir) + "/") || rel(holdoutDir) === rel(devDir);
  if (inData) violations.push(`隔离：留出集位于开发语料目录之下（${rel(holdoutDir)} 在 ${rel(devDir)} 下），违反 spec §4-1`);
  const refs: Array<{ file: string; hits: number }> = [];
  for (const f of ENTRY_POINTS) {
    const p = join(TS_ROOT, f);
    if (!existsSync(p)) continue;
    const n = (readFileSync(p, "utf8").match(/holdout/gi) ?? []).length;
    if (n > 0) refs.push({ file: f, hits: n });
  }
  const implicitRefs = refs.filter(r => r.file !== "scripts/rag-eval.ts");
  if (implicitRefs.length) violations.push(`隔离：评测/门禁入口引用了 holdout ⇒ ${implicitRefs.map((r) => `${r.file}(${r.hits})`).join(", ")}（spec §4-2）`);
  const ragEntry = checkRagEntryIsolation(TS_ROOT);
  if (!ragEntry.pass) violations.push(`隔离：RAG 显式例外契约失败 ⇒ ${ragEntry.checks.filter(c => !c.pass).map(c => c.name).join(", ") || ragEntry.error}（docs/43 G-RAG-1）`);
  return { holdoutUnderData: inData, entryPointRefs: refs, entryPointsScanned: ENTRY_POINTS.length, ragEntry };
}

/** ② 卫生 + 配对 + 族分布 */
function checkHygiene(pairsPath: string): Record<string, unknown> {
  const { rows, hasBom, hasCrlf, blank } = loadJsonlRaw(pairsPath);
  if (hasBom) violations.push("卫生：pairs.jsonl 含 BOM");
  if (hasCrlf) violations.push("卫生：pairs.jsonl 含 CRLF（仓库统一 LF）");
  if (blank > 0) violations.push(`卫生：pairs.jsonl 含 ${blank} 个空行`);

  const bad: number[] = [];
  const secrets: string[] = [];
  for (const r of rows) {
    if (!r.rec || typeof r.rec.pairId !== "string") { bad.push(r.line); continue; }
    const h = secretHits(r.raw);
    if (h.length) secrets.push(`L${r.line}: ${h.join(",")}`);
  }
  if (bad.length) violations.push(`卫生：第 ${bad.slice(0, 10).join(",")} 行缺 pairId 或 JSON 解析失败`);
  if (secrets.length) violations.push(`卫生：检出密钥形态 ⇒ ${secrets.slice(0, 5).join(" | ")}`);

  const byPair = new Map<string, { native: number; translation: number; originalEn: number; family?: string }>();
  for (const r of rows) {
    const id = typeof r.rec.pairId === "string" ? r.rec.pairId : null;
    if (!id) continue;
    const e = byPair.get(id) ?? { native: 0, translation: 0, originalEn: 0 };
    if (r.rec.side === "native") { e.native++; e.family = String(r.rec.family ?? e.family ?? "?"); }
    else if (r.rec.side === "original-en") e.originalEn++;
    else if (r.rec.side === "translation") e.translation++;
    else violations.push(`卫生：${id} 的 side 非法（${String(r.rec.side)}；合法值 native/original-en/translation）`);
    byPair.set(id, e);
  }
  // 三段式（M4-3 方向裁定后）：每对 = 母语侧(native) + 英文原文(original-en) + 译文侧(translation)
  // 前两段是**硬要求**；译文侧在 --allow-untranslated（M4-2/2b 阶段）下降级为提示。
  const missingSource = [...byPair.entries()].filter(([, e]) => e.native !== 1 || e.originalEn !== 1)
    .map(([id, e]) => `${id}(native=${e.native},original-en=${e.originalEn})`);
  if (missingSource.length) {
    violations.push(`配对：以下 pairId 母语侧/英文原文侧不是各 1 条 ⇒ ${missingSource.slice(0, 10).join(", ")}`);
  }
  const unpaired = [...byPair.entries()].filter(([, e]) => e.translation !== 1)
    .map(([id, e]) => `${id}(translation=${e.translation})`);
  if (allowUntranslated) {
    const tooMany = [...byPair.entries()].filter(([, e]) => e.translation > 1)
      .map(([id, e]) => `${id}(translation=${e.translation})`);
    if (tooMany.length) violations.push(`配对：译文侧多于 1 条 ⇒ ${tooMany.slice(0, 10).join(", ")}`);
    if (unpaired.length) warnings.push(`配对：${unpaired.length} 对尚无译文侧（--allow-untranslated，M4-3 未开工）`);
  } else if (unpaired.length) {
    violations.push(`配对：以下 pairId 不是恰好 1 译文 ⇒ ${unpaired.slice(0, 10).join(", ")}`);
  }

  const famCount = new Map<string, number>();
  for (const [, e] of byPair) { const f = e.family ?? "?"; if (e.native) famCount.set(f, (famCount.get(f) ?? 0) + 1); }
  const famExpect: Record<string, number> = {};
  for (const f of SIX_FAMILIES) famExpect[f] = famCount.get(f) ?? 0;
  const unexpected = [...famCount.keys()].filter((f) => !SIX_FAMILIES.includes(f as typeof SIX_FAMILIES[number]));
  if (unexpected.length) violations.push(`族分布：出现六类之外的族 ⇒ ${unexpected.join(", ")}`);
  for (const f of SIX_FAMILIES) if ((famCount.get(f) ?? 0) !== 5) warnings.push(`族分布：${f} = ${famCount.get(f) ?? 0}（期望 5）`);
  if (byPair.size !== 30) warnings.push(`配对总数：${byPair.size}（期望 30）`);

  return {
    lines: rows.length, pairs: byPair.size, blankLines: blank, hasBom, hasCrlf,
    familyCounts: famExpect, secretHits: secrets.length,
    fileSha256: existsSync(pairsPath) ? sha256(readFileSync(pairsPath, "utf8")) : null,
  };
}

/** ③ 防泄漏（逐条） */
function checkLeakage(pairsPath: string, dev: DevItem[]): Record<string, unknown> {
  const { rows } = loadJsonlRaw(pairsPath);
  const sameLang = dev.filter((d) => d.file === "probes_zh.jsonl"); // 同语言、最主要泄漏面
  const perPair: Array<Record<string, unknown>> = [];
  let worst = { v: 0, pairId: "", devId: "", devFile: "" };
  for (const r of rows) {
    if (r.rec.side !== "native" || typeof r.rec.pairId !== "string") continue;
    const pairId = String(r.rec.pairId);
    const text = String(r.rec.text ?? "");
    const grams = bigrams(norm(text));
    const tier = String(r.rec.leakageTier ?? "?");
    const cmpSame = sameLang.map((d) => ({ d, v: containment(grams, d.grams) })).sort((a, b) => b.v - a.v)[0];
    const cmpAll = dev.map((d) => ({ d, v: containment(grams, d.grams) })).sort((a, b) => b.v - a.v)[0];
    const topSame = cmpSame?.v ?? 0;
    if (topSame > worst.v) worst = { v: topSame, pairId, devId: cmpSame?.d.id ?? "", devFile: cmpSame?.d.file ?? "" };
    if (topSame >= maxOverlap) {
      violations.push(`泄漏：${pairId}（tier=${tier}）与开发条目 ${cmpSame!.d.id} 的包含度 ${topSame.toFixed(3)} ≥ ${maxOverlap} ⇒ 打回重写`);
    } else if (topSame >= warnOverlap) {
      warnings.push(`泄漏：${pairId}（tier=${tier}）与 ${cmpSame!.d.id} 包含度 ${topSame.toFixed(3)}（≥ 警告线 ${warnOverlap}）`);
    }
    perPair.push({
      pairId, family: r.rec.family ?? null, leakageTier: tier,
      textSha256: sha256(text), normLen: norm(text).length,
      topDevSameLang: { id: cmpSame?.d.id ?? null, file: cmpSame?.d.file ?? null, containment: Number(topSame.toFixed(4)) },
      topDevAnyLang: { id: cmpAll?.d.id ?? null, file: cmpAll?.d.file ?? null, containment: Number((cmpAll?.v ?? 0).toFixed(4)) },
    });
  }
  perPair.sort((a, b) => Number((b.topDevSameLang as { containment: number }).containment) - Number((a.topDevSameLang as { containment: number }).containment));
  return {
    devItems: dev.length, devSameLangItems: sameLang.length,
    maxOverlapThreshold: maxOverlap, warnOverlapThreshold: warnOverlap,
    worst: { ...worst, v: Number(worst.v.toFixed(4)) },
    perPair,
  };
}

/** ④ 自证非恒真（阳性/阴性对照） */
function selfTest(dev: DevItem[]): Record<string, unknown> {
  const seed = dev.find((d) => d.file === "probes_zh.jsonl") ?? dev[0];
  if (!seed) return { ran: false, reason: "开发语料为空，无法构造对照" };
  // 阳性：直接把一条开发原文当留出条目 ⇒ 必须超失败线
  const posV = containment(bigrams(norm(seed.text)), seed.grams);
  // 阴性：无关文本 ⇒ 必须低于警告线
  const negText = "编排者阴性对照文本：想了解一下今年水稻育秧的适宜时间与注意事项。";
  const negV = seed ? containment(bigrams(norm(negText)), seed.grams) : 0;
  const posOk = posV >= maxOverlap;
  const negOk = negV < warnOverlap;
  if (!posOk) violations.push(`自证：阳性对照未触发（复制开发原文包含度仅 ${posV.toFixed(3)}）⇒ 检查器疑似恒假`);
  if (!negOk) violations.push(`自证：阴性对照被误报（无关文本包含度 ${negV.toFixed(3)}）⇒ 检查器疑似恒真`);
  return {
    ran: true, seedDevId: seed.id, seedDevFile: seed.file,
    positive: { containment: Number(posV.toFixed(4)), mustExceed: maxOverlap, passed: posOk },
    negative: { containment: Number(negV.toFixed(4)), mustStayBelow: warnOverlap, passed: negOk },
  };
}

// ── RAG 留出集（M4-7）：开发侧 = materials/*.md，留出侧必须换来源域（spec §5.1）──
function loadDevDocs(): Array<{ file: string; text: string; grams: Set<string> }> {
  const dir = join(REPO_ROOT, "materials");
  const out: Array<{ file: string; text: string; grams: Set<string> }> = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
    const text = readFileSync(join(dir, f), "utf8");
    out.push({ file: f, text, grams: bigrams(norm(text)) });
  }
  return out;
}

function checkRag(ragDir: string): Record<string, unknown> {
  const devDocs = loadDevDocs();
  const docsDir = join(ragDir, "docs");
  const docs = existsSync(docsDir) ? readdirSync(docsDir).filter((f) => f.endsWith(".md")).sort() : [];
  const docReport: Array<Record<string, unknown>> = [];
  let worst = { v: 0, doc: "", dev: "" };
  for (const f of docs) {
    const text = readFileSync(join(docsDir, f), "utf8");
    const g = bigrams(norm(text));
    let top = { v: 0, dev: "" };
    for (const d of devDocs) { const v = containment(g, d.grams); if (v > top.v) top = { v, dev: d.file }; }
    if (top.v > worst.v) worst = { v: top.v, doc: f, dev: top.dev };
    if (top.v >= maxOverlap) violations.push(`RAG 泄漏：${f} 与开发文档 ${top.dev} 包含度 ${top.v.toFixed(3)} ≥ ${maxOverlap}`);
    else if (top.v >= warnOverlap) warnings.push(`RAG 泄漏：${f} 与 ${top.dev} 包含度 ${top.v.toFixed(3)}（≥ 警告线 ${warnOverlap}）`);
    docReport.push({ file: f, chars: text.length, sha256: sha256(text), topDev: top.dev, containment: Number(top.v.toFixed(4)) });
  }
  const attacksPath = join(ragDir, "attacks.jsonl");
  let attacks: Record<string, unknown> = { present: false };
  if (existsSync(attacksPath)) {
    const { rows, hasBom, hasCrlf, blank } = loadJsonlRaw(attacksPath);
    if (hasBom) violations.push("RAG 卫生：attacks.jsonl 含 BOM");
    if (hasCrlf) violations.push("RAG 卫生：attacks.jsonl 含 CRLF");
    if (blank > 0) violations.push(`RAG 卫生：attacks.jsonl 含 ${blank} 个空行`);
    const byId = new Map<string, Set<string>>();
    const kinds = new Map<string, number>();
    const secrets: string[] = [];
    for (const r of rows) {
      const id = String(r.rec.id ?? ""); const cond = String(r.rec.condition ?? "");
      if (!id) violations.push(`RAG：attacks.jsonl 第 ${r.line} 行缺 id`);
      if (cond !== "natural" && cond !== "forced") violations.push(`RAG：${id} condition 非法（${cond}）`);
      const set = byId.get(id) ?? new Set<string>();
      if (set.has(cond)) violations.push(`RAG：${id} 的 condition=${cond} 重复`);
      set.add(cond); byId.set(id, set);
      const k = String(r.rec.injectionKind ?? "?");
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
      const h = secretHits(r.raw); if (h.length) secrets.push(`L${r.line}: ${h.join(",")}`);
    }
    if (secrets.length) violations.push(`RAG 卫生：attacks.jsonl 检出密钥形态 ⇒ ${secrets.slice(0, 3).join(" | ")}`);
    const badPair = [...byId.entries()].filter(([, st]) => !(st.has("natural") && st.has("forced"))).map(([id, st]) => `${id}(${[...st].join("/")})`);
    if (badPair.length) violations.push(`RAG：以下 id 未成对 natural+forced ⇒ ${badPair.slice(0, 6).join(", ")}`);
    if (byId.size !== 15) warnings.push(`RAG：注入 id 数 = ${byId.size}（期望 15）`);
    const kindCounts: Record<string, number> = {};
    for (const [k, v] of kinds) kindCounts[k] = Math.round(v / 2);
    for (const k of ["instruction_override", "fake_system_authorization", "fake_tool_result", "truncation_edge", "title_only"]) {
      if ((kindCounts[k] ?? 0) !== 3) warnings.push(`RAG：injectionKind ${k} = ${kindCounts[k] ?? 0}（期望 3 处注入）`);
    }
    attacks = { present: true, lines: rows.length, ids: byId.size, kindCounts, secretHits: secrets.length, sha256: sha256(readFileSync(attacksPath, "utf8")) };
  } else {
    violations.push("RAG：缺 rag/attacks.jsonl（M4-7 交付物）");
  }
  const benignPath = join(ragDir, "benign.jsonl");
  let benign: Record<string, unknown> = { present: false };
  if (existsSync(benignPath)) {
    const { rows } = loadJsonlRaw(benignPath);
    const ids = new Set(rows.map((r) => String(r.rec.id ?? "")));
    if (ids.size !== 20) warnings.push(`RAG：良性任务数 = ${ids.size}（期望 20）`);
    benign = { present: true, lines: rows.length, uniqueIds: ids.size, sha256: sha256(readFileSync(benignPath, "utf8")) };
  } else {
    violations.push("RAG：缺 rag/benign.jsonl（M4-7 交付物）");
  }
  if (docs.length !== 5) warnings.push(`RAG：文档数 = ${docs.length}（期望 5）`);
  return { devDocs: devDocs.map((d) => d.file), docs: docReport, worstDocLeak: { ...worst, v: Number(worst.v.toFixed(4)) }, attacks, benign };
}

// ── main ─────────────────────────────────────────────────────
function main(): void {
  const pairsPath = join(holdoutDir, "text", "pairs.jsonl");
  const ragDir = join(holdoutDir, "rag");
  const dev = loadDev(devDir);
  const present = existsSync(pairsPath);
  const status = present ? "checked" : "empty";

  const isolation = checkIsolation();
  const self = skipSelfTest ? { ran: false, reason: "--no-self-test" } : selfTest(dev);
  const hygiene = present ? checkHygiene(pairsPath) : null;
  const leakage = present ? checkLeakage(pairsPath, dev) : null;
  if (!present) notes.push(`尚无留出集 ${pairsPath}（M4-2/M4-3 未产出）⇒ 本轮只跑隔离断言与自证对照`);
  const rag = existsSync(ragDir) ? checkRag(ragDir) : null;
  if (!rag) notes.push("尚无 RAG 留出集 holdout/rag/（M4-7 未开工）");

  // 收口门：--require-holdout 时拒绝「空跑通过」，并把冻结清单当自证来核
  let manifestCheck: Record<string, unknown> | null = null;
  if (requireHoldout) {
    if (!present) violations.push(`收口门：--require-holdout 要求 ${pairsPath} 存在（当前缺失）⇒ 拒绝「空跑通过」`);
    const manifestPath = join(holdoutDir, "MANIFEST.json");
    if (!existsSync(manifestPath)) {
      violations.push("收口门：--require-holdout 但缺 holdout/MANIFEST.json（冻结清单）");
    } else {
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: Array<{ path: string; sha256: string }> };
      const files = m.files ?? [];
      const bad: string[] = [];
      for (const f of files) {
        const fp = join(holdoutDir, f.path);
        if (!existsSync(fp)) { bad.push(`${f.path}（缺失）`); continue; }
        if (sha256(readFileSync(fp, "utf8")) !== f.sha256) bad.push(`${f.path}（哈希不符）`);
      }
      if (bad.length) violations.push(`收口门：MANIFEST 自证失败 ⇒ ${bad.slice(0, 6).join("、")}`);
      manifestCheck = { files: files.length, mismatches: bad.length };
    }
  }

  const report = {
    tool: "holdout-lint", version: 1, timeUtc: new Date().toISOString(),
    spec: "holdout/spec.md §3/§4（v1）",
    status, devDir, holdoutDir, devItems: dev.length,
    checks: { isolation, selfTest: self, hygiene, leakage, rag, gate: { requireHoldout, manifestCheck } },
    violations, warnings, notes,
    pass: violations.length === 0,
  };

  console.log("留出集防泄漏与卫生检查");
  console.log(`  开发语料：${devDir}（${dev.length} 条）｜留出集：${holdoutDir}（${status === "empty" ? "尚未产出" : "已产出"}）`);
  if (hygiene) console.log(`  卫生：行 ${hygiene.lines}｜对 ${hygiene.pairs}｜空行 ${hygiene.blankLines}｜BOM ${hygiene.hasBom}｜CRLF ${hygiene.hasCrlf}`);
  if (leakage) {
    const w = leakage.worst as { v: number; pairId: string; devId: string };
    console.log(`  防泄漏：逐条 ${(leakage.perPair as unknown[]).length} 条；最坏 ${w.v}（${w.pairId} vs ${w.devId}）｜失败线 ${maxOverlap}｜警告线 ${warnOverlap}`);
  }
  if (self.ran) {
    const s = self as { positive: { passed: boolean }; negative: { passed: boolean } };
    console.log(`  自证（非恒真/非恒假）：阳性对照 ${s.positive.passed ? "✅" : "❌"}｜阴性对照 ${s.negative.passed ? "✅" : "❌"}`);
  }
  if (rag) {
    const r = rag as { docs: unknown[]; worstDocLeak: { v: number; doc: string; dev: string } ; attacks: { lines?: number; ids?: number }; benign: { uniqueIds?: number } };
    console.log(`  RAG：文档 ${r.docs.length} 篇｜最坏文档级包含度 ${r.worstDocLeak.v}（${r.worstDocLeak.doc} vs ${r.worstDocLeak.dev}）｜attacks ${r.attacks.lines ?? 0} 行/${r.attacks.ids ?? 0} id｜benign ${r.benign.uniqueIds ?? 0} 条`);
  }
  if (requireHoldout && manifestCheck) console.log(`  收口门：MANIFEST 自证 ${manifestCheck.files} 个文件，不符 ${manifestCheck.mismatches}`);
  console.log(`  RAG 显式隔离：${isolation.ragEntry.pass ? "通过" : "失败"}（${isolation.ragEntry.checks.filter(c => c.pass).length}/${isolation.ragEntry.checks.length}；默认路径/授权/声明/MANIFEST）`);
  for (const v of violations.slice(0, 20)) console.log(`  ❌ ${v}`);
  for (const w of warnings.slice(0, 20)) console.log(`  ⚠️  ${w}`);
  for (const n of notes) console.log(`  ℹ️  ${n}`);
  console.log(`结果：${violations.length === 0 ? "通过 ✅" : `失败 ❌（${violations.length} 项）`}`);

  if (outStem) {
    const stem = isAbsolute(outStem) ? outStem : resolve(process.cwd(), outStem);
    mkdirSync(dirname(stem), { recursive: true });
    writeFileSync(`${stem}.json`, JSON.stringify(report, null, 2) + "\n", "utf8");
    const md = [
      `# 留出集防泄漏报告（holdout-lint v1）`, ``,
      `- 时间(UTC)：${report.timeUtc}`, `- 状态：${status}｜开发语料 ${dev.length} 条`,
      `- 失败线/警告线：${maxOverlap} / ${warnOverlap}（依据 holdout/spec.md §3）`,
      `- 结论：${report.pass ? "**通过**" : `**失败**（${violations.length} 项）`}`, ``,
      ...(leakage ? [`## 逐条包含度（母语侧 vs 开发集，降序）`, ``,
        `| pairId | family | tier | 同语言最相似 dev | 包含度 | 任意语言最相似 dev | 包含度 |`,
        `|---|---|---|---|---:|---|---:|`,
        ...(leakage.perPair as Array<Record<string, unknown>>).map((p) => {
          const a = p.topDevSameLang as { id: string | null; containment: number };
          const b = p.topDevAnyLang as { id: string | null; containment: number };
          return `| ${p.pairId} | ${p.family} | ${p.leakageTier} | ${a.id} | ${a.containment} | ${b.id} | ${b.containment} |`;
        }), ``] : []),
      `## 违规`, ...(violations.length ? violations.map((v) => `- ❌ ${v}`) : ["- 无"]), ``,
      `## 警告`, ...(warnings.length ? warnings.map((w) => `- ⚠️ ${w}`) : ["- 无"]), ``,
      `## 说明`, ...(notes.length ? notes.map((n) => `- ℹ️ ${n}`) : ["- 无"]),
    ].join("\n");
    writeFileSync(`${stem}.md`, md + "\n", "utf8");
    console.log(`报告：${stem}.json / ${stem}.md`);
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

main();
