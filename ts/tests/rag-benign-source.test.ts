/**
 * 第三轮限定返工（Codex `9306f74` delta 返工单）：**来源与请求事实不得推断**。
 *
 * 三项现象级反例（都在真实桥 + 本机回环替身上做，零外部请求）：
 *   S1 **缓存历史不得冒充本次发送**：健康请求填缓存 → 同身份 replay ⇒ 服务器**0 新增**，
 *      良性的 `transport.requestSent` 必须为 **false**（历史 `attempts` 原样保留、不删）。
 *   S2 **缺 transport 不得猜成离线靶子**：LLM replay miss（新盐、无缓存）⇒ 桥调用 0、无送达证据，
 *      此时 `transport.offline` 必须为 **null**、`evidenceSource` 必须为 `unknown`，逐条证据里**不得出现 AgroBot**。
 *   R3-connection **尝试事实**：真实桥先 not-connecting（连接失败）、下一次重试被额度拒绝 ⇒
 *      outcome 必须是 `targetError` + `budget.stopped=true`，`attempts[]` 保留，理由**不得**写"任何 attempt 之前"。
 * 对照：首发前额度拒绝（健康服务器 + 已用尽账本）仍为 `budgetRefused`（合法）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const RAG_EVAL = resolve(TS_ROOT, "scripts", "rag-eval.ts");
const BRIDGE_SERVER = join(HERE, "fixtures", "bridge-attempt-server.mjs");

interface CaseEvidence {
  id: string;
  outcome: string;
  reason: string;
  budget: { stopped: boolean; reason: string };
  transport: {
    evidence: null | { state: string; attemptId: string; fromCache?: boolean; attempts?: Array<{ n: number; outcome: string; attemptId: string }> };
    requestSent: boolean;
    httpAttempted?: boolean;
    offline: null | { label: string; note: string };
    evidenceSource: string;
    /** 桥回报的尝试计数（缺失 = 未知；不得补 0） */
    bridgeReportedAttempts?: number;
  };
}
interface Payload {
  batch?: { usage: { httpAttempts: number } };
  benign?: { healthy: number; budgetRefused: number; budgetStopped: number; targetError: number; perCase: CaseEvidence[] };
}

async function startServer(dir: string, mode: string): Promise<{ port: number; hits: () => number; stop: () => void }> {
  const file = join(dir, `hits-${mode}-${Math.random().toString(36).slice(2, 7)}.log`);
  const child = spawn(process.execPath, [BRIDGE_SERVER, file, mode], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((ready, fail) => {
    let buf = "";
    const t = setTimeout(() => fail(new Error("替身服务器未在 10s 内就绪")), 10_000);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /READY (\d+)/.exec(buf);
      if (m) { clearTimeout(t); ready(Number(m[1])); }
    });
    child.on("error", fail);
  });
  return {
    port,
    hits: () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length : 0),
    stop: () => child.kill(),
  };
}

/** 跑一次 RAG 评测（llm 通道 / 本机回环），返回报告 payload 与各计数 */
function runRag(opts: {
  dir: string; baseUrl: string; salt: string; mode: "fresh" | "replay"; budget: string; budgetLimit: number;
  model: string; outName: string; benignRows?: number;
}): { status: number | null; payload: Payload | null; stderr: string; outDir: string } {
  const attacks = join(opts.dir, "attacks.jsonl");
  const benign = join(opts.dir, `benign-${opts.benignRows ?? 1}.jsonl`);
  if (!existsSync(attacks)) writeFileSync(attacks, "", "utf8");
  if (!existsSync(benign)) {
    const rows = Array.from({ length: opts.benignRows ?? 1 }, (_, i) => JSON.stringify({ id: `B-${i + 1}`, query: "滴灌系统的工作压力应该控制在多少？" }));
    writeFileSync(benign, rows.join("\n") + "\n", "utf8");
  }
  const outDir = join(opts.dir, opts.outName);
  const r = spawnSync(process.execPath, [RAG_EVAL,
    "--cases", attacks, "--benign-cases", benign, "--profile", "none",
    "--target", "llm", "--mode", opts.mode, "--salt", opts.salt,
    "--budget", opts.budget, "--budget-limit", String(opts.budgetLimit), "--out", outDir,
  ], {
    cwd: TS_ROOT, encoding: "utf8",
    env: { ...process.env, AICGUARD_BASE_URL: opts.baseUrl, AICGUARD_API_KEY: "sk-test-not-real", AICGUARD_MODEL: opts.model },
  });
  const reportPath = join(outDir, "rag-report.json");
  return {
    status: r.status, stderr: r.stderr ?? "", outDir,
    payload: existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, "utf8")) as Payload) : null,
  };
}

test("S1 缓存重放：服务器 0 新增请求 ⇒ requestSent=false，历史 attempts 原样保留（不删以掩盖来源）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-benign-cache-"));
  const srv = await startServer(dir, "healthy");
  const model = `m-benign-cache-${process.pid}-${Date.now().toString(36)}`;
  const cacheDir = join(TS_ROOT, "runs", "llm-cache", model.replace(/[^\w.-]/g, "_"));
  try {
    const base = `http://127.0.0.1:${srv.port}/v1`;
    const first = runRag({ dir, baseUrl: base, salt: "r3-cache", mode: "fresh", budget: join(dir, "b1.json"), budgetLimit: 2, model, outName: "fresh" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(srv.hits(), 1, "fresh 应该真的打一次");
    assert.equal(first.payload!.benign!.perCase[0]!.transport.requestSent, true, "fresh 是本次真正发出");

    const second = runRag({ dir, baseUrl: base, salt: "r3-cache", mode: "replay", budget: join(dir, "b2.json"), budgetLimit: 2, model, outName: "replay" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(srv.hits(), 1, "replay 命中缓存 ⇒ **0 新增** HTTP");
    assert.equal(second.payload!.batch?.usage.httpAttempts ?? 0, 0, "本次 httpAttempts 必须为 0");
    const c = second.payload!.benign!.perCase[0]!;
    assert.equal(c.transport.requestSent, false, "缓存重放不是“本次已发送”");
    assert.equal(c.transport.evidence?.fromCache, true, "必须标出证据来自缓存");
    assert.ok((c.transport.evidence?.attempts?.length ?? 0) >= 1, "历史 attempts 必须原样保留（不得删除以掩盖来源）");
  } finally {
    srv.stop(); rmSync(cacheDir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 replay miss（新盐、无缓存）：桥调用 0、无送达证据 ⇒ 不得猜成 AgroBot 离线来源", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-benign-miss-"));
  const model = `m-benign-miss-${process.pid}-${Date.now().toString(36)}`;
  const cacheDir = join(TS_ROOT, "runs", "llm-cache", model.replace(/[^\w.-]/g, "_"));
  try {
    const r = runRag({ dir, baseUrl: "http://127.0.0.1:9/v1", salt: `r3-miss-${Date.now().toString(36)}`, mode: "replay", budget: join(dir, "b.json"), budgetLimit: 2, model, outName: "miss" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.payload!.batch?.usage.httpAttempts ?? 0, 0, "replay miss 不得发生 HTTP");
    const c = r.payload!.benign!.perCase[0]!;
    assert.equal(c.transport.offline, null, "LLM 通道不得被写成“离线靶子（AgroBot）”");
    assert.notEqual(c.transport.evidenceSource, "offline_target", "来源不得推断为离线靶子");
    assert.doesNotMatch(JSON.stringify(r.payload!.benign), /AgroBot/, "逐条证据里不得出现 AgroBot");
    assert.ok(["unknown", "transport"].includes(c.transport.evidenceSource), `来源只能是 transport/unknown，实际 ${c.transport.evidenceSource}`);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
  }
});

test("R3-connection 连接失败一次后撞预算：不得归为“任何 attempt 之前拒绝”，尝试证据要保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-benign-conn-"));
  const budget = join(dir, "b.json");
  try {
    // 死端口：fetch 必然失败（not-connecting），随后重试被 1 次上限的额度拒绝
    const r = runRag({ dir, baseUrl: "http://127.0.0.1:9/v1", salt: "r3-conn", mode: "fresh", budget, budgetLimit: 1,
      model: `m-benign-conn-${process.pid}-${Date.now().toString(36)}`, outName: "conn" });
    assert.equal(r.status, 0, r.stderr);
    const used = JSON.parse(readFileSync(budget, "utf8")).used as number;
    assert.equal(used, 1, "临时账本 used=1（连接尝试占用了额度）");
    const c = r.payload!.benign!.perCase[0]!;
    assert.equal(c.outcome, "targetError", "已有 not-connecting 尝试 ⇒ 按错误处置");
    assert.equal(c.budget.stopped, true, "同时独立标记额度中止");
    assert.equal(c.transport.requestSent, false, "连接失败不算“发出去”");
    assert.ok((c.transport.evidence?.attempts?.length ?? 0) >= 1, "尝试记录必须保留");
    assert.ok((c.transport.evidence?.attempts?.[0]?.attemptId ?? "").length > 0, "尝试标识必须保留");
    assert.doesNotMatch(c.reason, /任何 attempt 之前|未发出请求/, `理由不得声称零尝试：${c.reason}`);
    assert.match(c.reason, /尝试|not-connecting|连接/, `理由要点明真实尝试事实：${c.reason}`);
    assert.equal(r.payload!.benign!.budgetRefused, 0, "不得落成“首发前拒绝”");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("对照：首发前额度拒绝（健康服务器 + 已用尽账本）仍应为 budgetRefused，且 0 新增请求", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-benign-pre-"));
  const srv = await startServer(dir, "healthy");
  const budget = join(dir, "b.json");
  const model = `m-benign-pre-${process.pid}-${Date.now().toString(36)}`;
  try {
    const base = `http://127.0.0.1:${srv.port}/v1`;
    const first = runRag({ dir, baseUrl: base, salt: "r3-pre-1", mode: "fresh", budget, budgetLimit: 1, model, outName: "first" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(srv.hits(), 1, "第一次真的发出（额度用尽）");
    const second = runRag({ dir, baseUrl: base, salt: "r3-pre-2", mode: "fresh", budget, budgetLimit: 1, model, outName: "second" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(srv.hits(), 1, "第二次发送前被拒 ⇒ 0 新增请求");
    const c = second.payload!.benign!.perCase[0]!;
    assert.equal(c.outcome, "budgetRefused", "真正零尝试才叫首发前拒绝");
    assert.equal(c.budget.stopped, true);
    assert.match(c.reason, /首发前拒绝|零次尝试/, "这一条才是合法的“零尝试”表述");
    assert.equal(c.transport.bridgeReportedAttempts, 0, "桥明确回报 0 次 ⇒ 这是“证据表明零次”");
    assert.equal(second.payload!.benign!.budgetRefused, 1);
  } finally { srv.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================ 第四轮（P2：缺证据不得断言零次）
//
// 兼容/旧桥可以**只回报一个计数**而没有 `request/transport`：
//   {"text":"","error":"legacy transport log unavailable","attempts":1,"budgetExhausted":true,"budgetStop":"exhausted"}
// 此时"尝试过"是**已知事实**（桥自己报的），"具体哪次/正文"仍未知；
// 而字段**缺失**则是**未知**（既不能断言零次，也不能断言发过 HTTP）。
// 契约：只有**明确的首发前拒绝证据**（state=refused 且 attempts=0）才允许 `budgetRefused`；
// 其余一律 `targetError` + `budget.stopped`，并保留原始来源（桥回报的计数）。
const LEGACY_BRIDGE = (withAttempts: boolean) => `
import { readFileSync } from "node:fs";
readFileSync(0, "utf8");
process.stdout.write(JSON.stringify(${JSON.stringify({
  text: "", error: "legacy transport log unavailable",
  ...(withAttempts ? { attempts: 1 } : {}),
  budgetExhausted: true, budgetStop: "exhausted",
})}));
`;

/** 用替身（兼容）桥跑一次；**不触网**（替身桥不发 HTTP） */
function runWithStubBridge(withAttempts: boolean): { payload: Payload | null; httpAttempts: number } {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-benign-legacy-"));
  try {
    writeFileSync(join(dir, "stub-bridge.mjs"), LEGACY_BRIDGE(withAttempts), "utf8");
    const attacks = join(dir, "attacks.jsonl");
    const benign = join(dir, "benign.jsonl");
    writeFileSync(attacks, "", "utf8");
    writeFileSync(benign, JSON.stringify({ id: "B-legacy", query: "滴灌系统的工作压力应该控制在多少？" }) + "\n", "utf8");
    const out = join(dir, "out");
    const r = spawnSync(process.execPath, [RAG_EVAL,
      "--cases", attacks, "--benign-cases", benign, "--profile", "none",
      "--target", "llm", "--mode", "fresh", "--salt", "r4-legacy",
      "--budget", join(dir, "b.json"), "--budget-limit", "5", "--out", out,
    ], {
      cwd: TS_ROOT, encoding: "utf8",
      env: {
        ...process.env,
        AICGUARD_BRIDGE: join(dir, "stub-bridge.mjs"),
        AICGUARD_BASE_URL: "http://127.0.0.1:9/v1", AICGUARD_API_KEY: "sk-test-not-real", AICGUARD_MODEL: "m-legacy",
      },
    });
    assert.equal(r.status, 0, `必须正常退出（替身桥不发网络）：${r.stderr}`);
    const reportPath = join(out, "rag-report.json");
    return {
      payload: existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, "utf8")) as Payload & { benign?: { budgetRefused: number; targetError: number } }) : null,
      httpAttempts: (JSON.parse(readFileSync(reportPath, "utf8")) as Payload).batch?.usage.httpAttempts ?? -1,
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("R4① 兼容桥回报 attempts=1（无 transport）：不得断言零次，须 targetError + budget.stopped + 保留来源", () => {
  const { payload, httpAttempts } = runWithStubBridge(true);
  assert.ok(payload?.benign, "必须有 benign 块");
  const c = payload!.benign!.perCase[0]! as unknown as {
    outcome: string; reason: string; transport: { evidence: unknown; bridgeReportedAttempts?: number; httpAttempted: boolean };
  };
  assert.equal(httpAttempts, 1, "桥回报的计数应体现在 batch 口径上（协议事实）");
  assert.notEqual(c.outcome, "budgetRefused", "桥已回报尝试过 ⇒ 不得归为“首发前拒绝”");
  assert.equal(c.outcome, "targetError");
  assert.equal(c.transport.evidence, null, "没有 request 证据就老实说没有");
  assert.equal(c.transport.bridgeReportedAttempts, 1, "必须保留原始来源（桥回报的计数）");
  assert.equal(c.transport.httpAttempted, false, "桥回报计数不是“本轮确实发了 HTTP”的证据");
  assert.doesNotMatch(c.reason, /任何 attempt 之前|确实一次都没尝试/, `理由不得断言零次：${c.reason}`);
  assert.match(c.reason, /attempts=1|桥回报/, `理由要点名来源：${c.reason}`);
  assert.equal((payload!.benign as unknown as { budgetRefused: number }).budgetRefused, 0);
  assert.equal((payload!.benign as unknown as { targetError: number }).targetError, 1);
});

test("R4② 兼容桥缺 attempts 字段（无 transport）：未知不得推断为零次", () => {
  const { payload } = runWithStubBridge(false);
  const c = payload!.benign!.perCase[0]! as unknown as {
    outcome: string; reason: string; transport: { bridgeReportedAttempts?: number };
  };
  assert.notEqual(c.outcome, "budgetRefused", "缺证据 ⇒ 不得断言“首发前拒绝”");
  assert.equal(c.outcome, "targetError");
  assert.equal((payload!.benign as unknown as { budgetRefused: number }).budgetRefused, 0);
  assert.match(c.reason, /缺少尝试证据|未知/, `理由要说明的是“缺证据”而不是“零次”：${c.reason}`);
  assert.equal(c.transport.bridgeReportedAttempts, undefined, "缺失就是缺失，不得补 0");
});

// ============================================================ 第五轮（P2：未知逐次状态不得被默认允许）
//
// 第四轮的判据是**否定式**：`every(!已知尝试状态)` ⇒ 只排除三种已知状态，
// 于是**未知 outcome 字符串**（如 `bridge-status-unknown`）被默认当成"未尝试"，仍落 budgetRefused。
// 契约（肯定式白名单）：只有逐次记录**全部**是 `refused`/`not-sent`/`dry-run` 才是"明确未尝试"；
// 未知/矛盾状态一律不得获得零次证明 —— 保留原件、按错误处置。

/** 用给定的**桥 JSON** 跑一次（替身桥不发网络，零外部请求） */
function runWithBridgePayload(payload: Record<string, unknown>): Payload | null {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-benign-payload-"));
  try {
    writeFileSync(join(dir, "stub-bridge.mjs"), `
import { readFileSync } from "node:fs";
readFileSync(0, "utf8");
process.stdout.write(JSON.stringify(${JSON.stringify(payload)}));
`, "utf8");
    const attacks = join(dir, "attacks.jsonl");
    const benign = join(dir, "benign.jsonl");
    writeFileSync(attacks, "", "utf8");
    writeFileSync(benign, JSON.stringify({ id: "B-unknown", query: "滴灌系统的工作压力应该控制在多少？" }) + "\n", "utf8");
    const out = join(dir, "out");
    const r = spawnSync(process.execPath, [RAG_EVAL,
      "--cases", attacks, "--benign-cases", benign, "--profile", "none",
      "--target", "llm", "--mode", "fresh", "--salt", "r5-unknown",
      "--budget", join(dir, "b.json"), "--budget-limit", "5", "--out", out,
    ], {
      cwd: TS_ROOT, encoding: "utf8",
      env: {
        ...process.env,
        AICGUARD_BRIDGE: join(dir, "stub-bridge.mjs"),
        AICGUARD_BASE_URL: "http://127.0.0.1:9/v1", AICGUARD_API_KEY: "sk-test-not-real", AICGUARD_MODEL: "m-unknown",
      },
    });
    assert.equal(r.status, 0, `必须正常退出（替身桥不发网络）：${r.stderr}`);
    const reportPath = join(out, "rag-report.json");
    return existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, "utf8")) as Payload) : null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const REFUSED_REQUEST = { state: "refused", sha256: "", bytes: 0, attemptId: "refused-control", decodedText: "" };
const UNKNOWN_LOG = [
  { n: 1, outcome: "bridge-status-unknown", attemptId: "record-bridge-status-unknown", sha256: "", bytes: 0 },
  { n: 1, outcome: "refused", attemptId: "record-refused", sha256: "", bytes: 0 },
];

test("R5① ★反例：逐次记录含**未知状态**且缺计数 ⇒ 不得断言零次（不得 budgetRefused）", () => {
  const p = runWithBridgePayload({
    text: "", error: "legacy transport detail unavailable",
    budgetExhausted: true, budgetStop: "exhausted",
    request: REFUSED_REQUEST, attemptsLog: UNKNOWN_LOG,
  });
  assert.ok(p?.benign, "必须有 benign 块");
  const c = p!.benign!.perCase[0]! as unknown as {
    outcome: string; reason: string;
    transport: { evidence: null | { attempts?: Array<{ outcome: string }> }; bridgeReportedAttempts?: number };
  };
  assert.notEqual(c.outcome, "budgetRefused", "未知状态不能因“不属于已知尝试状态”就获得零次证明");
  assert.equal(c.outcome, "targetError");
  assert.equal((p!.benign as unknown as { budgetRefused: number }).budgetRefused, 0);
  assert.doesNotMatch(c.reason, /确实零次尝试/, `理由不得断言零次：${c.reason}`);
  assert.match(c.reason, /缺少尝试证据|未知/, `理由要说明“缺证据/未知”：${c.reason}`);
  assert.ok((c.transport.evidence?.attempts ?? []).some((a) => a.outcome === "bridge-status-unknown"),
    "未知原件必须保留（不得删除或改写）");
});

test("R5② 对照：同样含未知记录**但协议有正计数** ⇒ 仍 targetError 且保留计数（不授予零次）", () => {
  const p = runWithBridgePayload({
    text: "", error: "legacy transport detail unavailable", attempts: 1,
    budgetExhausted: true, budgetStop: "exhausted",
    request: REFUSED_REQUEST, attemptsLog: UNKNOWN_LOG,
  });
  const c = p!.benign!.perCase[0]! as unknown as { outcome: string; transport: { bridgeReportedAttempts?: number } };
  assert.equal(c.outcome, "targetError");
  assert.equal(c.transport.bridgeReportedAttempts, 1);
  assert.equal((p!.benign as unknown as { budgetRefused: number }).budgetRefused, 0);
});

test("R5③ 对照：逐次记录**只有明确 refused**且计数为 0 ⇒ 仍应 budgetRefused（肯定式白名单生效）", () => {
  const p = runWithBridgePayload({
    text: "", error: "budget_exhausted: 额度不足（发送前拒绝）", attempts: 0,
    budgetExhausted: true, budgetStop: "exhausted",
    request: REFUSED_REQUEST,
    attemptsLog: [{ n: 1, outcome: "refused", attemptId: "record-refused", sha256: "", bytes: 0 }],
  });
  const c = p!.benign!.perCase[0]! as unknown as { outcome: string; transport: { bridgeReportedAttempts?: number } };
  assert.equal(c.outcome, "budgetRefused", "明确未尝试才允许零次断言");
  assert.equal(c.transport.bridgeReportedAttempts, 0);
  assert.equal((p!.benign as unknown as { budgetRefused: number }).budgetRefused, 1);
});
