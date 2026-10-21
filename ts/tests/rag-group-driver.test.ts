/**
 * RAG 组驱动（`scripts/rag-group-driver.ts`）契约回归（重写版，2026-10-17）。
 *
 * 覆盖（全部离线替身 runner + 临时账本，零外部请求）：
 *  A 身份绑定与 CLI 冲突     B 攻击护栏冲突/阻断事实   C 攻击 unexecuted 事实
 *  D 报告形状与条数（按 kind） E 良性零发送显式布尔     F 良性 blocked 来源
 *  G 良性 budgetRefused 真实形态  H continue-on 具体原因码   I 输出不可覆盖/坏 JSON/账目
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const DRIVER = resolve(TS_ROOT, "scripts", "rag-group-driver.ts");

interface Ctx { dir: string; plan: string; ledger: string; runner: string }

/** 替身 runner：把 STUB_BODY（JSON 字符串，环境变量传入）写进 rag-report.json */
const STUB = `
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const i = argv.indexOf("--out"); const out = argv[i + 1];
mkdirSync(out, { recursive: true });
appendFileSync(join(out, "..", "..", "ran.log"), (argv[argv.indexOf("--label") + 1] ?? "") + "\\n");
const body = process.env.STUB_BODY ?? "{}";
if (body === "BAD_JSON") { writeFileSync(join(out, "rag-report.json"), "{ bad"); process.exit(0); }
writeFileSync(join(out, "rag-report.json"), JSON.stringify({
  targetRuntime: { model: "m-stub", endpoint: "ep-stub", cacheMode: "fresh" },
  batch: { usage: { httpAttempts: 0, cacheHits: 0 } },
  ...JSON.parse(body),
}));
process.exit(0);
`;

/** 造一个隔离现场：plan（每项带输入文件）、临时账本、替身 runner */
function ctx(planItems: Array<Record<string, unknown>>, opts: { identity?: Record<string, unknown>; ledger?: unknown } = {}): Ctx {
  const dir = mkdtempSync(join(tmpdir(), "ragdrv-"));
  const items = planItems.map((it, k) => {
    const f = join(dir, `in-${k + 1}.jsonl`);
    writeFileSync(f, JSON.stringify({ id: `in-${k + 1}` }) + "\n", "utf8");
    return { profile: "none", ...it, file: (it.file as string | undefined) ?? f };
  });
  const plan = join(dir, "plan.json");
  writeFileSync(plan, JSON.stringify({
    identity: opts.identity ?? { model: "m-stub", endpoint: "ep-stub", mode: "fresh" },
    items,
  }), "utf8");
  const ledger = join(dir, "ledger.json");
  writeFileSync(ledger, JSON.stringify(opts.ledger ?? { used: 0, limit: 200 }), "utf8");
  const runner = join(dir, "stub.mjs");
  writeFileSync(runner, STUB, "utf8");
  return { dir, plan, ledger, runner };
}

function drive(c: Ctx, body: unknown, extra: string[] = [], outName = "out"): { status: number | null; out: string; stderr: string } {
  const out = join(c.dir, outName);
  const r = spawnSync(process.execPath, [DRIVER, "--plan", c.plan, "--out", out, "--runner", c.runner,
    "--budget", c.ledger, "--baseline-used", "0", "--ceiling", "32", "--cap", "200", ...extra],
    { cwd: TS_ROOT, encoding: "utf8", env: { ...process.env, STUB_BODY: typeof body === "string" ? body : JSON.stringify(body) } });
  return { status: r.status, out, stderr: r.stderr ?? "" };
}
const stopOf = (out: string): { reason: string } | null =>
  existsSync(join(out, "stopped.json")) ? JSON.parse(readFileSync(join(out, "stopped.json"), "utf8")) as { reason: string } : null;
const ran = (out: string): string[] =>
  existsSync(join(out, "ran.log")) ? readFileSync(join(out, "ran.log"), "utf8").split("\n").filter(Boolean) : [];

/** 合法攻击行/良性行工厂 */
const atk = (over: Record<string, unknown> = {}) => ({ id: "T-1", status: "ok", error: "", transport: { state: "submitted", attemptId: "a", requestSha256: "d".repeat(64) }, ...over });
const bng = (over: Record<string, unknown> = {}) => ({
  id: "B-1", outcome: "ok", cause: "", error: "", executed: true,
  guard: { blocked: false, blockedBy: "", stage: "", targetCalled: true },
  transport: { evidence: { state: "submitted", attemptId: "a", requestSha256: "d".repeat(64) }, requestSent: true, httpAttempted: true, evidenceSource: "transport" },
  budget: { stopped: false, reason: "" }, ...over,
});
const attackBody = (rows: unknown[]) => ({ cases: rows });
const benignBody = (rows: unknown[]) => ({ cases: [], benign: { perCase: rows } });

// ---------------------------------------------------------------- A 身份
test("A 身份：计划与 CLI 冲突（model/endpoint/mode）⇒ exit2 且不建输出目录", () => {
  for (const [flag, v] of [["--model", "x"], ["--endpoint", "y"], ["--mode", "replay"]] as const) {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try {
      const out = join(c.dir, "conf");
      const r = spawnSync(process.execPath, [DRIVER, "--plan", c.plan, "--out", out, "--runner", c.runner, "--budget", c.ledger, flag, v],
        { cwd: TS_ROOT, encoding: "utf8" });
      assert.equal(r.status, 2, `${flag} 冲突应 exit2`);
      assert.match(r.stderr, /身份冲突/);
      assert.equal(existsSync(out), false, "不得建立输出目录");
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

// ---------------------------------------------------------------- B/C 攻击护栏与未执行
test("B 攻击：inputBlocked 带任何 transport ⇒ 停；无 transport 且事实完整 ⇒ 放行；缺 blockedBy ⇒ 停", () => {
  const cases: Array<[Record<string, unknown>, RegExp | null]> = [
    [attackBody([atk({ inputBlocked: true, blockedStage: "query_input", blockedBy: "G1" })]), /护栏阻断却存在transport/],
    [attackBody([atk({ inputBlocked: true, blockedStage: "query_input", blockedBy: "G1", transport: { state: "unknown-after-submit", attemptId: "a", requestSha256: "d".repeat(64) } })]), /护栏阻断却存在transport/],
    [attackBody([atk({ status: "invalid_test", inputBlocked: true, blockedStage: "query_input", blockedBy: "G1", transport: null })]), null],
    [attackBody([atk({ inputBlocked: true, blockedStage: "query_input", blockedBy: "", transport: null })]), /护栏阻断缺事实/],
  ];
  for (const [body, pat] of cases) {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, body);
      if (pat === null) assert.equal(stopOf(r.out), null, "合法阻断应放行");
      else assert.match(stopOf(r.out)!.reason, pat);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

test("C 攻击 unexecuted：无 transport 或合成 state=unexecuted 放行；带 submitted/未知状态或占位中止原因 ⇒ 停", () => {
  const cases: Array<[Record<string, unknown>, RegExp | null]> = [
    [attackBody([atk({ status: "budget_exhausted", unexecuted: true, budgetStopReason: "exhausted", transport: null })]), null],
    [attackBody([atk({ status: "budget_exhausted", unexecuted: true, budgetStopReason: "exhausted", transport: { state: "unexecuted", attemptId: "", requestSha256: "" } })]), null],
    [attackBody([atk({ status: "budget_exhausted", unexecuted: true, budgetStopReason: "exhausted" })]), /unexecuted-与发送状态矛盾|ok-与transport不一致/],
    [attackBody([atk({ status: "budget_exhausted", unexecuted: true, budgetStopReason: "exhausted", transport: { state: "weird", attemptId: "", requestSha256: "" } })]), /transport-状态未知|unexecuted-与发送状态矛盾/],
    [attackBody([atk({ status: "budget_exhausted", unexecuted: true, budgetStopReason: "placeholder", transport: null })]), /unexecuted-中止事实不成立/],
  ];
  for (const [body, pat] of cases) {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, body);
      if (pat === null) assert.equal(stopOf(r.out), null, "合法 unexecuted 应放行");
      else assert.match(stopOf(r.out)!.reason, pat);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

test("D 报告形状与条数：缺数组/类型错/空数组/条数不符 ⇒ 停；正常数量（攻击 1 条 / 良性 1 条）⇒ 完成；未知 kind ⇒ exit2", () => {
  // 攻击项缺 cases（body 只有 benign）
  {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, { benign: { perCase: [bng()] } });   // 完全不带 cases 键
      assert.match(stopOf(r.out)!.reason, /攻击项缺合法 cases 数组/);
      assert.equal(existsSync(join(r.out, "completed.json")), false, "停时不写 completed");
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
  // 良性项缺 benign.perCase（body 只有 cases）
  {
    const c = ctx([{ label: "b1", kind: "benign" }]);
    try { const r = drive(c, { cases: [atk()] });                 // 完全不带 benign 键
      assert.match(stopOf(r.out)!.reason, /良性项缺合法 benign\.perCase 数组/);
      assert.equal(existsSync(join(r.out, "completed.json")), false, "停时不写 completed");
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
  // 空数组（计划输入 1 条）
  {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, attackBody([])); assert.match(stopOf(r.out)!.reason, /逐条记录数不符/); }
    finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
  // 条数多 1（计划输入 1 条、报告 2 条）
  {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, attackBody([atk(), atk({ id: "T-2" })])); assert.match(stopOf(r.out)!.reason, /逐条记录数不符/); }
    finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
  // 阳性：攻击项 1 条 / 良性项 1 条
  {
    const a = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(a, attackBody([atk()])); assert.equal(stopOf(r.out), null); assert.ok(existsSync(join(r.out, "completed.json"))); }
    finally { rmSync(a.dir, { recursive: true, force: true }); }
    const b = ctx([{ label: "b1", kind: "benign" }]);
    try { const r = drive(b, benignBody([bng()])); assert.equal(stopOf(r.out), null); assert.ok(existsSync(join(r.out, "completed.json"))); }
    finally { rmSync(b.dir, { recursive: true, force: true }); }
  }
  // 未知 kind：启动前 exit2 且 runner 未运行
  {
    const c = ctx([{ label: "i1", kind: "weird" }]);
    try { const r = drive(c, attackBody([atk()])); assert.equal(r.status, 2); assert.match(r.stderr, /kind 非法/); assert.deepEqual(ran(r.out), []); }
    finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

// ---------------------------------------------------------------- E/F/G 良性三态
test("E 良性零发送标志必须显式布尔 false（blocked/unexecuted/budgetRefused 各含阴性 + 阳性）", () => {
  const blocked = (t: Record<string, unknown>) => bng({ outcome: "blocked", guard: { blocked: true, blockedBy: "G1", stage: "query_input", targetCalled: false }, transport: { evidence: null, evidenceSource: "guard_blocked", ...t } });
  const unexec = (t: Record<string, unknown>) => bng({ outcome: "unexecuted", cause: "batch_aborted", executed: false, guard: { blocked: false, blockedBy: "", stage: "", targetCalled: false }, transport: { evidence: null, evidenceSource: "unknown", ...t } });
  const refused = (t: Record<string, unknown>) => bng({ outcome: "budgetRefused", executed: true, transport: { evidence: { state: "refused", attemptId: "", requestSha256: "" }, evidenceSource: "transport", ...t }, budget: { stopped: true, reason: "exhausted" } });
  const cases: Array<[Record<string, unknown>, RegExp | null]> = [
    [benignBody([blocked({ httpAttempted: false })]), /零发送标志不是显式false/],
    [benignBody([blocked({ requestSent: "false", httpAttempted: false })]), /零发送标志不是显式false/],
    [benignBody([blocked({ requestSent: true, httpAttempted: false })]), /零发送标志不是显式false/],
    [benignBody([blocked({ requestSent: false, httpAttempted: false })]), null],
    [benignBody([unexec({ requestSent: false, httpAttempted: true })]), /零发送标志不是显式false/],
    [benignBody([unexec({ requestSent: false, httpAttempted: false })]), null],
    [benignBody([refused({ requestSent: false })]), /零发送标志不是显式false/],
    [benignBody([refused({ requestSent: false, httpAttempted: false })]), null],
  ];
  for (const [body, pat] of cases) {
    const c = ctx([{ label: "b1", kind: "benign" }]);
    try { const r = drive(c, body);
      if (pat === null) assert.equal(stopOf(r.out), null, "显式 false 应放行");
      else assert.match(stopOf(r.out)!.reason, pat);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

test("F 良性 blocked 来源必须是 guard_blocked；G budgetRefused 需 transport 来源的 refused 原件", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp | null]> = [
    ["blocked", benignBody([bng({ outcome: "blocked", guard: { blocked: true, blockedBy: "G1", stage: "query_input", targetCalled: false }, transport: { evidence: null, requestSent: false, httpAttempted: false, evidenceSource: "guard_blocked" } })]), null],
    ["blocked", benignBody([bng({ outcome: "blocked", guard: { blocked: true, blockedBy: "G1", stage: "query_input", targetCalled: false }, transport: { evidence: null, requestSent: false, httpAttempted: false, evidenceSource: "unknown" } })]), /blocked-来源非法/],
    ["refused", benignBody([bng({ outcome: "budgetRefused", executed: true, transport: { evidence: { state: "refused", attemptId: "", requestSha256: "" }, requestSent: false, httpAttempted: false, evidenceSource: "transport" }, budget: { stopped: true, reason: "exhausted" } })]), null],
    ["refused", benignBody([bng({ outcome: "budgetRefused", executed: true, transport: { evidence: { state: "refused", attemptId: "", requestSha256: "" }, requestSent: false, httpAttempted: false, evidenceSource: "unknown" }, budget: { stopped: true, reason: "exhausted" } })]), /来源非法/],
    ["refused", benignBody([bng({ outcome: "budgetRefused", executed: true, transport: { evidence: null, requestSent: false, httpAttempted: false, evidenceSource: "transport" }, budget: { stopped: true, reason: "exhausted" } })]), /缺refused原件/],
  ];
  for (const [, body, pat] of cases) {
    const c = ctx([{ label: "b1", kind: "benign" }]);
    try { const r = drive(c, body);
      if (pat === null) assert.equal(stopOf(r.out), null);
      else assert.match(stopOf(r.out)!.reason, pat);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

// ---------------------------------------------------------------- H continue-on
test("H continue-on：仅具体原因码可继续；泛状态/自由文本 exit2；缺结构化原因 ⇒ 停", () => {
  const errRow = atk({ status: "call_error", error: "bridge 退出码 1", transport: { state: "not-connecting", attemptId: "a", requestSha256: "d".repeat(64) } });
  // 命中具体码 ⇒ 放行
  {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, attackBody([errRow]), ["--continue-on", "attack:call_error:not-connecting"]);
      assert.equal(stopOf(r.out), null, "具体原因命中应继续"); }
    finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
  // 不同原因（同 call_error）⇒ 停
  {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, attackBody([errRow]), ["--continue-on", "attack:call_error:submitted"]);
      assert.match(stopOf(r.out)!.reason, /not-in-continue-list.*attack:call_error:not-connecting/); }
    finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
  // 缺结构化原因（无 transport）⇒ reason-unavailable
  {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, attackBody([atk({ status: "call_error", error: "x", transport: null })]), ["--continue-on", "attack:call_error:not-connecting"]);
      assert.match(stopOf(r.out)!.reason, /missing-origin|reason-unavailable/); }
    finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
  // 泛状态 / 自由文本 ⇒ 启动即 exit2
  for (const bad of ["attack:call_error", "benign:targetError", "provider quota"]) {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, attackBody([errRow]), ["--continue-on", bad]);
      assert.equal(r.status, 2, `${bad} 应 exit2`);
      assert.match(r.stderr, /必须绑定具体原因码/); }
    finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

// ---------------------------------------------------------------- I 输出/账目
test("I 输出不可覆盖（report-only）⇒ 发送前 exit2 且原件逐字节保留；坏 JSON ⇒ 停并留 record", () => {
  {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try {
      const r1 = drive(c, attackBody([atk()]));
      assert.equal(r1.status, 0, r1.stderr);
      const rep = join(r1.out, "out", "i1", "rag-report.original.json");
      assert.ok(existsSync(rep), "应有原件副本");
      rmSync(join(r1.out, "out", "i1", "stdout.txt"), { force: true });
      rmSync(join(r1.out, "out", "i1", "stderr.txt"), { force: true });
      const before = readFileSync(rep);
      const r2 = drive(c, attackBody([atk()]));
      assert.equal(r2.status, 2, "既有原件必须拒绝覆盖");
      assert.deepEqual(readFileSync(rep), before, "原件逐字节保留");
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
  {
    const c = ctx([{ label: "i1", kind: "attack" }, { label: "i2", kind: "attack" }]);
    try {
      const r = drive(c, "BAD_JSON");
      assert.match(stopOf(r.out)!.reason, /解析失败/);
      const recs = readFileSync(join(r.out, "driver-items.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(recs.length, 1, "坏 JSON 也要形成该项 record");
      assert.ok(recs[0]!.ledger, "record 必须含账本前后");
      assert.deepEqual(ran(r.out), ["i1"], "后续 sentinel 项不得执行");
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

test("J 逐条元素畸形（null/字符串/数组）⇒ 停并留证；后续项不启动、不写 completed；合法对象阳性", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["attack", { cases: [null] }, /逐条元素畸形：cases\[1\]/],
    ["attack", { cases: ["str"] }, /逐条元素畸形：cases\[1\]/],
    ["attack", { cases: [[]] }, /逐条元素畸形：cases\[1\]/],
    ["benign", { cases: [], benign: { perCase: [null] } }, /逐条元素畸形：benign\.perCase\[1\]/],
    ["benign", { cases: [], benign: { perCase: [[]] } }, /逐条元素畸形：benign\.perCase\[1\]/],
  ];
  for (const [kind, body, pat] of cases) {
    const c = ctx([{ label: "i1", kind }, { label: "i2", kind }]);
    try {
      const r = drive(c, body);
      assert.equal(r.status, 0, `畸形元素必须优雅停止（不得 TypeError 退出 1）：${r.stderr}`);
      assert.match(stopOf(r.out)!.reason, pat);
      assert.equal(existsSync(join(r.out, "completed.json")), false, "停时不得写 completed.json");
      assert.deepEqual(ran(r.out), ["i1"], "后续 sentinel 项不得启动");
      const recs = readFileSync(join(r.out, "driver-items.jsonl"), "utf8").split("\n").filter(Boolean);
      assert.equal(recs.length, 1, "畸形的当前项必须留下结构化 record");
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
  // 阳性对照：合法对象行照常完成
  for (const [kind, body] of [["attack", attackBody([atk()])], ["benign", benignBody([bng()])]] as Array<[string, Record<string, unknown>]>) {
    const c = ctx([{ label: "i1", kind }]);
    try {
      const r = drive(c, body);
      assert.equal(stopOf(r.out), null, "合法对象应放行");
      assert.ok(existsSync(join(r.out, "completed.json")));
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

test("K 交叉数组畸形：攻击计划带畸形 benign.perCase / 良性计划带畸形 cases ⇒ 停（不得抛 TypeError）；合法双数组阳性", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["attack", { cases: [atk()], benign: { perCase: [null] } }, /逐条元素畸形：benign\.perCase\[1\]/],
    ["attack", { cases: [atk()], benign: { perCase: [[]] } }, /逐条元素畸形：benign\.perCase\[1\]/],
    ["benign", { cases: [null], benign: { perCase: [bng()] } }, /逐条元素畸形：cases\[1\]/],
    ["benign", { cases: ["str"], benign: { perCase: [bng()] } }, /逐条元素畸形：cases\[1\]/],
  ];
  for (const [kind, body, pat] of cases) {
    const c = ctx([{ label: "i1", kind }, { label: "i2", kind }]);
    try {
      const r = drive(c, body);
      assert.equal(r.status, 0, `必须优雅停止而非 TypeError：${r.stderr}`);
      assert.match(stopOf(r.out)!.reason, pat);
      assert.equal(existsSync(join(r.out, "completed.json")), false, "停时不得写 completed.json");
      assert.deepEqual(ran(r.out), ["i1"], "后续 sentinel 项不得启动");
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
  // 阳性：攻击/良性计划各自带合法双数组
  for (const [kind, body] of [
    ["attack", { cases: [atk()], benign: { perCase: [bng()] } }],
    ["benign", { cases: [atk()], benign: { perCase: [bng()] } }],
  ] as Array<[string, Record<string, unknown>]>) {
    const c = ctx([{ label: "i1", kind }]);
    try {
      const r = drive(c, body);
      assert.equal(stopOf(r.out), null, "合法双数组应放行");
      assert.ok(existsSync(join(r.out, "completed.json")));
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

// ============================================================ 第十三层：四项 P1 反例（红→绿）
test("L 攻击 status/transport 一致性 fail-closed（P1-1）", () => {
  const cases: Array<[Record<string, unknown>, RegExp | null]> = [
    [attackBody([atk({ transport: { state: "bogus", attemptId: "a", requestSha256: "d".repeat(64) } })]), /transport-状态未知/],
    [attackBody([atk({ transport: { state: "not-connecting", attemptId: "a", requestSha256: "d".repeat(64) } })]), /ok-与transport不一致/],
    [attackBody([atk({ transport: { state: "dry-run", attemptId: "", requestSha256: "" } })]), /ok-与transport不一致/],
    [attackBody([atk({ transport: { state: "unknown-after-submit", attemptId: "a", requestSha256: "d".repeat(64) } })]), /ok-与transport不一致/],
    [attackBody([atk({ status: "budget_exhausted", transport: null })]), /budget_exhausted-缺未执行或拒绝事实/],
    [attackBody([atk({ status: "invalid_test", transport: null })]), /invalid_test-缺阻断事实/],
    // 阳性：budget_exhausted + refused + 预算事实
    [attackBody([atk({ status: "budget_exhausted", transport: { state: "refused", attemptId: "", requestSha256: "" }, budget: { stopped: true, reason: "exhausted" } })]), null],
    // 阳性：ok + submitted
    [attackBody([atk()]), null],
  ];
  for (const [body, pat] of cases) {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, body);
      if (pat === null) assert.equal(stopOf(r.out), null, "阳性应放行");
      else assert.match(stopOf(r.out)!.reason, pat);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

test("M 良性 ok/targetError 跨字段一致性 fail-closed（P1-2）", () => {
  const okRow = (over: Record<string, unknown>) => bng(over);
  const cases: Array<[Record<string, unknown>, RegExp | null]> = [
    [benignBody([okRow({ executed: false })]), /ok-但executed非true/],
    [benignBody([okRow({ transport: { evidence: null, requestSent: true, httpAttempted: true, evidenceSource: "transport" } })]), /成功声称缺transport/],
    [benignBody([okRow({ transport: { evidence: { state: "not-connecting", attemptId: "a", requestSha256: "d".repeat(64) }, requestSent: true, httpAttempted: true, evidenceSource: "transport" } })]), /ok-与evidence不一致/],
    [benignBody([okRow({ transport: { evidence: { state: "submitted", attemptId: "a", requestSha256: "d".repeat(64) }, requestSent: true, httpAttempted: true, evidenceSource: "unknown" } })]), /ok-来源非法/],
    [benignBody([okRow({ transport: { evidence: { state: "submitted", attemptId: "a", requestSha256: "d".repeat(64) }, requestSent: false, httpAttempted: true, evidenceSource: "transport" } })]), /ok-发送标志不是显式true/],
    [benignBody([okRow({})]), null],
    // targetError
    [benignBody([bng({ outcome: "targetError", error: "bridge 退出码 1", executed: false, transport: { evidence: { state: "submitted", attemptId: "a", requestSha256: "d".repeat(64) }, requestSent: true, httpAttempted: true, evidenceSource: "transport" } })]), /targetError-但executed非true/],
    [benignBody([bng({ outcome: "targetError", error: "x", transport: { evidence: { state: "submitted", attemptId: "a", requestSha256: "d".repeat(64) }, requestSent: true, httpAttempted: true, evidenceSource: "unknown" } })]), /targetError-来源非法/],
    [benignBody([bng({ outcome: "targetError", error: "x", transport: { evidence: { state: "submitted", attemptId: "a", requestSha256: "d".repeat(64) }, requestSent: "true", httpAttempted: true, evidenceSource: "transport" } })]), /targetError-发送标志非显式布尔/],
    [benignBody([bng({ outcome: "targetError", error: "x", transport: { evidence: { state: "submitted", attemptId: "a", requestSha256: "d".repeat(64) }, requestSent: true, httpAttempted: true, evidenceSource: "transport" } })]), /not-in-continue-list|unexpected/],
  ];
  for (const [body, pat] of cases) {
    const c = ctx([{ label: "b1", kind: "benign" }]);
    try { const r = drive(c, body);
      if (pat === null) assert.equal(stopOf(r.out), null, "全一致应放行");
      else assert.match(stopOf(r.out)!.reason, pat);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

test("N --out 受保护目录（holdout/data/materials）⇒ 启动前 exit2，目录不创建、runner 不运行（P1-4）", () => {
  const repoRoot = resolve(TS_ROOT, "..");
  for (const prot of ["holdout", "data", "materials"]) {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try {
      const out = join(repoRoot, prot, "drv-should-not-exist");
      const r = spawnSync(process.execPath, [DRIVER, "--plan", c.plan, "--out", out, "--runner", c.runner,
        "--budget", c.ledger, "--baseline-used", "0", "--ceiling", "32", "--cap", "200"], { cwd: TS_ROOT, encoding: "utf8" });
      assert.equal(r.status, 2, `${prot}/ 必须 exit2`);
      assert.match(r.stderr, /受保护目录/);
      assert.equal(existsSync(out), false, "不得创建受保护目录下的输出");
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

// ============================================================ 第十五层：三项返工（O/P/Q）
test("O --out 保护与 cwd 无关：cwd=ts 与 cwd=仓库根 × holdout/data/materials 均拒绝；非保护目录放行", () => {
  const repoRoot = resolve(TS_ROOT, "..");
  for (const cwd of [TS_ROOT, repoRoot]) {
    for (const prot of ["holdout", "data", "materials"]) {
      const c = ctx([{ label: "i1", kind: "attack" }]);
      try {
        const out = join(repoRoot, prot, `drv-prot-${process.pid}-${prot}`);
        const r = spawnSync(process.execPath, [DRIVER, "--plan", c.plan, "--out", out, "--runner", c.runner,
          "--budget", c.ledger, "--baseline-used", "0", "--ceiling", "32", "--cap", "200"],
          { cwd, encoding: "utf8", env: { ...process.env, STUB_BODY: JSON.stringify(attackBody([atk()])) } });
        assert.equal(r.status, 2, `cwd=${cwd} ${prot}/ 必须 exit2`);
        assert.match(r.stderr, /受保护目录/);
        assert.equal(existsSync(out), false, "不得在受保护目录下创建输出");
      } finally { rmSync(c.dir, { recursive: true, force: true }); }
    }
  }
  // 阳性：非保护目录
  {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, attackBody([atk()])); assert.equal(stopOf(r.out), null, "普通目录应放行"); assert.ok(existsSync(join(r.out, "completed.json"))); }
    finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

test("P 攻击 call_error 状态/原错误先闭合：缺错误+refused 停；state=unexecuted 不可被 continue-on 绕过", () => {
  const cases: Array<[Record<string, unknown>, string[], RegExp | null]> = [
    [attackBody([atk({ status: "call_error", error: "", transport: { state: "refused", attemptId: "", requestSha256: "" }, budget: { stopped: true, reason: "exhausted" } })]), [], /missing-origin/],
    [attackBody([atk({ status: "call_error", error: "bridge 退出码 1", transport: { state: "unexecuted", attemptId: "", requestSha256: "" } })]), ["--continue-on", "attack:call_error:unexecuted"], /call_error-与unexecuted状态矛盾/],
    // 阳性：真实失败状态 + 有原错误 + 具体原因码命中
    [attackBody([atk({ status: "call_error", error: "bridge 退出码 1", transport: { state: "not-connecting", attemptId: "a", requestSha256: "d".repeat(64) } })]), ["--continue-on", "attack:call_error:not-connecting"], null],
  ];
  for (const [body, extra, pat] of cases) {
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, body, extra);
      if (pat === null) assert.equal(stopOf(r.out), null, "合法 call_error 应放行");
      else assert.match(stopOf(r.out)!.reason, pat);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

test("Q 良性 targetError 状态↔发送标志一致性：submitted 需 true/true，not-connecting 需 false/true；错配即停", () => {
  const t = (state: string, rs: unknown, ha: unknown) => ({ evidence: { state, attemptId: "a", requestSha256: "d".repeat(64) }, requestSent: rs, httpAttempted: ha, evidenceSource: "transport" });
  const row = (state: string, rs: unknown, ha: unknown) => benignBody([bng({ outcome: "targetError", error: "bridge 退出码 1", transport: t(state, rs, ha) })]);
  const cases: Array<[Record<string, unknown>, string[], RegExp | null]> = [
    [row("submitted", false, false), ["--continue-on", "benign:targetError:submitted"], /发送标志与状态不一致/],
    [row("not-connecting", true, true), ["--continue-on", "benign:targetError:not-connecting"], /发送标志与状态不一致/],
    [row("submitted", true, true), ["--continue-on", "benign:targetError:submitted"], null],
    [row("not-connecting", false, true), ["--continue-on", "benign:targetError:not-connecting"], null],
  ];
  for (const [body, extra, pat] of cases) {
    const c = ctx([{ label: "b1", kind: "benign" }]);
    try { const r = drive(c, body, extra);
      if (pat === null) assert.equal(stopOf(r.out), null, "合法 targetError 应放行");
      else assert.match(stopOf(r.out)!.reason, pat);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

test("R natural 条件护栏阻断行（真实 producer: status=ok、无 transport）必须放行；forced=invalid_test 放行；带 transport 或已发送标记即停", () => {
  const guard = (extra: Record<string, unknown>) => attackBody([atk({ status: "ok", inputBlocked: true, blockedStage: "chunk_input", blockedBy: "G1-InputRuleGuard", transport: null, ...extra })]);
  // 正文行（nature 阻断）：放行
  { const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, guard({})); assert.equal(stopOf(r.out), null, "natural 阻断 + status=ok 应放行"); assert.ok(existsSync(join(r.out, "completed.json"))); }
    finally { rmSync(c.dir, { recursive: true, force: true }); } }
  // forced 形态（status=invalid_test）：放行
  { const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, attackBody([atk({ status: "invalid_test", inputBlocked: true, blockedStage: "chunk_input", blockedBy: "G1-InputRuleGuard", transport: null })]));
      assert.equal(stopOf(r.out), null, "forced 阻断 + status=invalid_test 应放行"); }
    finally { rmSync(c.dir, { recursive: true, force: true }); } }
  // 阴性：阻断却带 transport
  { const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, guard({ transport: { state: "submitted", attemptId: "a", requestSha256: "d".repeat(64) } }));
      assert.match(stopOf(r.out)!.reason, /护栏阻断却存在transport/); }
    finally { rmSync(c.dir, { recursive: true, force: true }); } }
  // 阴性：阻断却标记已发送
  { const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, guard({ requestSent: true }));
      assert.match(stopOf(r.out)!.reason, /护栏阻断却标记已发送/); }
    finally { rmSync(c.dir, { recursive: true, force: true }); } }
  // 阴性：阻断但 status 不在允许集
  { const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, guard({ status: "fail" }));
      assert.match(stopOf(r.out)!.reason, /护栏阻断与status不一致|unknown-attack-status/); }
    finally { rmSync(c.dir, { recursive: true, force: true }); } }
});

test("S --out 保护对 Windows 大小写/尾随点别名同样生效（镜像几何，不写真仓库）", () => {
  const base = mkdtempSync(join(tmpdir(), "drv-alias-"));
  try {
    mkdirSync(join(base, "holdout"), { recursive: true });
    mkdirSync(join(base, "data"), { recursive: true });
    mkdirSync(join(base, "materials"), { recursive: true });
    const aliases = ["HOLDOUT", "Holdout", "DATA", "Materials", "holdout.", "HOLDOUT."];
    for (const a of aliases) {
      const c = ctx([{ label: "i1", kind: "attack" }]);
      const out = join(base, a, `drv-${a.replace(/\W/g, "")}`);
      try {
        const r = spawnSync(process.execPath, [DRIVER, "--plan", c.plan, "--out", out, "--runner", c.runner,
          "--budget", c.ledger, "--baseline-used", "0", "--ceiling", "32", "--cap", "200"],
          { cwd: TS_ROOT, encoding: "utf8", env: { ...process.env, STUB_BODY: JSON.stringify(attackBody([atk()])) } });
        assert.equal(r.status, 2, `别名 ${a}/ 必须 exit2`);
        assert.match(r.stderr, /受保护目录/);
        assert.equal(existsSync(join(base, a, `drv-${a.replace(/\W/g, "")}`)), false, `不得在 ${a}/ 下创建输出`);
      } finally { rmSync(c.dir, { recursive: true, force: true }); }
    }
    // 阳性：非保护目录放行
    const c = ctx([{ label: "i1", kind: "attack" }]);
    try { const r = drive(c, attackBody([atk()])); assert.equal(stopOf(r.out), null); }
    finally { rmSync(c.dir, { recursive: true, force: true }); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("T 目录联接(junction)指向受保护目录 + 悬空子路径，也必须拒绝（--out 保护不可被联接绕过）", (t) => {
  const base = mkdtempSync(join(tmpdir(), "drv-link-"));
  const holdout = join(base, "holdout");
  const link = join(base, "link");
  mkdirSync(holdout, { recursive: true });
  const mk = spawnSync("cmd", ["/c", "mklink", "/J", link, holdout], { encoding: "utf8" });
  if (mk.status !== 0) { t.skip(`本机无法创建 junction：${(mk.stderr || mk.stdout || "").slice(0, 80)}`); return; }
  try {
    // 阴性：经联接 + **尚未创建**的子路径 ⇒ 必须 exit 2（规范路径经 realpath 落到 holdout/）
    const c1 = ctx([{ label: "i1", kind: "attack" }]);
    try {
      const out = join(link, `drv-junction-${process.pid}`);
      const r = spawnSync(process.execPath, [DRIVER, "--plan", c1.plan, "--out", out, "--runner", c1.runner,
        "--budget", c1.ledger, "--baseline-used", "0", "--ceiling", "32", "--cap", "200"],
        { cwd: TS_ROOT, encoding: "utf8", env: { ...process.env, STUB_BODY: JSON.stringify(attackBody([atk()])) } });
      assert.equal(r.status, 2, "联接指向受保护目录时必须 exit2");
      assert.match(r.stderr, /受保护目录/);
      assert.equal(existsSync(out), false, "不得在联接指向的受保护目录下创建输出");
    } finally { rmSync(c1.dir, { recursive: true, force: true }); }
    // 阴性：直接指向联接本体
    const c2 = ctx([{ label: "i1", kind: "attack" }]);
    try {
      const r = spawnSync(process.execPath, [DRIVER, "--plan", c2.plan, "--out", link, "--runner", c2.runner,
        "--budget", c2.ledger, "--baseline-used", "0", "--ceiling", "32", "--cap", "200"],
        { cwd: TS_ROOT, encoding: "utf8", env: { ...process.env, STUB_BODY: JSON.stringify(attackBody([atk()])) } });
      assert.equal(r.status, 2, "直接指向联接本体同样必须拒绝");
    } finally { rmSync(c2.dir, { recursive: true, force: true }); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
