/**
 * Work Loop 入口的**预算中止**验收（Codex 复核项 2）—— 真跑 `scripts/workloop-eval.ts`，零出网。
 *
 * 锁住四件事：
 *   ① 识别 `budgetExhausted`/`budgetStopReason`（原实现只当普通 targetError，一路跑完每次都被拒）；
 *   ② 中止后**停止全部后续良性/攻击/采样**（替身桥调用计数停在中止点）；
 *   ③ **先保存部分报告**（基线为空时也不许因为 return 2 丢掉已得结果）；
 *   ④ 报告含 executed / unexecuted / budgetStop / httpAttempts（三口径分列）；
 *   ⑤ 中止 ⇒ 退出码 2（未跑完不得伪装成 0）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureLedger, reserveAttempts } from "../src/budget.ts";

/** 槽位总数从**数据文件实际计数**推出（别硬编码：probes_workloop 的条数变过一次） */
function slotTotal(samples = 2, benign = 2): number {
  const f = join(TS_ROOT, "..", "data", "probes_workloop.jsonl");
  const n = readFileSync(f, "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length;
  return samples * (benign + n);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const SCRIPT = join(TS_ROOT, "scripts", "workloop-eval.ts");
const ABORT_STUB = join(HERE, "fixtures", "bridge-abort-stub.mjs");           // 第 1 次成功，之后拒绝
const ALWAYS_STUB = join(HERE, "fixtures", "bridge-always-exhausted-stub.mjs"); // 每次都拒绝

interface WorkloopCase {
  id: string;
  rounds: Array<{ round: number; status: string; usage: { promptTokens: number; completionTokens: number } | null; totalTokens: number | null; multiplier: number | null }>;
  unexecutedRounds: number;
  meanTokens: number | null;
  meanMultiplier: number | null;
  maxMultiplier: number | null;
  flagged: boolean | null;
}

interface WorkloopReport {
  partial?: boolean;
  complete?: boolean;
  partialReasons?: string[];
  cases?: WorkloopCase[];
  budget?: {
    aborted: boolean; abortReason: string; budgetStop: string;
    executed: number; unexecuted: number; totalSlots: number;
    usage: { bridgeCalls: number; httpAttempts: number; cacheHits: number };
    ledger: { used: number } | null;
  };
  aborted?: boolean; abortReason?: string; budgetStop?: string;
  executed?: number; unexecuted?: number; usage?: { httpAttempts: number };
}

/** 共享缓存目录的快照（只读：文件名 + 内容哈希），用于断言测试不往它里面写东西 */
function snapshotSharedCache(): string[] {
  const dir = join(TS_ROOT, "runs", "llm-cache", "agent");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((n) => `${n}:${createHash("sha256").update(readFileSync(join(dir, n))).digest("hex")}`);
}

function runWorkloop(dir: string, counter: string, stub: string, extra: string[] = []): { code: number; out: string } {
  const r = spawnSync(process.execPath, [
    SCRIPT, "--samples", "2", "--benign-limit", "2", "--out", join(dir, "out"),
    "--budget", join(dir, "budget.json"), "--budget-limit", "1", ...extra,
  ], {
    cwd: TS_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AICGUARD_BRIDGE: stub,
      AICGUARD_BASE_URL: "http://127.0.0.1:9/v1",   // 绝不会被真正访问（桥是替身）
      AICGUARD_API_KEY: "sk-test-not-real",
      AICGUARD_MODEL: `m-wl-${process.pid}`,
      COUNTER: counter,
    },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const calls = (p: string): number => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length : 0);

test("WL-① 中途预算中止：停止后续全部槽位、落部分状态、退出码 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-abort-"));
  const counter = join(dir, "calls.log");
  const { code, out } = runWorkloop(dir, counter, ABORT_STUB);
  assert.equal(code, 2, `中止必须返回 2（未跑完不得伪装成成功）。输出：${out.slice(0, 600)}`);
  assert.equal(calls(counter), 2, "第 1 次成功、第 2 次被拒 ⇒ 之后不得再调靶子（21 个剩余槽位零调用）");

  const rep = JSON.parse(readFileSync(join(dir, "out", "report.json"), "utf8")) as WorkloopReport;
  assert.ok(rep.budget, "报告必须带 budget 块");
  const b = rep.budget!;
  assert.equal(b.aborted, true, "必须识别预算中止（原实现只当普通 targetError）");
  assert.equal(b.budgetStop, "exhausted", "中止类别要带出来（exhausted/corrupt/locked/limit）");
  assert.match(b.abortReason, /预算中止/);
  assert.equal(b.executed, 2, "已执行 2 个槽位（第 2 个就是撞墙的那次）");
  assert.equal(b.unexecuted, slotTotal() - 2, "其余槽位全部计未执行（不得低估）");
  assert.equal(b.executed + b.unexecuted, b.totalSlots, "两个口径之和必须等于总槽位");
  assert.equal(b.usage.httpAttempts, 1, "底层 HTTP 尝试只有第 1 次成功那次（第 2 次是发送前拒绝 attempts=0）");
  // 替身桥**不记账**（它不 import budget）⇒ 账本快照必须如实为 null；
  // 真实桥的记账与"used === httpAttempts"对账由 rag-transport-evidence.test.ts 覆盖。
  assert.equal(b.ledger, null, "替身桥不写账本 ⇒ 不得假装有账本快照");

  // ★ Codex 复核 R2：中止批次**不得发布整体负结论**。必须看**实际产物内容**（不只是执行数/退出码）。
  assert.equal(rep.partial, true, "中止必须显式标 partial（修前 JSON 里根本没有这个字段）");
  assert.equal(rep.complete, false, "未跑完 ⇒ complete=false");
  assert.ok((rep.partialReasons ?? []).some((x) => /预算中止/.test(x)), "partialReasons 要写出中止原因");
  const wlCases = rep.cases ?? [];
  assert.ok(wlCases.length > 0, "报告必须带 cases（逐条与逐轮结果）");
  assert.ok(wlCases.every((c) => c.flagged === null && c.meanMultiplier === null && c.meanTokens === null),
    "没有有效轮次的用例：token/倍率/达阈必须**不可计算**（null），不得写成 0× 或 false——那会被读成「未达阈」");
  assert.ok(wlCases.every((c) => c.rounds.every((r) => r.status !== "ok")), "本场景里攻击用例一次也没执行成功");
  const md = readFileSync(join(dir, "out", "report.md"), "utf8");
  assert.match(md, /部分结果：未跑完/, "Markdown 标题必须显式标部分结果");
  assert.match(md, /不得给出任何整体结论/);
  assert.match(md, /不可计算/);
  assert.ok(!/未达\s*5×\s*阈值/.test(md), "中止批次不得写「N 条未达阈值」（那是把没跑的算成负结果）");
  assert.ok(!/顺从度有限/.test(md), "中止批次不得对模型行为下整体负结论");
});

test("WL-③ 缓存写入**本次产物目录**，共享 runs/llm-cache/agent 前后无增改（Codex 复核 R5）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-cache-"));
  const counter = join(dir, "calls.log");
  // 修前：workloop-eval 构造 AgentBot **不传 cacheDir** ⇒ 落到默认共享目录 runs/llm-cache/agent；
  // 模型名里的 m-wl-<pid> 只隔离**缓存键**，不隔离目录 ⇒ 每跑一次就往生产缓存目录写文件。
  const before = snapshotSharedCache();
  const { code } = runWorkloop(dir, counter, ABORT_STUB);
  assert.equal(code, 2);
  const after = snapshotSharedCache();
  assert.deepEqual(after, before, "共享 runs/llm-cache/agent 必须前后逐文件逐字节不变（--out 指到临时目录即隔离）");
  // 阴性对照的反面：缓存**确实写了**，只是写在本次产物目录下（证明这条断言不是「哪儿都没写」的恒真式）
  const own = join(dir, "out", "llm-cache", "agent");
  assert.ok(existsSync(own), `缓存应写到 <out>/llm-cache/agent（实际不存在：${own}）`);
  assert.ok(readdirSync(own).length >= 1, "本次运行的缓存文件应在产物目录下（不是共享目录）");
});

test("WL-② 一上来就耗尽（基线为空）⇒ **仍须先落部分报告**，再退出 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-partial-"));
  const counter = join(dir, "calls.log");
  // 先把额度用光：这样第一次调用就撞墙（原实现会在"基线无有效样本"处直接 return 2，
  // **一个字节都不写** —— 这次必须留下部分报告）
  ensureLedger(join(dir, "budget.json"), { runId: "wl", limit: 1 });
  reserveAttempts(join(dir, "budget.json"), 1, "test");
  const { code, out } = runWorkloop(dir, counter, ALWAYS_STUB);
  assert.equal(code, 2, `基线不成立 ⇒ 退出 2。输出：${out.slice(0, 600)}`);
  // 只应尝试第一个槽位：桥被调 1 次（它**拒绝发送** ⇒ 见下面的 httpAttempts=0），其余槽位全部跳过。
  // 注意区分两个口径：桥调用次数 ≠ 底层 HTTP 尝试次数（后者才是额度口径）。
  assert.equal(calls(counter), 1, "只有第一个槽位被尝试（之后一律不再调靶子）");
  assert.ok(existsSync(join(dir, "out", "report.json")), "★必须先保存部分报告（不得因 return 2 丢结果）");
  const rep = JSON.parse(readFileSync(join(dir, "out", "report.json"), "utf8")) as WorkloopReport;
  assert.equal(rep.partial, true, "必须显式标注这是部分结果");
  assert.equal(rep.aborted, true);
  assert.equal(rep.budgetStop, "exhausted");
  assert.equal(rep.executed, 1, "只有第一个槽位被尝试（靶子被调用并返回预算拒绝）");
  assert.equal(rep.unexecuted, slotTotal() - 1, "其余槽位全部计未执行");
  assert.equal(rep.usage?.httpAttempts, 0, "没有真实 HTTP（全部发送前拒绝）");
  assert.ok(existsSync(join(dir, "out", "report.md")), "部分报告也要有人读的 md");
});
