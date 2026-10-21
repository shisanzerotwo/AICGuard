/**
 * 预算账本（P1，返工加严）—— `docs/15` §5.2「原子额度占用 + 硬上限」的唯一实现。
 *
 * 为什么必须存在（现场事实，见 `docs/37` §0）：
 *   · 真实 HTTP 尝试**不在引擎里**：引擎走 `spawnSync` 调 `llm-bridge.mjs`；
 *   · bridge 内部**最多 3 次**尝试（429/5xx 退避 2s/5s）⇒ 按 spawn 次数估算会**低估 3 倍**；
 *   · 因此「发送前原子占用额度」只能在 **bridge** 里做，账本口径一律是**底层 HTTP 尝试次数**。
 *
 * 三条纪律（逐条对应 §5.2）：
 *   ① **发送前**占用：拿不到额度就**不发请求**（调用方必须让异常向上冒）；
 *   ② 失败/超时**同样计数**（一经发出即消耗）；**缓存命中不扣额度**（缓存路径根本不进 bridge）；
 *   ③ `--yes` / 任何"确认"标志**不得越过硬上限**：上限只能在同一账本内**收紧**，不能抬升。
 *
 * 返工加严（用户裁定，2026-10-13）——**四类失败必须分别记录且都失败关闭**：
 *   · `BudgetExceededError`（真耗尽，可重跑续测）
 *   · `BudgetCorruptError`（账本内容损坏/自相矛盾）
 *   · `BudgetLockError`（锁冲突/锁残留）
 *   · `BudgetLimitError`（上限规则被违反：新账本超首批上限、试图抬升、收紧到低于已用）
 * 以及账本的**结构校验**：`limit`/`used` 必须是安全整数、`used ≤ limit`、
 * `1 ≤ limit ≤ FIRST_BATCH_LIMIT`、每条条目字段合法、且 **`Σentries.n === used`**（累计一致性）。
 * 为什么连"累计一致"都要查：只有这样才能发现"被截断/被手改/半截写入"的账本 ——
 * 单看字段类型是查不出"用了 3 次却只留 2 条目"的。
 *
 * 刻意不做的事：不自动抢锁（拿不到锁时**失败关闭**，因为"放弃消耗额度"比"绕开上限"安全）。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface BudgetEntry {
  at: string;
  /** 谁占用的：`bridge` / `llm` / `agent` / 具体脚本名 / `budget`（账本自身的收紧记录） */
  source: string;
  /** 本次占用次数（正数 = 消耗；0 = 上限收紧等不改变额度的记录） */
  n: number;
  note?: string;
}

export interface BudgetLedger {
  schemaVersion: 1;
  runId: string;
  /** 硬上限（底层 HTTP 尝试次数） */
  limit: number;
  /** 已占用 */
  used: number;
  createdAt: string;
  entries: BudgetEntry[];
}

/**
 * 首批硬上限（`docs/15` §5.2 的总表：200 次，所有入口共享）。
 * **任何新建账本都不得超过它** —— 这样"新开一个账本把上限写成 201"这条绕过路就被堵死了。
 * 将来要跑更大批次（§5.2 明说"不属于本次 200 次承诺"）必须**改这个常量并留痕**（用户批准 + 文档记录），
 * 而不是靠 CLI/env 临时抬升（那正是本模块要禁止的）。
 */
export const FIRST_BATCH_LIMIT = 200;
export const DEFAULT_BUDGET_LIMIT = FIRST_BATCH_LIMIT;
export const DEFAULT_BUDGET_PATH = join("runs", "budget.json");

/** 预算机制拦下并中止的原因（**分别记录**，不合并成"一种错"） */
export type BudgetStopKind = "exhausted" | "corrupt" | "locked" | "limit" | "missing";

export class BudgetError extends Error {
  kind: BudgetStopKind;
  constructor(kind: BudgetStopKind, message: string) {
    super(message);
    this.name = "BudgetError";
    this.kind = kind;
  }
}

/** 真耗尽：额度用完（可重跑续测） */
export class BudgetExceededError extends BudgetError {
  requested: number;
  used: number;
  limit: number;
  source: string;

  constructor(requested: number, used: number, limit: number, source: string) {
    super("exhausted", `额度不足：本次申请 ${requested} 次、已用 ${used}/${limit}（来源 ${source}）—— 已在**发送前**阻止，未发出请求`);
    this.name = "BudgetExceededError";
    this.requested = requested;
    this.used = used;
    this.limit = limit;
    this.source = source;
  }
}

/** 账本损坏/自相矛盾（不猜、不清零） */
export class BudgetCorruptError extends BudgetError {
  constructor(message: string) {
    super("corrupt", message);
    this.name = "BudgetCorruptError";
  }
}

/** 锁冲突/锁残留（不抢锁） */
export class BudgetLockError extends BudgetError {
  constructor(message: string) {
    super("locked", message);
    this.name = "BudgetLockError";
  }
}

/** 违反上限规则（新账本超首批上限 / 试图抬升 / 收紧到低于已用） */
export class BudgetLimitError extends BudgetError {
  constructor(message: string) {
    super("limit", message);
    this.name = "BudgetLimitError";
  }
}

/** 把任意异常归类成预算中止原因（非预算异常返回 null） */
export function budgetStopKindOf(e: unknown): BudgetStopKind | null {
  return e instanceof BudgetError ? e.kind : null;
}

const nowIso = (): string => new Date().toISOString();
const lockPathOf = (p: string): string => `${p}.lock`;
const isSafeInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** 同步睡眠（零依赖）：Node 无同步 sleep，用 `Atomics.wait` 阻塞当前线程 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 跨进程互斥：`openSync(lock, "wx")` 是两平台都成立的最小原语。
 * 拿不到锁 ⇒ 有限重试后抛 `BudgetLockError`（失败关闭）；**不抢锁**（持有者可能正在写额度）。
 */
function withLedgerLock<T>(ledgerPath: string, fn: () => T): T {
  const lock = lockPathOf(ledgerPath);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const deadline = Date.now() + 3000;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() > deadline) {
        throw new BudgetLockError(`预算账本锁被占用超过 3s：${lock}`
          + "（进程被中断会留下锁文件；确认无写者后手动删除该文件再重跑 —— 本模块不自动抢锁）");
      }
      sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(lock); } catch { /* 已释放或从未创建 */ }
  }
}

/**
 * 账本结构校验（**唯一的合法性入口**）。任何不符 ⇒ `BudgetCorruptError`（不猜、不修、不清零）。
 * 注意 `limit > FIRST_BATCH_LIMIT` 也算**损坏**（它只可能来自手改或旧版本写坏的账本）——
 * "新建时就超过首批上限"是另一条路（由 `ensureLocked` 抛 `BudgetLimitError`）。
 */
export function validateLedger(obj: unknown, path: string): BudgetLedger {
  // 用**函数声明**（不是箭头 const）：TS 只对带显式返回类型注解的函数声明做 never-返回分析，
  // 这样才能在调用后正确收窄（否则会报 'possibly undefined' 一堆假错）。
  function bad(why: string): never {
    throw new BudgetCorruptError(`预算账本损坏（${why}）：${path}`
      + " ⇒ 拒绝按它记账（失败关闭）。确认后可删掉该文件重来（本模块不静默清零）");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) bad("不是对象");
  const l = obj as Partial<BudgetLedger>;
  if (l.schemaVersion !== 1) bad(`schemaVersion 应为 1，实为 ${String(l.schemaVersion)}`);
  if (typeof l.runId !== "string" || l.runId === "") bad("runId 缺失或非字符串");
  if (typeof l.createdAt !== "string" || l.createdAt === "") bad("createdAt 缺失或非字符串");
  const limit = l.limit;
  const used = l.used;
  if (!isSafeInt(limit)) bad(`limit 必须是安全整数，实为 ${String(limit)}`);
  if (limit < 1) bad(`limit 必须 ≥1，实为 ${limit}`);
  if (limit > FIRST_BATCH_LIMIT) bad(`limit=${limit} 超出首批上限 ${FIRST_BATCH_LIMIT}`);
  if (!isSafeInt(used)) bad(`used 必须是安全整数，实为 ${String(used)}`);
  if (used < 0) bad(`used 必须 ≥0，实为 ${used}`);
  if (used > limit) bad(`used=${used} 大于 limit=${limit}`);
  if (!Array.isArray(l.entries)) bad("entries 不是数组");
  let sum = 0;
  for (const [i, e] of (l.entries as unknown[]).entries()) {
    if (typeof e !== "object" || e === null) bad(`entries[${i}] 不是对象`);
    const en = e as Partial<BudgetEntry>;
    if (typeof en.at !== "string" || en.at === "") bad(`entries[${i}].at 非法`);
    if (typeof en.source !== "string" || en.source === "") bad(`entries[${i}].source 非法`);
    const n = en.n;
    if (!isSafeInt(n)) bad(`entries[${i}].n 必须是安全整数，实为 ${String(n)}`);
    if (n < 0) bad(`entries[${i}].n 必须 ≥0，实为 ${n}`);
    if (en.note !== undefined && typeof en.note !== "string") bad(`entries[${i}].note 非法`);
    sum += n;
  }
  if (sum !== l.used) bad(`条目累计 ${sum} 与 used=${l.used} 不一致`);
  return l as BudgetLedger;
}

/** 读账本；损坏即抛 `BudgetCorruptError`（不猜、不静默清零） */
export function readLedger(path: string): BudgetLedger {
  const raw = readFileSync(path, "utf8");
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new BudgetCorruptError(`预算账本不是合法 JSON：${path} ⇒ ${(e as Error).message}`
      + "（不猜、不静默清零；确认后可删掉该文件重来）");
  }
  return validateLedger(obj, path);
}

/** 原子写：先写临时文件再 rename（被中断也不会留下半截账本） */
function writeLedger(path: string, l: BudgetLedger): void {
  validateLedger(l, path); // 自己写的也不放行非法状态（防止"收紧操作生成不一致账本"）
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(l, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/**
 * 建立 / 读取 / **收紧**账本（须在持锁状态下调用）。三条上限规则：
 *   ① 新建：`limit` 不得超过 `FIRST_BATCH_LIMIT`（否则 `BudgetLimitError`）；
 *   ② 已有：只允许**下调**，上调 ⇒ `BudgetLimitError`（`--yes` 之类确认标志不得越过硬上限）；
 *   ③ 下调不得低于**已用**（否则会造出 used>limit 的不一致账本）⇒ `BudgetLimitError`。
 */
function ensureLocked(path: string, limit: number | undefined, runId: string): BudgetLedger {
  if (existsSync(path)) {
    const cur = readLedger(path);
    if (limit !== undefined && limit !== cur.limit) {
      if (limit > cur.limit) {
        throw new BudgetLimitError(`不得抬升已有账本的硬上限：${path} 现为 ${cur.limit}，请求 ${limit}`
          + "（`--yes` 之类确认标志不得越过硬上限；换批次请换账本文件）");
      }
      if (limit < cur.used) {
        throw new BudgetLimitError(`不得把上限收紧到低于已用：${path} 已用 ${cur.used}，请求上限 ${limit}`
          + "（那会造出 used>limit 的不一致账本）");
      }
      const next: BudgetLedger = {
        ...cur,
        limit,
        entries: [...cur.entries, { at: nowIso(), source: "budget", n: 0, note: `收紧上限 ${cur.limit} → ${limit}` }],
      };
      writeLedger(path, next);
      return next;
    }
    return cur;
  }
  if (limit !== undefined && limit > FIRST_BATCH_LIMIT) {
    throw new BudgetLimitError(`新账本的硬上限不得超过首批上限 ${FIRST_BATCH_LIMIT}（请求 ${limit}）：${path}`
      + "（换批次/更大批次需用户批准后修改 src/budget.ts 的 FIRST_BATCH_LIMIT 并留痕，不走 CLI/env 临时抬升）");
  }
  const fresh: BudgetLedger = {
    schemaVersion: 1,
    runId,
    limit: limit ?? DEFAULT_BUDGET_LIMIT,
    used: 0,
    createdAt: nowIso(),
    entries: [],
  };
  writeLedger(path, fresh);
  return fresh;
}

export interface BudgetView {
  runId: string;
  limit: number;
  used: number;
  remaining: number;
  path: string;
}

export const viewOf = (path: string, l: BudgetLedger): BudgetView => ({
  runId: l.runId, limit: l.limit, used: l.used, remaining: l.limit - l.used, path,
});

/** 建立/读取账本（幂等）。上限只能收紧，不能抬升。 */
export function ensureLedger(path: string, opts: { limit?: number; runId?: string } = {}): BudgetView {
  return withLedgerLock(path, () => viewOf(path, ensureLocked(path, opts.limit, opts.runId ?? basename(path, ".json"))));
}

/**
 * **发送前**占用 n 次配额；不足即抛 `BudgetExceededError`（调用方不得发请求）。
 * 一经返回即代表这 n 次已计入账本 —— 失败、超时、进程中断都不退回（§5.2）。
 */
export function reserveAttempts(path: string, n: number, source: string, opts: { limit?: number; runId?: string } = {}): BudgetView {
  if (!Number.isSafeInteger(n) || n <= 0) throw new BudgetLimitError(`申请次数必须是正的安全整数，收到 ${String(n)}`);
  return withLedgerLock(path, () => {
    const cur = ensureLocked(path, opts.limit, opts.runId ?? basename(path, ".json"));
    if (cur.used + n > cur.limit) throw new BudgetExceededError(n, cur.used, cur.limit, source);
    const next: BudgetLedger = {
      ...cur,
      used: cur.used + n,
      entries: [...cur.entries, { at: nowIso(), source, n }],
    };
    writeLedger(path, next);
    return viewOf(path, next);
  });
}

/** 只读查看（不建账本；文件不存在返回 null） */
export function peekLedger(path: string): BudgetView | null {
  if (!existsSync(path)) return null;
  return viewOf(path, readLedger(path));
}

/**
 * 解析环境里的账本配置（供各入口共用；`AICGUARD_BUDGET` / `AICGUARD_BUDGET_LIMIT`）。
 * 相对路径按 `repoRoot` 解析（与 M3-4 三态环境变量同一纪律：**不用 cwd**）。
 */
export function resolveBudgetEnv(repoRoot: string, env: NodeJS.ProcessEnv = process.env): { path: string; limit: number | undefined } {
  const rawPath = env.AICGUARD_BUDGET?.trim();
  const path = rawPath ? (isAbsolute(rawPath) ? rawPath : join(repoRoot, rawPath)) : join(repoRoot, DEFAULT_BUDGET_PATH);
  const rawLimit = env.AICGUARD_BUDGET_LIMIT?.trim();
  const limit = rawLimit ? Number(rawLimit) : undefined;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new BudgetLimitError(`AICGUARD_BUDGET_LIMIT 必须是 ≥1 的安全整数，收到 ${rawLimit}`);
  }
  if (limit !== undefined && limit > FIRST_BATCH_LIMIT) {
    throw new BudgetLimitError(`AICGUARD_BUDGET_LIMIT=${limit} 超过首批上限 ${FIRST_BATCH_LIMIT}`
      + "（环境变量也不能抬升硬上限；更大批次需改 FIRST_BATCH_LIMIT 并留痕）");
  }
  return { path, limit };
}
