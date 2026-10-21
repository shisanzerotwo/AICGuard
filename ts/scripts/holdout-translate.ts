#!/usr/bin/env node
/**
 * M4-3 · 留出集译文侧生成器（docs/29 §2 D3，执行者 claude）
 *
 * 职责：把**英文原文**（`holdout/text/pairs.jsonl` 的 side="original-en" 行）逐条送**本机 LLM**
 * 译成中文（英→中，方向经用户 2026-10-12 裁定：与开发集 `probes_mt_zh` 机翻腔口径对齐），
 * 并把译文以 side="translation" 行写回**同一文件**（按 pairId 配对），
 * 同时逐条落 `holdout/provenance/translation-log.jsonl`。
 *
 * 契约（docs/29 §2 D3，红线）：
 *   1. 这是可信度修复分支的**首次真实模型调用**，用途**仅限数据准备**，不产出任何评测指标。
 *   2. 密钥只从环境变量 / ts/.env.local 读（`AICGUARD_API_KEY` / `AICGUARD_BASE_URL` /
 *      `AICGUARD_MODEL`），**不落任何产物**；台账/日志里的端点按 M2-1 的
 *      `normalizeEndpoint` 规范化，模型名照实记录；**key / Authorization 形态一律打码，绝不回显**。
 *   3. 逐条记录**实际 HTTP 尝试次数**；该批次数**单独列账**，不计入 docs/15 §5.2 的 200 次验证额度。
 *   4. 提示词**版本化**（`holdout/translation-prompt.md` + 其 sha256），译文与原句成对可复算。
 *
 * 与 llmbot.ts 的关系（D3："复用既有模型适配/配置口径，不要另造配置来源"）：
 *   - 模型身份 / 端点 / 密钥来源全部复用 `LlmBot`：`createLlmBotFromEnv`（同源工厂，读
 *     env + ts/.env.local），`normalizeEndpoint`（M2-1 规范化口径）。不另造配置读取。
 *   - **但翻译不走 LlmBot 的缓存**：`respond()` 命中缓存时不发新请求，"实际 HTTP 尝试次数"
 *     就记不准。本工具直接调 LlmBot 用的**同一座桥**（`ts/src/targets/llm-bridge.mjs`，
 *     可被 `AICGUARD_BRIDGE` 覆盖），每次真实翻译发**一次**同步请求（桥内对 429/5xx 自带
 *     ≤3 次退避重试），并用桥返回的 `usage.prompt_tokens` 判断"确有响应"；该条记
 *     httpAttempts=1。这样"每条译文一次 HTTP 尝试"如实可列账，且缓存不影响计数。
 *   - dry-run（`--dry-run`）**零 HTTP 调用**：只跑流程（读对、构造提示词、算 sha256、写台账与占位
 *     译文），把"本会发出的尝试数"标为 planned=1，不联网。
 *
 * 用法（详见 docs/29 §6）：
 *   node scripts/holdout-translate.ts [--in F] [--out F] [--prompt F] [--limit N] [--resume] [--dry-run]
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { normalizeEndpoint } from "../src/cache.ts";
import { createLlmBotFromEnv, loadLocalEnv, type LlmBot } from "../src/targets/llmbot.ts";
import type { ChatMessage } from "../src/types.ts";
// 复用既有的原子写（tmp + rename）而不是另写一份：pairs.jsonl 里装着 M4-2 的**手写母语侧**，
// 非可再生数据 ⇒ 中途崩溃不得把文件写坏。（M4-3 编排者复跑发现 B2）
import { writeFileAtomic } from "../src/candidate-store.ts";

import { fileURLToPath } from "node:url";
const __DIR = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(__DIR, "..");
/** 独立数据准备目录（docs/29 §2 D2：留出集不入 data/） */
const REPO_ROOT = resolve(TS_ROOT, "..");

/** 桥路径：与 llmbot.ts:43 同口径（默认 llm-bridge.mjs，可被 AICGUARD_BRIDGE 覆盖） */
const bridgePath = (): string =>
  process.env.AICGUARD_BRIDGE || join(__DIR, "..", "src", "targets", "llm-bridge.mjs");

/** 翻译的系统提示（固定、稳定；随提示词版本一并记录 sha256） */
const TRANSLATE_SYSTEM = "You translate English into Chinese for a security-evaluation holdout set. "
  + "Translate literally: keep the sentence structure and word order close to the source, do NOT polish it "
  + "into idiomatic Chinese (the machine-translation style is exactly what this set must capture). "
  + "Preserve the attack goal, target and intensity. Output ONLY the Chinese translation.";

// ── 参数解析 ─────────────────────────────────────────────────
interface Args {
  inp: string;
  out: string;
  prompt: string;
  limit: number; // 0 = 全部
  resume: boolean;
  dryRun: boolean;
  /** 进程内直连（不 spawn 子进程）——供"通道禁 spawn"的环境（如 workbuddy，docs/19 §4 第 14 条） */
  direct: boolean;
  /** dry-run 占位译文的输出文件（默认 `<--in>.dryrun.jsonl`；**dry-run 不改 `--in`**） */
  dryPairsOut: string | null;
  /** 只处理这些 pairId（逗号分隔）；命中项**强制重译**（覆盖已有译文）——M4-5 定点返工用 */
  only: string | null;
  /** 对**已有**译文做确定性规范化（标签/分隔符/简繁），零模型调用 —— M4-5 返工用 */
  renorm: boolean;
}
const args: Args = {
  inp: join(REPO_ROOT, "holdout", "text", "pairs.jsonl"),
  out: join(REPO_ROOT, "holdout", "provenance", "translation-log.jsonl"),
  prompt: join(REPO_ROOT, "holdout", "translation-prompt.md"),
  limit: 0,
  resume: false,
  dryRun: false,
  direct: false,
  dryPairsOut: null,
  only: null,
  renorm: false,
};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") { args.limit = Number(argv[++i]); }
    else if (a === "--in") { args.inp = resolve(argv[++i]); }
    else if (a === "--out") { args.out = resolve(argv[++i]); }
    else if (a === "--prompt") { args.prompt = resolve(argv[++i]); }
    else if (a === "--resume") { args.resume = true; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--direct") { args.direct = true; }
    else if (a === "--dry-pairs-out") { args.dryPairsOut = resolve(argv[++i]); }
    else if (a === "--only") { args.only = argv[++i] ?? ""; }
    else if (a === "--renorm") { args.renorm = true; }
    else if (a === "--help") {
      console.log("用法：node scripts/holdout-translate.ts [--in F] [--out F] [--prompt F] [--limit N] [--resume] [--dry-run] [--direct] [--dry-pairs-out F] [--only ID1,ID2] [--renorm]");
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
}

/**
 * dry-run 的占位译文写这里（**默认 = `<--in>.dryrun.jsonl`**）。
 * ⚠️ 背景（M4-3 复核者 workbuddy 发现，证据 52 §D-4）：早期版本 dry-run 会把占位译文写进 `--in` ——
 * 若有人对正式 `holdout/text/pairs.jsonl` 直接 dry-run，就会把**占位文本混进冻结数据**（本机已复现）。
 * 现在 dry-run **绝不改写 `--in`**，只在一份副本上演练流程。
 */
const dryPairsOut = args.dryPairsOut ?? `${args.inp}.dryrun.jsonl`;

/** 密钥来源：只用于校验"有没有"与喂桥（经 LlmBot 读入，本工具从不打印/落盘） */
function resolveApiKey(): { key: boolean; source: string } {
  const c = readCredentials();
  return { key: c.hasKey, source: c.hasKey ? "env-or-.env.local(AICGUARD_API_KEY)" : "none" };
}

// ── 输入读出（母语侧）─────────────────────────────────────
function loadSourcePairs(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) {
    console.error(`缺输入文件：${file}`);
    console.error("（尚无英文原文侧（side=\"original-en\"）；可先用夹具验证流程，见 ts/runs/verify-m4-3/）");
    process.exit(2);
  }
  const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).filter((l) => l.trim());
  const pairs: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (rec.side === "original-en") pairs.push(rec); // M4-3 输入=**英文原文**（英→中，方向由用户 2026-10-12 裁定）
  }
  return pairs;
}

// ── 已有译文侧索引（--resume 幂等）────────────────────────
function loadExistingTranslations(file: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(file)) return m;
  for (const line of readFileSync(file, "utf8").trim().split(/\r?\n/).filter((l) => l.trim())) {
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (rec.side === "translation" && typeof rec.pairId === "string") m.set(rec.pairId, String(rec.text));
  }
  return m;
}

// ── 提示词（版本化）──────────────────────────────────────
function loadPrompt(path: string): { text: string; sha256: string; inline: boolean; version: string } {
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    return { text, sha256: sha256(text), inline: false, version: "translation-prompt.md" };
  }
  const text = "Translate the Chinese probe into English; output only the translation.\n";
  console.warn(`提示词文件不存在，使用内联默认（promptInline=true）：${path}`);
  return { text, sha256: sha256(text), inline: true, version: "inline-default" };
}

/** 密钥来源（与 createLlmBotFromEnv 同源：env 优先，ts/.env.local 兜底）；本工具只取用、绝不打印/落盘 */
function readCredentials(): { apiKey: string; model: string; baseUrl: string; hasKey: boolean } {
  const env = { ...loadLocalEnv(), ...process.env };
  return {
    apiKey: env.AICGUARD_API_KEY ?? "",
    model: env.AICGUARD_MODEL ?? "",
    baseUrl: env.AICGUARD_BASE_URL ?? "",
    hasKey: Boolean(env.AICGUARD_API_KEY),
  };
}

// ── 发一次翻译请求（走同一座桥，**不走缓存**，如实计 1 次 HTTP 尝试）──
// ── 发一次翻译请求（进程内直连，**不 spawn**；供"通道禁 spawn"的环境）──
// 与桥（llm-bridge.mjs）对齐：POST `${baseUrl}/chat/completions`、Bearer 头、429/5xx 退避 2s/5s、至多 3 次尝试。
// 优势：**能如实统计实际 HTTP 尝试次数**（含退避重试）⇒ 修掉走桥时一律记 1 次的低估（证据 47 的 B1）。
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function callDirect(
  creds: { apiKey: string; baseUrl: string; model: string }, userMsg: string, timeoutMs = 60_000,
): Promise<{ text: string; error: string; promptTokens: number; attempts: number }> {
  let lastErr = "";
  let attempts = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep([0, 2000, 5000][attempt]);
    attempts++;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${creds.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify({
          model: creds.model,
          messages: [{ role: "system", content: TRANSLATE_SYSTEM }, { role: "user", content: userMsg }],
          max_tokens: 500,
          temperature: 0.2,
        }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (res.status === 429 || res.status >= 500) { lastErr = `HTTP ${res.status}`; continue; }
      if (!res.ok) {
        const t = await res.text();
        return { text: "", error: `HTTP ${res.status}: ${t.slice(0, 200)}`, promptTokens: 0, attempts };
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number } };
      return { text: data.choices?.[0]?.message?.content ?? "", error: "", promptTokens: data.usage?.prompt_tokens ?? 0, attempts };
    } catch (e) {
      lastErr = (e as Error)?.name === "AbortError" ? `超时(${timeoutMs}ms)` : String(e);
    }
  }
  return { text: "", error: lastErr || "未知错误", promptTokens: 0, attempts };
}

function callBridgeOnce(creds: { apiKey: string; baseUrl: string; model: string }, userMsg: string, timeoutMs = 60_000):
  { text: string; error: string; promptTokens: number } {
  const r = spawnSync(process.execPath, [bridgePath()], {
    input: JSON.stringify({
      baseUrl: creds.baseUrl,
      // 密钥只进桥（写进请求头，桥 stdout 不回显）⇒ 本工具任何日志都不含密钥
      apiKey: creds.apiKey,
      model: creds.model,
      system: TRANSLATE_SYSTEM,
      messages: [{ role: "user", content: userMsg } as ChatMessage],
      maxTokens: 500,
      temperature: 0.2, // 翻译求稳定，压低温度（与默认 0.7 的差异写进台账）
      timeoutMs,
    }),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs * 4 + 30_000,
  });
  let out: { text?: string; error?: string; usage?: { prompt_tokens?: number } };
  try { out = JSON.parse(r.stdout || "{}"); }
  catch { return { text: "", error: `bridge 输出解析失败：${(r.stderr || r.error || "").toString().slice(0, 200)}`, promptTokens: 0 }; }
  return { text: out.text ?? "", error: out.error ?? "", promptTokens: out.usage?.prompt_tokens ?? 0 };
}

// ── 写译文侧到同一文件（按 pairId 配对，插在对应**英文原文行**之后：native → original-en → translation）──
// 幂等性（M4-3 编排者复跑发现 B3/B4，已修）：
//   B3 旧版每次插入多留一个空行（空行会随对数累积）；B4 旧版不带 --resume 重跑会把译文**重复插入**。
//   现在：先丢弃空行、再删掉该 pairId 的旧译文行，然后重新插入 ⇒ 重跑多少次结果都一致。
function insertTranslationPair(pairsFile: string, nativeRec: Record<string, unknown>, translation: string, promptVersion: string): void {
  const pairId = String(nativeRec.pairId);
  const rows: string[] = [];
  let inserted = false;
  for (const line of readFileSync(pairsFile, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue; // 空行不入库（避免累积）
    let rec: Record<string, unknown> | null = null;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { rec = null; }
    if (rec && rec.pairId === pairId && rec.side === "translation") continue; // 旧译文先删（幂等）
    rows.push(line);
    if (!inserted && rec && rec.pairId === pairId && rec.side === "original-en") {
      rows.push(JSON.stringify({
        pairId,
        family: nativeRec.family ?? null,
        goal: nativeRec.goal ?? null,
        side: "translation",
        source: "llm-translation",
        text: translation,
        provenance: { promptVersion },
      }));
      inserted = true;
    }
  }
  writeFileAtomic(pairsFile, rows.join("\n") + "\n");
}

function makeLogRecord(x: {
  pairId: string; p: Record<string, unknown>; promptVersion: string; promptSha256: string; promptInline: boolean;
  sourceText: string; translation: string; model: string; endpoint: string | null;
  httpAttempts: number; plannedAttempts: number | null; dryRun: boolean; error: string;
  transport: "bridge" | "direct" | "dry-run";
}): Record<string, unknown> {
  return {
    pairId: x.pairId,
    family: x.p.family ?? null,
    goal: x.p.goal ?? null,
    sourceText: x.sourceText,
    sourceTextSha256: sha256(x.sourceText),
    translation: x.translation,
    translationSha256: x.translation ? sha256(x.translation) : null,
    model: x.model,
    endpoint: x.endpoint, // 规范化端点（normalizeEndpoint）；dry-run 无，置 null
    transport: x.transport, // bridge=次数为下限；direct=次数为实测；dry-run=零调用
    promptSha256: x.promptSha256,
    promptVersion: x.promptVersion,
    promptInline: x.promptInline,
    timeUtc: new Date().toISOString(),
    httpAttempts: x.httpAttempts,
    ...(x.plannedAttempts != null ? { plannedAttempts: x.plannedAttempts } : {}),
    dryRun: x.dryRun,
    error: x.error || null,
    // 密钥不落地（D3 红线）：本对象**不**含 apiKey / Authorization / key 任何字段。
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ── 译文规范化（M4-5 返工：把"格式契约"从"指望模型遵守"改为"工具强制"）──
// 背景：v2/v3 提示词都无法让模型稳定产出统一标签 —— 5 条多轮译文出现三种形态（英文标签 / 无标签 /
// 中文标签+换行），且偶发整条繁体（EN-03 重译时）。⇒ 模型只负责"内容"，工具负责**可复算的规范化**；
// 原始输出保留在台账 `translationRaw`（可审计），规范化结果写 `translation` + `normalizer`。
const NORMALIZER_VERSION = "n1";
const TRAD2SIMP: Array<[string, string]> = [
  ["議","议"],["語","语"],["碼","码"],["噴","喷"],["灑","洒"],["隱","隐"],["條","条"],["並","并"],["於","于"],
  ["給","给"],["規","规"],["則","则"],["開","开"],["關","关"],["實","实"],["驗","验"],["據","据"],["證","证"],
  ["處","处"],["當","当"],["應","应"],["該","该"],["設","设"],["資","资"],["網","网"],["絡","络"],["樣","样"],
  ["試","试"],["為","为"],["與","与"],["來","来"],["經","经"],["過","过"],["種","种"],["覺","觉"],["讓","让"],
  ["認","认"],["識","识"],["見","见"],["現","现"],["後","后"],["裡","里"],["復","复"],["術","术"],["義","义"],
  ["習","习"],["寫","写"],["讀","读"],["聽","听"],["記","记"],["長","长"],["門","门"],["車","车"],["農","农"],
  ["藥","药"],["劑","剂"],["檢","检"],["護","护"],["欄","栏"],["譯","译"],["編","编"],["錄","录"],["傳","传"],
  ["統","统"],["風","风"],["險","险"],["數","数"],["麼","么"],["們","们"],["這","这"],["時","时"],["題","题"],
  ["問","问"],["點","点"],["無","无"],["調","调"],["類","类"],["總","总"],["體","体"],["產","产"],["個","个"],
  ["說","说"],["會","会"],["隻","只"],["從","从"],["舊","旧"],
];

/** 从**源文本**（英文原文）抽出轮次角色序列：["用户","助手","用户",…] */
function sourceTurnRoles(text: string): string[] {
  const roles: string[] = [];
  for (const m of text.matchAll(/\b(User|Assistant)\s*[:：]|(用户|助手)\s*[:：]/g)) {
    roles.push(m[1] ? (m[1].toLowerCase() === "user" ? "用户" : "助手") : String(m[2]));
  }
  return roles;
}

/** 确定性规范化：英文标签→中文、轮次分隔统一为全角斜杠 `／`、缺标签时按源轮次补齐、繁体→简体 */
function normalizeTranslation(raw: string, sourceTurns: string[]): { text: string; notes: string[] } {
  const notes: string[] = [];
  let t = raw.replace(/\r\n?/g, "\n").trim();
  if (/\b(User|Assistant)\s*[:：]/i.test(t)) {
    t = t.replace(/\bUser\s*[:：]/gi, "用户：").replace(/\bAssistant\s*[:：]/gi, "助手：");
    notes.push("英文标签→中文");
  }
  const parts = t.split(/(?=用户：|助手：)/).map((x) => x.trim()).filter(Boolean);
  let turns = parts;
  if (parts.length < 2 && sourceTurns.length >= 2) {
    const segs = t.split(/\s*[/／]\s*|\n+/).map((x) => x.trim()).filter(Boolean);
    if (segs.length === sourceTurns.length) {
      turns = segs.map((x, i) => `${sourceTurns[i]}：${x}`);
      notes.push(`补标签(按源轮次 ${sourceTurns.length})`);
    } else {
      notes.push(`段数 ${segs.length} ≠ 源轮次 ${sourceTurns.length}，未补标签`);
    }
  }
  if (turns.length >= 2) {
    t = turns.map((x) => x.replace(/^[\s/／]+|[\s/／]+$/g, "").trim()).join("／");
    notes.push("分隔符→／");
  }
  const hits = [...new Set([...t].filter((c) => TRAD2SIMP.some(([a]) => a === c)))];
  if (hits.length) {
    for (const [a, b] of TRAD2SIMP) t = t.split(a).join(b);
    notes.push(`繁体→简体(${hits.join("")})`);
  }
  return { text: t, notes };
}

/** `--renorm`：对**已有**译文做规范化（零模型调用），同步更新台账最后一条并保留原始输出 */
function renormExisting(pairsFile: string, logFile: string): void {
  const rows = readFileSync(pairsFile, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  const src = new Map<string, string>();
  for (const r of rows) if (r.side === "original-en") src.set(String(r.pairId), String(r.text ?? ""));
  const led = existsSync(logFile) ? readFileSync(logFile, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  const lastIdx = new Map<string, number>();
  led.forEach((r, i) => lastIdx.set(String(r.pairId), i));
  const report: Array<{ pairId: string; notes: string[] }> = [];
  for (const r of rows) {
    if (r.side !== "translation") continue;
    const pid = String(r.pairId);
    const rawText = String(r.text ?? "");
    const { text, notes } = normalizeTranslation(rawText, sourceTurnRoles(src.get(pid) ?? ""));
    if (text === rawText) continue;
    r.text = text;
    const i = lastIdx.get(pid);
    if (i !== undefined) {
      led[i].translationRaw = rawText;
      led[i].translation = text;
      led[i].translationSha256 = sha256(text);
      led[i].normalizer = `${NORMALIZER_VERSION}: ${notes.join("；")}`;
    }
    report.push({ pairId: pid, notes });
  }
  writeFileAtomic(pairsFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (led.length) writeFileAtomic(logFile, led.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`--renorm(${NORMALIZER_VERSION})：规范化 ${report.length} 条`);
  for (const x of report.slice(0, 40)) console.log(`  ${x.pairId}：${x.notes.join("；")}`);
}

// ── main ───────────────────────────────────────────────────
function main(): void {
  // mainAsync 内的 fetch/退避都是异步的（--direct）；包装一层保证异常不静默
  void mainAsync().catch((e: unknown) => {
    console.error(`未捕获错误：${(e as Error)?.message ?? String(e)}`);
    process.exitCode = 2;
  });
}

async function mainAsync(): Promise<void> {
  const pairs = loadSourcePairs(args.inp);
  const prompt = loadPrompt(args.prompt);
  if (args.renorm) { renormExisting(args.inp, args.out); return; } // 零模型调用的确定性规范化
  // dry-run 时以副本为"已译"来源（--in 始终只读）
  const targetPairs = args.dryRun ? dryPairsOut : args.inp;
  if (args.dryRun) {
    if (!existsSync(dryPairsOut)) copyFileSync(args.inp, dryPairsOut);
    console.log(`dry-run：占位译文写入副本 ${dryPairsOut}（**--in 不被改动**）`);
  }
  const existing = args.resume ? loadExistingTranslations(targetPairs) : new Map<string, string>();

  const onlySet = args.only ? new Set(args.only.split(",").map((x) => x.trim()).filter(Boolean)) : null;
  const todo = pairs
    .filter((p) => typeof p.pairId === "string")
    .filter((p) => (onlySet ? onlySet.has(String(p.pairId)) : true)) // --only：只处理指定 pairId…
    .filter((p) => (onlySet ? true : !(args.resume && existing.has(String(p.pairId))))) // …且**强制重译**（不受 --resume 跳过影响）
    .slice(0, args.limit > 0 ? args.limit : undefined);

  console.log(`输入：${args.inp}`);
  console.log(`英文原文 pair 数：${pairs.length}｜待译：${todo.length}`
    + (args.resume ? `（--resume，跳过已有译文 ${existing.size} 条）` : "")
    + (args.limit > 0 ? `（--limit ${args.limit}）` : ""));
  console.log(`dry-run：${args.dryRun ? "是（零 HTTP 调用）" : "否"}｜传输：${args.dryRun ? "—" : args.direct ? "direct（进程内直连，不 spawn）" : "bridge（子进程桥）"}`);

  let bot: LlmBot | null = null;
  if (!args.dryRun) {
    try {
      bot = createLlmBotFromEnv(TRANSLATE_SYSTEM, {});
      const keyInfo = resolveApiKey();
      if (!keyInfo.key) {
        console.error(`缺 AICGUARD_API_KEY（来源=${keyInfo.source}）；按 D3 不索要明文密钥。`);
        console.error("本工具可先用 --dry-run 验证流程；有密钥的通道再跑实译（阻塞项写进证据 §D）。");
        process.exit(3);
      }
    } catch (e) {
      console.error(`LLM 配置构造失败：${(e as Error).message}`);
      process.exit(3);
    }
  }

  const logDir = dirname(args.out);
  mkdirSync(logDir, { recursive: true });
  if (!args.resume && !existsSync(args.out)) writeFileSync(args.out, "", "utf8");

  let ok = 0, failed = 0, skipped = 0;
  let totalHttp = 0;
  const normEp = bot ? normalizeEndpoint(bot.endpoint) : null;
  const creds = readCredentials(); // 与 LlmBot 同源（env 优先 + ts/.env.local）；只取用，不落盘/不打印

  for (const p of todo) {
    const pairId = String(p.pairId);
    const text = String(p.text ?? "");
    const userMsg = `Translate the following English security-evaluation probe into Chinese, literally.\n`
      + `Keep the structure and word order close to the source; do not polish it into idiomatic Chinese.\n\n`
      + `English:\n${text}\n\nChinese translation only:`;

    if (args.dryRun) {
      // 零 HTTP：占位译文 + 计划尝试数 1，供流程复算与台账演练
      const translation = `[dry-run] 拟译为中文:${text.slice(0, 24)}…`;
      insertTranslationPair(dryPairsOut, p, translation, prompt.version); // ⚠️ 写副本，绝不碰 --in（证据 52 §D-4）
      appendFileSync(args.out, JSON.stringify(makeLogRecord({
        pairId, p, promptVersion: prompt.version, promptSha256: prompt.sha256, promptInline: prompt.inline,
        sourceText: text, translation, model: "(dry-run)", endpoint: null,
        httpAttempts: 0, plannedAttempts: 1, dryRun: true, error: "", transport: "dry-run",
      })) + "\n", "utf8");
      console.log(`  ${pairId} [dry-run] 计划 1 次 HTTP（未发）｜占位译文`);
      ok++;
      continue;
    }

    const res = args.direct ? await callDirect(creds, userMsg) : callBridgeOnce(creds, userMsg);
    // bridge：外层只发 1 次（桥内退避受它自己控制，不上报）⇒ 是**下限**；direct：attempts 是**实测**。
    // 两者在台账 transport 字段区分，引用"发了多少次请求"时不得混用。
    const httpAttempts = args.direct ? (res as { attempts?: number }).attempts ?? 1 : 1;
    totalHttp += httpAttempts;
    const model = creds.model;
    const transport: "bridge" | "direct" = args.direct ? "direct" : "bridge";
    if (res.text && !res.error) {
      insertTranslationPair(args.inp, p, res.text, prompt.version);
      appendFileSync(args.out, JSON.stringify(makeLogRecord({
        pairId, p, promptVersion: prompt.version, promptSha256: prompt.sha256, promptInline: prompt.inline,
        sourceText: text, translation: res.text, model, endpoint: normEp,
        httpAttempts, plannedAttempts: null, dryRun: false, error: "", transport,
      })) + "\n", "utf8");
      console.log(`  ${pairId} 译成（HTTP 尝试 ${httpAttempts} 次，prompt_tokens=${res.promptTokens}）｜译文 sha256=${sha256(res.text).slice(0, 12)}…`);
      ok++;
    } else {
      // 失败：不落译文（保持成对完整性），只记错误与尝试数
      appendFileSync(args.out, JSON.stringify(makeLogRecord({
        pairId, p, promptVersion: prompt.version, promptSha256: prompt.sha256, promptInline: prompt.inline,
        sourceText: text, translation: "", model, endpoint: normEp,
        httpAttempts, plannedAttempts: null, dryRun: false, error: res.error || "bridge 无文本", transport,
      })) + "\n", "utf8");
      console.log(`  ${pairId} 失败（HTTP 尝试 ${httpAttempts} 次）：${(res.error || "无文本").slice(0, 120)}`);
      failed++;
    }
  }

  if (args.resume) skipped = existing.size;
  console.log(`\n完成：成功 ${ok}｜失败 ${failed}｜跳过（resume）${skipped}`);
  console.log(`实际 HTTP 尝试次数合计：${totalHttp}（单独列账，不计入 docs/15 §5.2 的 200 次验证额度）`);
  console.log(`台账：${args.out}`);
  if (args.dryRun) console.log("dry-run 汇总：零 HTTP 调用；译文为占位，勿当作真实译文入库。");
  // ⚠️ Windows：异步 I/O（--direct 的 fetch）尚未收尾时同步 exit 会触发 libuv 断言、把退出码篡改成 9
  // ⇒ 一律用 exitCode 让进程自然结束（与 scripts/migrate-candidates.ts 同口径，见 docs/21 §M3-2）
  process.exitCode = failed > 0 && !args.dryRun ? 1 : 0;
}

main();
