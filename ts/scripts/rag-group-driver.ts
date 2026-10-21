#!/usr/bin/env node
/**
 * RAG 组运行驱动（R3 第二轮，`docs/45` + Codex 返工单）。
 *
 * 纪律（每一条都由复核反例逼出来）：
 *   ① **严格取值**：缺值/空串/全空白/非法数字 ⇒ 执行第一项前 `exit 2`（不静默用 null/0）；
 *   ② **身份与账目 fail-closed**：计划绑定的 `model`/`endpoint`/`mode` 逐项核对；账本不存在/解析失败/`used`·`limit` 缺失、
 *      报告 `batch.usage.httpAttempts`·`cacheHits` 缺失或不可核对 ⇒ **启动下一项前停止**（未知不得跳过）；
 *   ③ **先落盘再评估**：runner 返回后先不可变落盘 stdout/stderr/退出码与信号/账本前后 used+sha256/**报告原件**（缺失也记），
 *      再 JSON 解析与业务判定；解析失败/报告缺失也形成该项结构化 record 并写 `stopped.json`；
 *   ④ **输出不可覆盖**：发送前拒绝已存在的输出目录 / 重复 label（历史 `stdout.txt`/`report` 一律逐字节保留）；
 *   ⑤ **双闸门**：同时检查攻击 `cases` 与良性 `benign.perCase`。未知 `call_error`/`unexpected`、缺原错误或缺**必要** transport ⇒ 停；
 *      但**输入护栏明确阻断 / 明确发送前拒绝（refused）/ 未执行（unexecuted）**允许没有发送证据——
 *      前提是**有对应事实**（`blockedStage+blockedBy` / `transport.state=refused`+预算事实 / `unexecuted`）；
 *      **健康响应空 error 是合法状态**，不得因空串把全部健康任务停掉；
 *   ⑥ `--continue-on` 只接受**发送前预先固定**的明确类别（形如 `call_error:<原因码>`），**不得**用宽泛 `call_error` 绕过缺原件；
 *   ⑦ `sentText.length > 0` **不是**送达判据（本驱动不看它）。
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

interface Item { label: string; profile: string; kind: string; id?: string; condition?: string; file?: string; sha256?: string }
interface Plan {
  items: Item[];
  modelToReuse?: string;
  identity?: { model?: string; endpoint?: string; mode?: string };
}

const argv = process.argv.slice(2);
class DieError extends Error {}
// 规范（Codex 非阻塞项）：不用 process.exit（Windows stdio 可能未 flush）——写 stderr + 设 exitCode，再抛哨兵中止。
const die = (why: string): never => { process.stderr.write(`参数错误：${why}\n`); process.exitCode = 2; throw new DieError(why); };
// 必须在任何 die() 之前注册（否则 throw 发生在注册前，处理器永不生效）
process.on("uncaughtException", (e) => {
  if (e instanceof DieError) return;                       // exitCode 已置 2
  process.stderr.write(`驱动内部异常：${String((e as Error)?.stack ?? e)}\n`);
  process.exitCode = 1;
});
/** 严格取值：出现 flag 就必须给合法值 */
const strictStr = (n: string, required = false): string | undefined => {
  const i = argv.indexOf(n);
  if (i < 0) { if (required) die(`缺少 ${n}`); return undefined; }
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) die(`${n} 缺取值`);
  if (v.trim() === "") die(`${n} 取值不得为空/全空白`);
  return v;
};
const strictNum = (n: string, required = false): number | undefined => {
  const v = strictStr(n, required);
  if (v === undefined) return undefined;
  const num = Number(v);
  if (!Number.isFinite(num) || num < 0) die(`${n} 必须是有限非负数（实际 ${JSON.stringify(v)}）`);
  return num;
};

const planPath = strictStr("--plan", true)!;
const outDir = resolve(strictStr("--out", true)!);
// P1（Codex 复核）：`--out` 必须拒绝落在冻结/受保护目录内（holdout/**、data/**、materials/**）——在**任何写入之前**
// 仓库根：以**调用方 cwd（= ts/）**为准（各入口与测试均以 cwd=ts 运行），并保留 import.meta 兜底，
// 两者取“更外层”的那一个，避免因路径层级算错导致 --out 保护失效（曾误写进 holdout/）。
// `--out` 保护（fail-closed，**与 cwd 无关**）：只要解析后的路径**任一祖先段**是
// `holdout` / `data` / `materials`，就拒绝——不依赖"仓库根猜得对不对"，宁可误拒也不误写。
const PROTECTED_SEGMENTS = new Set(["holdout", "data", "materials"]);
/** Windows 大小写不敏感且尾随点/空格会被吞：段名归一后再比对（`HOLDOUT`、`Holdout.` 都算命中）。 */
const normalizeSegment = (seg: string): string => seg.toLowerCase().replace(/[. ]+$/, "");
/**
 * 规范路径：把**已存在的最近祖先**取 `realpath` 再拼回剩余段。
 * 目的：目录联接/符号链接（如 `mklink /J link holdout`）指向受保护目录时，
 * 即使 `--out` 的子路径**尚未创建**，也能被识别成落在受保护目录之内。
 */
const canonicalize = (p: string): string => {
  let cur = resolve(p);
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    if (existsSync(cur)) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(basename(cur));
    cur = parent;
  }
  let real = cur;
  try { real = realpathSync.native(cur); } catch { /* 取不到真实路径就退回字面路径 */ }
  return rest.length === 0 ? real : join(real, ...rest);
};
const outPathForCheck = canonicalize(outDir);
for (const seg of outPathForCheck.split(/[\\/]+/)) {
  if (PROTECTED_SEGMENTS.has(normalizeSegment(seg))) {
    die(`--out 不得写进受保护目录（路径含 ${normalizeSegment(seg)}/）：${outDir}`);
  }
}
const runner = strictStr("--runner", true)!;
const budgetPath = strictStr("--budget");
const baselineUsed = strictNum("--baseline-used");
const ceiling = strictNum("--ceiling") ?? 0;
const cap = strictNum("--cap") ?? 0;
const continueOn = (strictStr("--continue-on") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const CONTINUE_RE = /^(attack:call_error|benign:targetError):[a-z][a-z0-9_-]*$/;
for (const entry of continueOn) {
  if (!CONTINUE_RE.test(entry)) die(`--continue-on 必须绑定具体原因码（attack:call_error:<state> / benign:targetError:<cause>）；拒绝泛状态或自由文本：${JSON.stringify(entry)}`);
}
function structuredReasonCode(row: Record<string, unknown>, kind: "attack" | "benign"): string | null {
  if (kind === "attack") {
    const t = (row.transport ?? null) as null | { state?: unknown };
    const st = typeof t?.state === "string" ? t.state : "";
    return st === "" ? null : `attack:call_error:${st}`;
  }
  const cause = typeof row.cause === "string" ? row.cause.trim() : "";
  if (cause !== "") return `benign:targetError:${cause}`;
  const t = (row.transport ?? {}) as Record<string, unknown>;
  const ev = (t.evidence ?? null) as null | { state?: unknown };
  const st = typeof ev?.state === "string" ? ev.state : "";
  return st === "" ? null : `benign:targetError:${st}`;
}
if (!existsSync(planPath)) die(`计划文件不存在：${planPath}`);
const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
const cliIdentity = { model: strictStr("--model"), endpoint: strictStr("--endpoint"), mode: strictStr("--mode") };
const planIdentity = plan.identity ?? {};
for (const k of ["model", "endpoint", "mode"] as const) {
  const fromPlan = (k === "model" ? planIdentity.model ?? plan.modelToReuse : planIdentity[k]) ?? undefined;
  if (fromPlan !== undefined && cliIdentity[k] !== undefined && cliIdentity[k] !== fromPlan) {
    die(`身份冲突：--${k} 显式值 ${JSON.stringify(cliIdentity[k])} 与计划 ${JSON.stringify(fromPlan)} 不一致（不允许绕过计划绑定）`);
  }
}
const identity = {
  model: cliIdentity.model ?? planIdentity.model ?? plan.modelToReuse ?? null,
  endpoint: cliIdentity.endpoint ?? planIdentity.endpoint ?? null,
  mode: cliIdentity.mode ?? planIdentity.mode ?? null,
};
if (!identity.model) die("未绑定模型身份（--model 或计划里的 identity.model / modelToReuse）");
if (!identity.endpoint) die("未绑定规范化端点（--endpoint 或计划里的 identity.endpoint）");
if (!identity.mode) die("未绑定缓存模式（--mode fresh|replay 或计划里的 identity.mode）");
if (identity.mode !== "fresh" && identity.mode !== "replay") die(`identity.mode 必须是 fresh|replay（实际 ${identity.mode}）`);
if (!Array.isArray(plan.items) || plan.items.length === 0) die("计划里没有 items");
for (const it of plan.items) {
  if (it.kind !== "attack" && it.kind !== "benign") die(`计划项 kind 非法：${JSON.stringify(it.kind)}（只允许 attack / benign；项 ${it.label}）`);
}
const expectedCount = new Map<string, number>();
for (const it of plan.items) {
  const file = it.file ?? die(`计划项 ${it.label} 缺输入文件（无法核对逐条记录数）`);
  const text = (() => { try { return readFileSync(file, "utf8"); } catch (e) { return die(`计划项 ${it.label} 输入不可读：${(e as Error).message.slice(0, 80)}`); } })();
  const n = text.split(/\r?\n/).filter((l) => l.trim()).length;
  if (n < 1) die(`计划项 ${it.label} 输入为空（期望至少 1 条）`);
  expectedCount.set(it.label, n);
}
const labels = plan.items.map((i) => i.label);
if (new Set(labels).size !== labels.length) die("计划里有重复 label");
if (existsSync(outDir)) {
  const pre = ["driver-items.jsonl", "stopped.json", "completed.json"].concat(labels.flatMap((l) => [
    join("out", l, "stdout.txt"), join("out", l, "stderr.txt"),
    join("out", l, "rag-report.json"), join("out", l, "rag-report.original.json"), join("out", l, "cases.jsonl"),
  ])).concat(["out"]);
  if (pre.some((f) => existsSync(join(outDir, f)))) die(`输出目录/报告原件已存在，拒绝覆盖：${outDir}`);
}
mkdirSync(outDir, { recursive: true });

const sha256Of = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const ledgerState = (): { used: number | null; limit: number | null; sha256: string | null; error?: string } => {
  if (!budgetPath) return { used: null, limit: null, sha256: null, error: "未提供 --budget" };
  if (!existsSync(budgetPath)) return { used: null, limit: null, sha256: null, error: "账本不存在" };
  try {
    const bytes = readFileSync(budgetPath);
    const j = JSON.parse(bytes.toString("utf8")) as { used?: number; limit?: number };
    if (typeof j.used !== "number" || typeof j.limit !== "number") return { used: null, limit: null, sha256: sha256Of(budgetPath), error: "账本缺 used/limit" };
    return { used: j.used, limit: j.limit, sha256: sha256Of(budgetPath) };
  } catch { return { used: null, limit: null, sha256: null, error: "账本 JSON 解析失败" }; }
};

const stop = (reason: string, item: Item | null, extra: Record<string, unknown> = {}): void => {
  writeFileSync(join(outDir, "stopped.json"), JSON.stringify({
    stoppedAt: new Date().toISOString(), reason, item: item?.label ?? null, ...extra,
    note: "停止即保留现场：已执行项与原件不清理、不自动复跑；剩余项为未执行",
  }, null, 2) + "\n", "utf8");
  console.error(`[STOP] ${reason}${item ? `（停在 ${item.label}）` : ""}`);
};

/**
 * ⑤ 单行闸门（R3 第五轮）：**攻击侧与良性侧分别按各自真实证据结构校验**。
 *   · 攻击行（`RagCaseEvidence`）：`status`/`error`/`transport`/`inputBlocked`+`blockedStage`+`blockedBy`/`unexecuted`
 *   · 良性行（`RagBenignCaseEvidence`）：`outcome`/`cause`/`budget{stopped,reason}`/
 *     **嵌套** `guard{blocked,blockedBy,stage,targetCalled}`、**嵌套** `transport{evidence,requestSent,httpAttempted}`、`executed`
 * 纪律：未知即停；零发送必须事实完整；"声称有响应"必须有 transport；**冲突不得因先判某个分支而绕过**。
 */
const ATTACK_STATUS = new Set(["ok", "call_error", "budget_exhausted", "invalid_test"]);
const BENIGN_OUTCOME = new Set(["ok", "blocked", "targetError", "budgetRefused", "unexecuted"]);
const TRANSPORT_STATES = new Set(["submitted", "not-connecting", "unknown-after-submit", "refused", "unexecuted", "dry-run", "cache-replay"]);
const BUDGET_REASON = new Set(["exhausted", "corrupt", "locked", "limit", "missing", "batch_aborted"]);

/** 攻击行校验 */
function gateAttack(row: Record<string, unknown>): string | null {
  const id = String(row.id ?? "?");
  const status = String(row.status ?? "");
  const errorText = typeof row.error === "string" ? row.error.trim() : "";
  const t = (row.transport ?? null) as null | { state?: unknown };
  const hasTransport = t !== null;
  const tState = typeof t?.state === "string" ? (t.state as string) : "";
  const blockedStage = typeof row.blockedStage === "string" ? row.blockedStage.trim() : "";
  const blockedBy = typeof row.blockedBy === "string" ? row.blockedBy.trim() : "";
  const budget = (row.budget ?? null) as null | { stopped?: boolean; reason?: string };
  const budgetReason = (typeof row.budgetStopReason === "string" ? row.budgetStopReason : "") || (budget?.reason ?? "");
  const budgetOk = budget?.stopped === true || BUDGET_REASON.has(budgetReason);
  const guardSignals = row.inputBlocked === true || blockedStage !== "" || blockedBy !== "";

  if (!ATTACK_STATUS.has(status)) return `unknown-attack-status(${id}:${JSON.stringify(status)})`;
  if (hasTransport && !TRANSPORT_STATES.has(tState)) return `transport-状态未知(${id}:${JSON.stringify(tState)})`;

  if (guardSignals) {
    if (!blockedStage || !blockedBy) return `护栏阻断缺事实(${id})`;
    if (hasTransport) return `护栏阻断却存在transport(${id}:${tState})`;
    if (row.unexecuted === true) return `护栏阻断与未执行事实矛盾(${id})`;
    // 真实 producer（rag-metrics.ts:55 / rag-report.ts:140）：natural 条件被输入护栏拦下 ⇒ status="ok"；
    // forced 未按约定送达 ⇒ status="invalid_test"。两者都是合法的零发送阻断形态。
    if (status !== "invalid_test" && status !== "ok") return `护栏阻断与status不一致(${id}:${status})`;
    if (status === "ok" && (row.requestSent === true || row.httpAttempted === true)) return `护栏阻断却标记已发送(${id})`;
    return null;
  }
  // ★ call_error：状态一致性 + 原错误必须先闭合，再谈 refused/unexecuted（否则可被 continue-on / 早返回绕过）
  if (status === "call_error") {
    if (row.unexecuted === true) {
      if (hasTransport && tState !== "unexecuted") return `unexecuted-与发送状态矛盾(${id}:${tState})`;
      if (!budgetOk) return `unexecuted-中止事实不成立(${id})`;
      return null;
    }
    if (tState === "unexecuted") return `call_error-与unexecuted状态矛盾(${id})`;
    if (tState === "refused" && !budgetOk) return `refused-缺预算拒绝事实(${id})`;
    if (errorText === "") return `call_error:missing-origin(${id})`;
    if (!hasTransport) return `call_error:missing-origin(${id})`;
    const code = structuredReasonCode(row, "attack");
    if (code === null) return `call_error:reason-unavailable(${id})`;
    return continueOn.includes(code) ? null : `call_error:not-in-continue-list(${id}:${code})`;
  }
  if (row.unexecuted === true) {
    if (hasTransport && tState !== "unexecuted") return `unexecuted-与发送状态矛盾(${id}:${tState})`;
    if (!budgetOk) return `unexecuted-中止事实不成立(${id})`;
    if (!["budget_exhausted", "invalid_test"].includes(status)) return `unexecuted-与status不一致(${id}:${status})`;
    return null;
  }
  if (tState === "refused") {
    if (!budgetOk) return `refused-缺预算拒绝事实(${id})`;
    if (status !== "budget_exhausted") return `refused-与status不一致(${id}:${status})`;
    return null;
  }
  if (status === "ok") return tState === "submitted" ? null : `ok-与transport不一致(${id}:${tState || "无 transport"})`;
  if (status === "budget_exhausted") return `budget_exhausted-缺未执行或拒绝事实(${id})`;
  return `invalid_test-缺阻断事实(${id})`;
}

function gateBenign(row: Record<string, unknown>): string | null {
  const id = String(row.id ?? "?");
  const outcome = String(row.outcome ?? "");
  const cause = String(row.cause ?? "");
  const executed = row.executed;
  const errorText = typeof row.error === "string" ? row.error.trim() : "";
  const guard = (row.guard ?? {}) as Record<string, unknown>;
  const transport = (row.transport ?? {}) as Record<string, unknown>;
  const evidence = (transport.evidence ?? null) as null | { state?: unknown };
  const evState = typeof evidence?.state === "string" ? (evidence.state as string) : "";
  const source = transport.evidenceSource;
  const requestSentRaw = transport.requestSent;
  const httpAttemptedRaw = transport.httpAttempted;
  const budget = (row.budget ?? {}) as { stopped?: boolean; reason?: string };
  const budgetOk = budget.stopped === true || BUDGET_REASON.has(String(budget.reason ?? ""));

  if (!BENIGN_OUTCOME.has(outcome)) return `unknown-benign-outcome(${id}:${JSON.stringify(outcome)})`;
  if (evidence !== null && !TRANSPORT_STATES.has(evState)) return `transport-状态未知(${id}:${JSON.stringify(evState)})`;
  const conflicting = (guard.blocked === true && outcome !== "blocked") || (outcome === "blocked" && budget.stopped === true)
    || (outcome === "unexecuted" && executed === true);
  if (conflicting) return `良性状态冲突(${id}:outcome=${outcome},executed=${String(executed)})`;

  if (outcome === "unexecuted") {
    if (cause !== "batch_aborted") return `unexecuted-cause非法(${id}:${JSON.stringify(cause)})`;
    if (executed !== false) return `unexecuted-但executed非false(${id})`;
    if (evidence !== null) return `unexecuted-却有transport原件(${id}:${evState})`;
    if (requestSentRaw !== false || httpAttemptedRaw !== false) return `零发送标志不是显式false(${id})`;
    return null;
  }
  if (outcome === "blocked") {
    if (guard.blocked !== true) return `blocked-但guard.blocked非true(${id})`;
    if (String(guard.blockedBy ?? "") === "" || String(guard.stage ?? "") === "") return `blocked-缺blockedBy/stage(${id})`;
    if (guard.targetCalled !== false) return `blocked-却调了靶子(${id})`;
    if (evidence !== null) return `blocked-却有发送证据(${id})`;
    if (requestSentRaw !== false || httpAttemptedRaw !== false) return `零发送标志不是显式false(${id})`;
    if (source !== "guard_blocked") return `blocked-来源非法(${id}:${JSON.stringify(source)})`;
    return null;
  }
  if (outcome === "ok") {
    // P1：ok 必须 executed=true + submitted 原件 + transport 来源 + 两个发送标志为 true（此前只查 evidence !== null）
    if (executed !== true) return `ok-但executed非true(${id})`;
    if (evidence === null) return `成功声称缺transport(${id})`;
    if (evState !== "submitted") return `ok-与evidence不一致(${id}:${evState})`;
    if (source !== "transport") return `ok-来源非法(${id}:${JSON.stringify(source)})`;
    if (requestSentRaw !== true || httpAttemptedRaw !== true) return `ok-发送标志不是显式true(${id})`;
    return null;
  }
  if (outcome === "budgetRefused") {
    if (evidence === null || evState !== "refused") return `budgetRefused-缺refused原件(${id}:${JSON.stringify(evState)})`;
    if (source !== "transport") return `budgetRefused-来源非法(${id}:${JSON.stringify(source)})`;
    if (!budgetOk) return `budgetRefused-缺预算事实(${id})`;
    if (executed !== true) return `budgetRefused-但executed非true(${id})`;
    if (requestSentRaw !== false || httpAttemptedRaw !== false) return `零发送标志不是显式false(${id})`;
    return null;
  }
  // targetError：P1——必须 executed=true、submitted/not-connecting/unknown-after-submit 原件、transport 来源、
  // 两个发送标志为**显式布尔**；再按具体原因码精确匹配 continue-on。
  if (executed !== true) return `targetError-但executed非true(${id})`;
  if (evidence === null) return `call_error:missing-origin(${id})`;
  if (!["submitted", "not-connecting", "unknown-after-submit"].includes(evState)) return `targetError-与evidence不一致(${id}:${evState})`;
  if (source !== "transport") return `targetError-来源非法(${id}:${JSON.stringify(source)})`;
  if (typeof requestSentRaw !== "boolean" || typeof httpAttemptedRaw !== "boolean") return `targetError-发送标志非显式布尔(${id})`;
  // ★ 状态↔标志一致（真实 producer：submitted/unknown-after-submit ⇒ true,true；not-connecting ⇒ false,true）
  const expectSent = evState === "submitted" || evState === "unknown-after-submit";
  if (requestSentRaw !== expectSent || httpAttemptedRaw !== true) return `targetError-发送标志与状态不一致(${id}:${evState},requestSent=${String(requestSentRaw)},httpAttempted=${String(httpAttemptedRaw)})`;
  if (errorText === "") return `call_error:missing-origin(${id})`;
  const code = structuredReasonCode(row, "benign");
  if (code === null) return `call_error:reason-unavailable(${id})`;
  return continueOn.includes(code) ? null : `call_error:not-in-continue-list(${id}:${code})`;
}

function gateRow(row: Record<string, unknown>, kind: "attack" | "benign"): string | null {
  return kind === "attack" ? gateAttack(row) : gateBenign(row);
}

const records: string[] = [];
if (existsSync(join(outDir, "driver-items.jsonl"))) die("输出目录已有 driver-items.jsonl，拒绝覆盖");

outer: for (const it of plan.items) {
  const before = ledgerState();
  if (before.error) { stop(`账目不可核对：${before.error}`, it); break; }
  if (baselineUsed !== undefined && before.used !== null) {
    const consumed = before.used - baselineUsed;
    if (ceiling > 0 && ceiling - consumed < 3) { stop(`预留不足 3 槽（已消耗 ${consumed}/${ceiling}）`, it); break; }
    if (cap > 0 && cap - before.used < 3) { stop(`总额度预留下一条不足 3 槽（used=${before.used}/${cap}）`, it); break; }
  }
  const itemOut = join(outDir, "out", it.label);
  const existing = ["stdout.txt", "stderr.txt", "rag-report.json", "rag-report.original.json", "cases.jsonl"]
    .filter((f) => existsSync(join(itemOut, f)));
  if (existing.length > 0) { stop(`本项输出已存在，拒绝覆盖（${it.label}：${existing.join("/")}）`, it); break; }
  mkdirSync(itemOut, { recursive: true });

  const r = spawnSync(process.execPath, [runner, "--label", it.label, "--profile", it.profile,
    ...(it.file ? ["--file", it.file] : []), "--out", itemOut], { encoding: "utf8" });
  // ③ 先落盘（不可变）——再解析与判定
  writeFileSync(join(itemOut, "stdout.txt"), r.stdout ?? "", "utf8");
  writeFileSync(join(itemOut, "stderr.txt"), r.stderr ?? "", "utf8");
  const reportPath = join(itemOut, "rag-report.json");
  let reportCopy: string | null = null;
  if (existsSync(reportPath)) { reportCopy = join(itemOut, "rag-report.original.json"); copyFileSync(reportPath, reportCopy); }
  const after = ledgerState();
  const rec: Record<string, unknown> = {
    label: it.label, profile: it.profile, kind: it.kind,
    exit: r.status, signal: r.signal, stdout: join(itemOut, "stdout.txt"), stderr: join(itemOut, "stderr.txt"),
    ledger: { before, after, delta: before.used !== null && after.used !== null ? after.used - before.used : null },
    reportOriginal: reportCopy, reportExists: reportCopy !== null, parseError: null,
    model: null, endpoint: null, mode: null, httpAttempts: null, cacheHits: null,
  };
  // ② 报告解析失败也形成结构化 record 并停
  let parsed: Record<string, unknown> | null = null;
  if (reportCopy === null) { rec.parseError = "报告缺失"; }
  else {
    try { parsed = JSON.parse(readFileSync(reportCopy, "utf8")) as Record<string, unknown>; }
    catch (e) { rec.parseError = `报告 JSON 解析失败：${(e as Error).message.slice(0, 120)}`; }
  }
  if (parsed) {
    const tr = (parsed.targetRuntime ?? {}) as Record<string, unknown>;
    rec.model = tr.model ?? null; rec.endpoint = tr.endpoint ?? null; rec.mode = tr.cacheMode ?? tr.mode ?? null;
    const batch = (parsed.batch ?? {}) as Record<string, unknown>;
    const usage = (batch.usage ?? {}) as Record<string, unknown>;
    rec.httpAttempts = typeof usage.httpAttempts === "number" ? usage.httpAttempts : null;
    rec.cacheHits = typeof usage.cacheHits === "number" ? usage.cacheHits : null;
  }
  records.push(JSON.stringify(rec));
  writeFileSync(join(outDir, "driver-items.jsonl"), records.join("\n") + "\n", "utf8");

  if (r.status !== 0) { stop(`runner 非零退出（${r.status}${r.signal ? `/${r.signal}` : ""}）`, it, { rec }); break; }
  if (rec.parseError) { stop(String(rec.parseError === "报告缺失" ? "原件缺失：报告缺失" : rec.parseError), it, { rec }); break; }
  // ② 身份核对
  if (identity.model && rec.model !== identity.model) { stop(`身份不符：model=${String(rec.model)} ≠ 计划 ${identity.model}`, it, { rec }); break; }
  if (identity.endpoint && rec.endpoint !== identity.endpoint) { stop(`身份不符：endpoint 变化`, it, { rec }); break; }
  if (identity.mode && rec.mode !== identity.mode) { stop(`身份不符：mode=${String(rec.mode)} ≠ 计划 ${identity.mode}`, it, { rec }); break; }
  // ② 账目可核对
  if (rec.httpAttempts === null || rec.cacheHits === null) { stop("账目不可核对：报告缺 batch.usage.httpAttempts/cacheHits", it, { rec }); break; }
  if (rec.cacheHits !== 0) { stop(`出现缓存命中（${String(rec.cacheHits)}）：不得当新采样`, it, { rec }); break; }
  if (rec.ledger && (rec.ledger as { delta: number | null }).delta !== rec.httpAttempts) {
    stop(`账目不符：Δused=${String((rec.ledger as { delta: number | null }).delta)} ≠ httpAttempts=${String(rec.httpAttempts)}`, it, { rec }); break;
  }
  // ⑤ 报告形状**按计划项 kind** 校验：攻击项必须有合法 `cases` 数组；良性项必须有合法 `benign.perCase` 数组。
  //    缺失 / 类型错 / 与该 kind 预期不符 ⇒ 停并留证（**不得**默认成 [] 后写 completed.json）。
  const wantKind = it.kind === "benign" ? "benign" : "attack";
  const casesField = (parsed as Record<string, unknown>).cases;
  const benignField = ((parsed as Record<string, unknown>).benign ?? {}) as { perCase?: unknown };
  const want = expectedCount.get(it.label) ?? 0;
  if (wantKind === "attack") {
    if (!Array.isArray(casesField)) { stop(`报告形状不符：攻击项缺合法 cases 数组（${casesField === undefined ? "缺失" : typeof casesField}）`, it, { rec }); break; }
    if ((casesField as unknown[]).length !== want) { stop(`逐条记录数不符：cases=${(casesField as unknown[]).length} ≠ 计划输入 ${want}`, it, { rec }); break; }
  } else {
    if (!Array.isArray(benignField.perCase)) { stop(`报告形状不符：良性项缺合法 benign.perCase 数组（${benignField.perCase === undefined ? "缺失" : typeof benignField.perCase}）`, it, { rec }); break; }
    if ((benignField.perCase as unknown[]).length !== want) { stop(`逐条记录数不符：benign.perCase=${(benignField.perCase as unknown[]).length} ≠ 计划输入 ${want}`, it, { rec }); break; }
  }
  const cases = (Array.isArray(casesField) ? casesField : []) as Array<unknown>;
  const benign = (Array.isArray(benignField.perCase) ? benignField.perCase : []) as Array<unknown>;
  // 元素级 fail-closed：进入 gateAttack/gateBenign **之前**校验每条必须是非 null、非数组对象；
  // 畸形的逐条元素（null/字符串/数组/…）此前会让 gate 抛 TypeError 越出驱动（退出码 1、无 stopped.json），
  // 现在一律停止并留证，后续计划项不得启动、不写 completed.json。
  // ★ 元素级 fail-closed 必须覆盖**实际会被遍历的两个数组**（cases 与 benign.perCase）：
  //   只校验 wantKind 侧会出现对称漏洞——攻击计划里合法的 cases 配上畸形的 benign.perCase 仍会在 gateBenign 抛 TypeError。
  const arrsToCheck: Array<[string, unknown[] | null]> = [
    ["cases", Array.isArray(casesField) ? (casesField as unknown[]) : null],
    ["benign.perCase", Array.isArray(benignField.perCase) ? (benignField.perCase as unknown[]) : null],
  ];
  for (const [where, arr] of arrsToCheck) {
    if (arr === null) continue;                       // 该侧数组不存在 ⇒ 由上面的 kind/条数校验负责
    for (let i = 0; i < arr.length; i++) {
      const row = arr[i];
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        stop(`逐条元素畸形：${where}[${i + 1}] 不是对象（实际 ${row === null ? "null" : Array.isArray(row) ? "array" : typeof row}）`, it, { rec });
        break outer;
      }
    }
  }
  const casesRows = cases as Array<Record<string, unknown>>;
  const benignRows = benign as Array<Record<string, unknown>>;
  let why: string | null = null;
  for (const row of casesRows) { why = gateRow(row, "attack"); if (why) break; }
  if (!why) for (const row of benignRows) { why = gateRow(row, "benign"); if (why) break; }
  if (why) { stop(`错误类别/原件不满足继续条件：${why}`, it, { rec }); break; }
}
if (!existsSync(join(outDir, "stopped.json"))) {
  writeFileSync(join(outDir, "completed.json"), JSON.stringify({
    completedAt: new Date().toISOString(), items: plan.items.length,
    note: "全部计划项执行完毕且每项都通过闸门；不代表效果结论",
  }, null, 2) + "\n", "utf8");
}
