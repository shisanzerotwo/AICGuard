/**
 * 预算账本回归测试（P1）—— `docs/15` §5.2 的三条硬要求 + §5.3 的明文反例。
 *
 * 为什么这些断言长这样（口径问题，读之前先知道）：
 *   · 真实 HTTP 尝试**不在引擎里**：引擎 spawn `llm-bridge.mjs`，bridge 内部**最多 3 次**尝试
 *     （429/5xx 退避）⇒ 账本口径必须是 **HTTP 尝试次数**，按 spawn 次数估算会低估 3 倍；
 *   · 因此"发送前占用"落在 **bridge** 里；本文件既测账本本身，也测**真实 bridge**的行为
 *     （用 `127.0.0.1:9`（discard 端口）做"目标不可达"，全程离线、不出网）。
 *
 * 覆盖（逐条对应任务卡 `docs/37` §1.3）：
 *   ① 建立/默认上限；② 上限只能收紧、**没有任何"确认后放行"的入口**（⇒ `--yes` 结构性无法越墙）；
 *   ③ 用满即拒（且账本不被写脏）；④ 账本损坏/结构不符 ⇒ 抛错不静默清零；⑤ 锁被占 ⇒ **失败关闭**；
 *   ⑥ ★反例：limit=1 + 目标不可达 ⇒ 恰 1 次真实尝试，**第 2 次在发送前被阻止**；
 *   ⑦ 缓存命中**不进 bridge** ⇒ 不扣额度（阴性对照，用替身桥记录 spawn 次数）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BudgetExceededError, DEFAULT_BUDGET_LIMIT, budgetStopKindOf, ensureLedger, peekLedger, readLedger, reserveAttempts, resolveBudgetEnv } from "../src/budget.ts";
import { LlmBot } from "../src/targets/llmbot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const WORK = join(TS_ROOT, "runs", "_tmp-budget-test");
const STUB = join(HERE, "fixtures", "bridge-budget-stub.mjs");
const RESERVE_ONCE = join(HERE, "fixtures", "budget-reserve-once.mjs");

function freshDir(name: string): string {
  const d = join(WORK, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

test("① 建立与默认：首次创建用默认上限；显式 limit 生效；peek 不建账本", () => {
  const dir = freshDir("t1");
  const p = join(dir, "budget.json");
  assert.equal(peekLedger(p), null, "账本不存在时 peek 返回 null（不创建）");
  assert.equal(existsSync(p), false);

  const v = ensureLedger(p, { runId: "run-a" });
  assert.equal(v.limit, DEFAULT_BUDGET_LIMIT, `默认上限应为 ${DEFAULT_BUDGET_LIMIT}（docs/15 §5.2）`);
  assert.equal(v.used, 0);
  assert.equal(v.remaining, DEFAULT_BUDGET_LIMIT);
  assert.equal(readLedger(p).runId, "run-a");

  const dir2 = freshDir("t1b");
  const p2 = join(dir2, "budget.json");
  assert.equal(ensureLedger(p2, { runId: "run-b", limit: 5 }).limit, 5, "显式 limit 生效");
});

test("② 上限只能收紧、不能抬升；且**没有**任何“确认后放行”的入口（--yes 结构性无法越墙）", () => {
  const dir = freshDir("t2");
  const p = join(dir, "budget.json");
  ensureLedger(p, { runId: "run", limit: 3 });
  assert.throws(() => ensureLedger(p, { runId: "run", limit: 4 }), /不得抬升已有账本的硬上限/,
    "抬升上限必须被拒（确认标志不得越过硬上限）");
  assert.equal(ensureLedger(p, { runId: "run", limit: 2 }).limit, 2, "收紧是允许的（更安全的方向）");
  assert.equal(readLedger(p).limit, 2);
  // 机制层面的自证：即便调用方模仿 `--yes` 多传一个“确认”参数，也**没有任何效果**——
  // 越墙只能靠改上限，而改上限被上面拦住。（不用 Function.length：带默认值的参数不计入，容易写出假断言——实测踩过一次。）
  ensureLedger(p, { runId: "run", limit: 1 });
  reserveAttempts(p, 1, "bridge");
  const withConfirm = reserveAttempts as unknown as (path: string, n: number, source: string, opts: object, confirm?: boolean) => unknown;
  assert.throws(() => withConfirm(p, 1, "bridge", {}, true), (e: unknown) => e instanceof BudgetExceededError,
    "多传一个“确认”参数也不能放行（`--yes` 不得越过硬上限）");
});

test("③ 用满即拒：不足时抛 BudgetExceededError，且账本状态不被写脏", () => {
  const dir = freshDir("t3");
  const p = join(dir, "budget.json");
  ensureLedger(p, { runId: "run", limit: 2 });
  assert.equal(reserveAttempts(p, 2, "bridge").used, 2);
  const before = readFileSync(p, "utf8");
  assert.throws(() => reserveAttempts(p, 1, "bridge"), (e: unknown) => e instanceof BudgetExceededError);
  assert.equal(readFileSync(p, "utf8"), before, "被拒的申请不得改动账本");
  assert.equal(readLedger(p).used, 2, "被拒后已用不变");
  assert.equal(readLedger(p).entries.length, 1, "被拒的申请不入 entries（只记真实消耗）");
});

test("④ 账本损坏/自相矛盾 ⇒ 逐种形态都抛错，不静默清零（「不猜」纪律）", () => {
  const dir = freshDir("t4");
  const cases: Array<[string, string, RegExp]> = [
    ["非法 JSON", "{ 这不是 JSON", /不是合法 JSON/],
    ["缺 runId", JSON.stringify({ schemaVersion: 1, limit: 5, used: 0, createdAt: "x", entries: [] }), /runId/],
    ["used=-100", JSON.stringify({ schemaVersion: 1, runId: "r", limit: 10, used: -100, createdAt: "x", entries: [] }), /used/],
    ["used 非整数", JSON.stringify({ schemaVersion: 1, runId: "r", limit: 10, used: 1.5, createdAt: "x", entries: [] }), /used/],
    ["used>limit", JSON.stringify({ schemaVersion: 1, runId: "r", limit: 2, used: 3, createdAt: "x", entries: [{ at: "t", source: "s", n: 3 }] }), /大于 limit/],
    ["limit>首批上限", JSON.stringify({ schemaVersion: 1, runId: "r", limit: 201, used: 0, createdAt: "x", entries: [] }), /首批上限/],
    ["条目累计≠used", JSON.stringify({ schemaVersion: 1, runId: "r", limit: 10, used: 3, createdAt: "x", entries: [{ at: "t", source: "s", n: 2 }] }), /累计/],
    ["条目字段非法", JSON.stringify({ schemaVersion: 1, runId: "r", limit: 10, used: 1, createdAt: "x", entries: [{ at: "t", source: "", n: 1 }] }), /source/],
  ];
  for (const [name, body, re] of cases) {
    const p = join(dir, `${name.replace(/[^\w-]/g, "_")}.json`);
    writeFileSync(p, body, "utf8");
    // 两类入口都必须拒绝：只读校验与“要花额度”的占用
    assert.throws(() => readLedger(p), re, `${name}：readLedger 必须抛错`);
    assert.throws(() => reserveAttempts(p, 1, "t"), re, `${name}：reserveAttempts 必须抛错（失败关闭）`);
    assert.equal(readFileSync(p, "utf8"), body, `${name}：损坏文件不得被静默重写/清零`);
    // 分类：损坏必须归到 corrupt（与真耗尽/锁冲突分开记录）
    try { reserveAttempts(p, 1, "t"); } catch (e) { assert.equal(budgetStopKindOf(e), "corrupt", `${name}：归类应为 corrupt`); }
  }
});

test("⑨ 新账本 limit=201（或任何 >首批上限）⇒ 拒绝创建（不得靠换账本抬升上限）", () => {
  const dir = freshDir("t9");
  for (const limit of [201, 1000]) {
    const p = join(dir, `new-${limit}.json`);
    assert.throws(() => ensureLedger(p, { runId: "r", limit }), /首批上限/, `新账本 limit=${limit} 必须被拒`);
    assert.ok(!existsSync(p), "被拒时不得留下账本文件");
  }
  // 环境变量也不能抬升（否则--budget-limit 换个口子就绕过了）
  assert.throws(() => resolveBudgetEnv(TS_ROOT, { AICGUARD_BUDGET_LIMIT: "201" }), /首批上限/);
  // 阳性对照：等于上限是允许的（首批准的正是 200）
  assert.equal(ensureLedger(join(dir, "ok.json"), { runId: "r", limit: 200 }).limit, 200);
});

test("⑩ 不得把上限收紧到低于已用（那会造出 used>limit 的不一致账本）", () => {
  const dir = freshDir("t10");
  const p = join(dir, "budget.json");
  ensureLedger(p, { runId: "r", limit: 10 });
  reserveAttempts(p, 4, "bridge");
  assert.throws(() => ensureLedger(p, { runId: "r", limit: 3 }), /不得把上限收紧到低于已用/);
  const l = readLedger(p);
  assert.equal(l.used, 4);
  assert.equal(l.limit, 10, "被拒的收紧不得修改账本");
  // 边界：收紧到等于已用是允许的，且仍通过一致性校验（Σentries === used）
  const t = ensureLedger(p, { runId: "r", limit: 4 });
  assert.equal(t.limit, 4);
  assert.equal(t.remaining, 0);
  assert.equal(readLedger(p).limit, 4);
});

test("⑪ ★反例（docs/15 §5.3）：第 200 次失败重试后，第 201 次在发送前被阻止", () => {
  const dir = freshDir("t11");
  const p = join(dir, "budget.json");
  ensureLedger(p, { runId: "r" });          // 默认 200
  for (let i = 1; i <= 200; i++) reserveAttempts(p, 1, "bridge");
  assert.equal(readLedger(p).used, 200);
  assert.throws(() => reserveAttempts(p, 1, "bridge"), (e: unknown) => e instanceof BudgetExceededError,
    "第 201 次必须被拒（换账本也不行：新账本上限同样 ≤200）");
  assert.equal(readLedger(p).used, 200, "被拒后额度不增");
  // 已达上限的新账本也开不出来（双保险：换文件也抬不了上限）
  assert.throws(() => ensureLedger(join(dir, "other.json"), { runId: "r2", limit: 500 }), /首批上限/);
  // 真实 HTTP 层面的“发送前阻止”由 ⑥ 在 limit=1 上实测（等价情形，避免 200 次退避等待）
});

test("⑫ 四类失败必须分别归类（exhausted / corrupt / locked / limit），均失败关闭", () => {
  const dir = freshDir("t12");
  const p = join(dir, "budget.json");
  ensureLedger(p, { runId: "r", limit: 1 });
  reserveAttempts(p, 1, "bridge");
  const kinds: string[] = [];
  try { reserveAttempts(p, 1, "bridge"); } catch (e) { kinds.push(String(budgetStopKindOf(e))); }
  const corrupt = join(dir, "corrupt.json");
  writeFileSync(corrupt, "{}", "utf8");
  try { reserveAttempts(corrupt, 1, "bridge"); } catch (e) { kinds.push(String(budgetStopKindOf(e))); }
  const locked = join(dir, "locked.json");
  ensureLedger(locked, { runId: "r", limit: 5 });
  writeFileSync(`${locked}.lock`, "held", "utf8");
  try { reserveAttempts(locked, 1, "bridge"); } catch (e) { kinds.push(String(budgetStopKindOf(e))); }
  try { ensureLedger(join(dir, "new.json"), { runId: "r", limit: 201 }); } catch (e) { kinds.push(String(budgetStopKindOf(e))); }
  assert.deepEqual(kinds, ["exhausted", "corrupt", "locked", "limit"], "四类必须可区分（合并就看不到真因）");
});

test("⑤ 锁被占用 ⇒ 失败关闭（不抢锁、不放行）", () => {
  const dir = freshDir("t5");
  const p = join(dir, "budget.json");
  ensureLedger(p, { runId: "run", limit: 10 });
  writeFileSync(`${p}.lock`, "held by someone", "utf8");   // 模拟锁被别的写者持有
  assert.throws(() => reserveAttempts(p, 1, "bridge"), /预算账本锁被占用/,
    "拿不到锁必须报错（失败关闭）—— 因为“放弃消耗额度”比“绕开上限”安全");
  assert.equal(readLedger(p).used, 0, "被拒后额度一次未消耗");
});

test("⑥ ★反例（docs/15 §5.3）：limit=1 + 目标不可达 ⇒ 恰 1 次真实尝试，第 2 次在**发送前**被阻止", () => {
  const dir = freshDir("t6");
  const p = join(dir, "budget.json");
  const bot = new LlmBot({
    model: "probe-model", baseUrl: "http://127.0.0.1:9", apiKey: "k", systemPrompt: "s",
    cacheDir: "",                                   // 不缓存，避免掩盖真实尝试
    timeoutMs: 800,
    budget: { path: p, runId: "t6", limit: 1 },
  });
  const r = bot.respond("第一问");
  assert.equal(r.budgetExhausted, true, "额度耗尽必须**显式标记**（供上层标 budget_exhausted，而不是普通 call_error）");
  assert.match(r.error ?? "", /^budget_exhausted/, `错误前缀应点名预算，实际：${r.error}`);
  assert.equal(bot.httpAttempts, 1, "只发出了 1 次真实 HTTP 尝试（第 1 次失败后的重试被拦在发送前）");
  assert.equal(readLedger(p).used, 1, "账本口径 = HTTP 尝试次数（不是 spawn 次数，也不是 0）");
  assert.equal(r.usage?.requests, 1, "spawn 计数仍为 1（两个口径并存，报告里要写清）");
});

test("⑦ 阴性对照：缓存命中**不进 bridge** ⇒ 不扣额度", () => {
  const dir = freshDir("t7");
  const p = join(dir, "budget.json");
  const spawnLog = join(dir, "spawn.log");
  const cacheDir = join(dir, "cache");
  const prevBridge = process.env.AICGUARD_BRIDGE;
  const prevLog = process.env.STUB_SPAWN_LOG;
  process.env.AICGUARD_BRIDGE = STUB;        // 替身桥：每次进入就占用 1 次额度
  process.env.STUB_SPAWN_LOG = spawnLog;
  try {
    const mk = (): LlmBot => new LlmBot({
      model: "probe-model", baseUrl: "http://127.0.0.1:9", apiKey: "k", systemPrompt: "s",
      cacheDir, cacheMode: "fresh",
      budget: { path: p, runId: "t7", limit: 10 },
    });
    const first = mk().respond("同一个问题");
    assert.equal(first.text, "替身回答");
    assert.equal(readLedger(p).used, 1, "第一次（cache miss）进入 bridge ⇒ 占用 1 次");
    appendFileSync(spawnLog, "--- 分界 ---\n");

    const second = mk().respond("同一个问题");   // 同一身份 ⇒ 命中缓存
    assert.equal(second.text, "替身回答");
    assert.equal(readLedger(p).used, 1, "缓存命中不扣额度（docs/15 §5.2 明文）");
    const log = readFileSync(spawnLog, "utf8");
    assert.equal(log.split("--- 分界 ---")[1].trim(), "", "第二次**没有**被 spawn ⇒ 确实走的是缓存");
  } finally {
    if (prevBridge === undefined) delete process.env.AICGUARD_BRIDGE; else process.env.AICGUARD_BRIDGE = prevBridge;
    if (prevLog === undefined) delete process.env.STUB_SPAWN_LOG; else process.env.STUB_SPAWN_LOG = prevLog;
  }
});

test("⑧ 跨进程并发：limit=1 时 4 个进程同时申请 ⇒ 恰好 1 个成功（锁真的在起作用）", async () => {
  const dir = freshDir("t8");
  const p = join(dir, "budget.json");
  ensureLedger(p, { runId: "t8", limit: 1 });
  const reserveOnce = (): Promise<string> => new Promise((done) => {
    const c = spawn(process.execPath, [RESERVE_ONCE, p], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    c.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    c.on("exit", () => done(out.trim()));
  });
  const results = await Promise.all([reserveOnce(), reserveOnce(), reserveOnce(), reserveOnce()]);
  assert.equal(results.filter((r) => r === "OK").length, 1, `恰好一个成功，实际：${results.join(",")}`);
  assert.equal(results.filter((r) => r === "REJECTED").length, 3, "其余三个必须被拒（不是死锁、不是超发）");
  assert.equal(readLedger(p).used, 1, "额度不会被并发超发");
});
