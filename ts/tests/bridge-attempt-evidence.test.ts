/**
 * 桥的**送达事实**与**响应阶段错误**必须分开（Codex 复核 R1）。
 *
 * 锁的是：HTTP 已经响应（连接事实 = `submitted`）之后的**响应解析失败 / 响应体读取失败**
 * **不得**把这个事实改写掉，也**不得**在逐次日志里留下两条同 ID 的记录。
 * 修前的实测反例（Codex 探针，HTTP 200 + 非法 JSON、limit=1）：实际只发出 1 次 HTTP，
 * 逐次日志却有**两条同 ID 的 not-connecting**；顶层 `submitted` 在逐次记录里**找不到同源的那条**。
 *
 * 三条断言口径（独立于桥自己报的数字）：
 *   ① 一次真实 HTTP 尝试 ⇔ **恰好一条**带正文的逐次记录（HTTP 次数来自替身服务器自己落盘的行数）；
 *   ② `attemptId` 不重复（一次尝试 = 一条记录，登记后不可变）；
 *   ③ 顶层三元组（attemptId/sha256/bytes）必须与逐次记录里的某一条**逐字段一致**。
 *
 * 全程离线：替身服务器跑在 127.0.0.1 的随机端口，凭据是假串，**不访问任何外部网络**。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { LlmBot } from "../src/targets/llmbot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const BRIDGE = resolve(TS_ROOT, "src", "targets", "llm-bridge.mjs");
const SERVER = join(HERE, "fixtures", "bridge-attempt-server.mjs");

interface AttemptRow {
  n: number;
  outcome: string;
  attemptId: string;
  sha256: string;
  bytes: number;
  decodedText: string;
  responseError?: string;
  responseErrorKind?: string;
}interface BridgeOut {
  text: string;
  error: string;
  attempts: number;
  toolCalls: Array<{ name: string; arguments: Record<string, string> }>;
  /** 用量来源/完整度（F1/F3：由桥按**逐次尝试**合成） */
  usageSource: string;
  usage: { prompt_tokens: number; completion_tokens: number };
  request: { state: string; sha256: string; bytes: number; attemptId: string; decodedText: string };
  attemptsLog: AttemptRow[];
}

/** 起替身服务器（独立子进程），返回端口与"实际收到几次 HTTP 请求"的读数 */
async function startServer(dir: string, mode: string): Promise<{ port: number; hits: () => number; stop: () => void }> {
  const file = join(dir, `hits-${mode}.log`);
  const child = spawn(process.execPath, [SERVER, file, mode], { stdio: ["ignore", "pipe", "inherit"] });
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

/** 跑**真实桥**：`limit` 决定允许几次真实 HTTP 尝试（之后的重试在发送前被预算拦下） */
function runBridge(port: number, budget: string, limit = 1): BridgeOut {
  const r = spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify({
      baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test-not-real", model: "m-attempt",
      system: "系统提示（SYS）", messages: [{ role: "user", content: "请只依据文档回答：滴灌压力是多少？" }],
      maxTokens: 64, temperature: 0, timeoutMs: 5000,
      budget: { path: budget, runId: "att", source: "bridge", limit },
    }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `桥必须正常退出（有结论）：${r.stderr || "(no stderr)"}`);
  return JSON.parse(r.stdout) as BridgeOut;
}

/** 三件套断言：同 ID 不重复、一次 HTTP 恰好一条带正文记录、顶层三元组与某条逐次记录逐字段一致 */
function assertDeliveryFacts(out: BridgeOut, httpHits: number): void {
  const ids = out.attemptsLog.map((r) => r.attemptId);
  assert.equal(new Set(ids).size, ids.length, `attemptId 不得重复（一次尝试 = 一条记录）：${JSON.stringify(ids)}`);
  const withBody = out.attemptsLog.filter((r) => r.attemptId !== "");
  assert.equal(withBody.length, httpHits,
    `带正文的逐次记录数必须等于实际 HTTP 请求数（独立计数源）：记录 ${withBody.length} vs 实际 ${httpHits}`);
  // 顶层三元组必须与逐次记录里"那条 state 相同、attemptId 相同"的记录逐字段一致
  const hit = out.attemptsLog.find((r) => r.attemptId === out.request.attemptId);
  assert.ok(hit, `顶层 attemptId ${JSON.stringify(out.request.attemptId)} 在逐次记录里找不到 ⇒ 三元组不同源`);
  assert.equal(hit.outcome, out.request.state, "顶层 state 必须与它的同源记录一致");
  assert.equal(hit.sha256, out.request.sha256, "顶层哈希必须与其同源记录一致");
  assert.equal(hit.bytes, out.request.bytes, "顶层字节数必须与其同源记录一致");
  assert.equal(hit.decodedText, out.request.decodedText, "顶层解码文本必须与其同源记录一致");
}

test("R1-① 阴性对照：健康 JSON ⇒ 一次 HTTP、一条 submitted 记录、无错误", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-attempt-ok-"));
  const srv = await startServer(dir, "healthy");
  try {
    const out = runBridge(srv.port, join(dir, "budget.json"));
    assert.equal(out.request.state, "submitted");
    assert.equal(out.error, "", "健康响应不得报错");
    assert.equal(out.attemptsLog[0].responseErrorKind, undefined);
    assert.equal(out.text, "替身回复");
    assert.equal(out.attempts, 1, "只占用了 1 次额度（第 2 次尝试被发送前拦下）");
    assert.equal(srv.hits(), 1, "独立计数：恰好 1 次真实 HTTP");
    assert.equal(out.attemptsLog.length, 1, "一次尝试 = 一条记录");
    assertDeliveryFacts(out, srv.hits());
  } finally {
    srv.stop();
  }
});

test("R1-② ★反例：HTTP 200 + 非法 JSON ⇒ 送达事实不被解析失败改写，错误仍可见，同 ID 不重复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-attempt-badjson-"));
  const srv = await startServer(dir, "invalid-json");
  try {
    const out = runBridge(srv.port, join(dir, "budget.json"));
    // ① 连接已建立 ⇒ 送达事实**不许丢**
    assert.equal(out.request.state, "submitted", "HTTP 已响应 ⇒ 不得被解析失败改写成 not-connecting");
    assert.equal(out.text, "", "解析失败 ⇒ 不得凭空产出文本");
    // ② 错误仍可见
    assert.ok(out.error.length > 0, "解析失败必须报错（不得静默成空响应）");
    assert.match(out.error, /响应解析失败/, `错误里要说明是响应解析失败：${out.error}`);
    // ③ 独立计数：真的只发了 1 次 HTTP
    assert.equal(srv.hits(), 1, "解析失败后是**重试被预算拦下**，不得再发第二次 HTTP");
    // ④ 带正文的那条记录 outcome 必须是 submitted（修前会被改写成 not-connecting，且出现两条同 ID）
    const withBody = out.attemptsLog.filter((r) => r.attemptId !== "");
    assert.equal(withBody.length, 1);
    assert.equal(withBody[0].outcome, "submitted", "连接成功的尝试不得被后续解析失败改写");
    assert.match(withBody[0].responseError ?? "", /响应解析失败/, "响应阶段错误必须逐条留痕");
    assert.equal(withBody[0].responseErrorKind, "json_parse");
    assert.equal(out.attemptsLog.find(a => a.outcome === "refused")?.responseErrorKind, "budget");
    assertDeliveryFacts(out, srv.hits());
    // ⑤ 精确反例：不得再出现"同一次尝试既有 submitted 又有 not-connecting"
    assert.equal(out.attemptsLog.filter((r) => r.outcome === "not-connecting").length, 0,
      "这次尝试明明连上了，不得出现 not-connecting 记录");
  } finally {
    srv.stop();
  }
});

test("R1-③ ★反例：响应体读取失败（声明长度却提前断开）⇒ 同样不改写送达事实", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-attempt-brokenbody-"));
  const srv = await startServer(dir, "broken-body");
  try {
    const out = runBridge(srv.port, join(dir, "budget.json"));
    assert.equal(out.request.state, "submitted", "服务端已回响应头 ⇒ 送达事实成立，读取失败不得改写它");
    assert.equal(out.text, "");
    assert.match(out.error, /响应体读取失败/, `错误里要说明是响应体读取失败（且不得被 HTTP 状态错误吃掉）：${out.error}`);
    assert.match(out.error, /HTTP 400/, "HTTP 状态错误与响应阶段错误**都要保留**（互不覆盖）");
    assert.equal(srv.hits(), 1);
    const withBody = out.attemptsLog.filter((r) => r.attemptId !== "");
    assert.equal(withBody.length, 1);
    assert.equal(withBody[0].outcome, "submitted");
    assert.match(withBody[0].responseError ?? "", /响应体读取失败/);
    assert.equal(withBody[0].responseErrorKind, "body_read");
    assertDeliveryFacts(out, srv.hits());
  } finally {
    srv.stop();
  }
});

/**
 * Codex delta 复核 D1 的反例组：**状态错误也必须归属到对应 attempt**，且失败时的错误链要保留全程。
 *
 * 修前实测（复核者探针 `retry-results.json` name=http500-invalid）：HTTP500 → 200非法JSON → 预算拒绝，
 * 真实本机 HTTP = 2、额度消耗 2，但 `attemptsLog[0]` **没有 HTTP 500**、最终 `error` 只有解析错 + 预算，
 * 第一错整条丢失。另一面：`recover`（先失败后成功）时 `error` 里还残留历史错误——
 * 桥的调用级结论不能因此变成"失败"。
 */
function assertChain(out: BridgeOut, mustHave: RegExp[]): void {
  for (const re of mustHave) assert.match(out.error, re, `错误链缺少 ${re}：${out.error}`);
}

test("D1-① ★反例：HTTP 500 → 200非法JSON → 预算拒绝 ⇒ 错误链三件都在，且各自归属对应 attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-chain-500-"));
  const srv = await startServer(dir, "http500-then-invalid-json");
  try {
    // limit=2 ⇒ 两次真实 HTTP 各占 1 次额度，第三次重试在**发送前**被预算拦下
    const out = runBridge(srv.port, join(dir, "budget.json"), 2);
    assert.equal(srv.hits(), 2, "独立计数：实际只发出 2 次 HTTP（第三次没发出去）");
    const rows = out.attemptsLog;
    assert.equal(rows.length, 3, "逐次记录 = 2 次真实尝试 + 1 次发送前拒绝");
    assert.equal(rows[0].outcome, "submitted");
    assert.match(rows[0].responseError ?? "", /HTTP 500/, "★ 首次的 500 必须落在它自己的 attempt 上（修前丢了）");
    assert.equal(rows[1].outcome, "submitted");
    assert.match(rows[1].responseError ?? "", /响应解析失败/);
    assert.equal(rows[2].outcome, "refused");
    assert.match(rows[2].responseError ?? "", /budget_exhausted/, "发送前拒绝的原因也要落在它自己的 attempt 上");
    // 调用级错误链：致命那条在前 + 更早尝试补齐 ⇒ 三件都在
    assertChain(out, [/budget_exhausted/, /HTTP 500/, /响应解析失败/]);
    assert.ok(out.error.indexOf("budget_exhausted") < out.error.indexOf("HTTP 500"),
      "决定这次调用结论的（预算拒绝）应在最前，更早的作为上下文跟在后面");
    // 送达事实与同源三元组不变
    assert.equal(out.request.state, "submitted");
    assert.equal(out.attempts, 2, "额度消耗 = 2 次真实 HTTP 尝试（硬预算不变）");
    assertDeliveryFacts(out, srv.hits());
  } finally {
    srv.stop();
  }
});

test("D1-② ★反例（同形）：HTTP 429 → 200非法JSON → 预算拒绝 ⇒ 限流也要逐次留痕", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-chain-429-"));
  const srv = await startServer(dir, "429-then-invalid-json");
  try {
    const out = runBridge(srv.port, join(dir, "budget.json"), 2);
    assert.equal(srv.hits(), 2);
    assert.match(out.attemptsLog[0].responseError ?? "", /HTTP 429/);
    assert.equal(out.attemptsLog[1].outcome, "submitted");
    assert.match(out.attemptsLog[1].responseError ?? "", /响应解析失败/);
    assert.equal(out.attemptsLog[2].outcome, "refused");
    assertChain(out, [/budget_exhausted/, /HTTP 429/, /响应解析失败/]);
    assertDeliveryFacts(out, srv.hits());
  } finally {
    srv.stop();
  }
});

test("D1-③ 恢复成功对照（先 500 后健康）：调用**成功**，历史错误只留在逐次记录里", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-chain-rec500-"));
  const srv = await startServer(dir, "recover-500");
  try {
    const out = runBridge(srv.port, join(dir, "budget.json"), 2);
    assert.equal(srv.hits(), 2, "第一次 500、第二次成功");
    assert.equal(out.request.state, "submitted");
    assert.equal(out.text, "替身回复", "恢复成功后必须拿到文本");
    assert.equal(out.error, "", "★ 恢复成功 ⇒ 顶层不得残留历史错误（否则下游会把正常回复读成故障）");
    assert.match(out.attemptsLog[0].responseError ?? "", /HTTP 500/, "但历史错误也不许丢：它留在第 1 次尝试上");
    assert.equal(out.attemptsLog[1].responseError ?? "", "", "成功的那次记录没有错误");
    assertDeliveryFacts(out, srv.hits());
  } finally {
    srv.stop();
  }
});

test("D1-④ 恢复成功对照（先非法JSON后健康）：解析失败不得升级成调用级失败", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-chain-recparse-"));
  const srv = await startServer(dir, "recover-parse");
  try {
    const out = runBridge(srv.port, join(dir, "budget.json"), 2);
    assert.equal(srv.hits(), 2);
    assert.equal(out.text, "替身回复");
    assert.equal(out.error, "");
    assert.match(out.attemptsLog[0].responseError ?? "", /响应解析失败/);
    assertDeliveryFacts(out, srv.hits());
  } finally {
    srv.stop();
  }
});

/**
 * Codex 复核 E1 的反例组：**一次完整解析成功才可发布结果**。
 *
 * 修前实测（复核者 `schema-usage-results.json` mode=malformed）：服务器返回 HTTP200 + 合法 JSON，
 * `message={content:"partial-parse-text", tool_calls:{unexpected:"object"}}`；桥**先写文本**再遍历
 * tool_calls ⇒ 抛错时残留文本已落在顶层；下一次额度拒绝后 `usable` 仍为真 ⇒ 没有一次完整成功的响应
 * 却被发布成成功，并经真实 LlmBot 写出**成功缓存**（errors=0、无 budgetExhausted）。
 */
test("E1-① ★反例：tool_calls 不是数组 ⇒ 失败解析不得泄出残留文本，错误链保留解析错+预算拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-e1-malformed-"));
  const srv = await startServer(dir, "malformed-tool-calls");
  try {
    const out = runBridge(srv.port, join(dir, "budget.json"), 1);
    assert.equal(srv.hits(), 1, "limit=1 ⇒ 只有第一次真实 HTTP，重试在发送前被拦");
    assert.equal(out.text, "", "★ 解析半途失败 ⇒ 顶层不得残留任何文本");
    assert.deepEqual(out.toolCalls, [], "★ 也不得泄出半个工具数组");
    assert.equal(out.request.state, "submitted", "连接事实仍然是 submitted（送达证据不丢）");
    assert.ok(out.error.length > 0, "调用失败 ⇒ 必须有错误");
    assert.match(out.error, /响应解析失败/, "错误链里要能看到解析失败");
    assert.match(out.error, /tool_calls 必须是数组/, "并说明是哪一步的协议校验失败");
    assert.match(out.error, /budget_exhausted/, "以及随后发送前被预算拦下");
    assert.equal(out.usageSource, "unknown", "没有一次完整解析 ⇒ 用量来源必须是 unknown（不得声称拿到了供应商用量）");
    const rows = out.attemptsLog;
    assert.equal(rows.length, 2, "1 次真实尝试 + 1 次发送前拒绝");
    assert.match(rows[0].responseError ?? "", /响应解析失败/);
    assert.equal(rows[1].outcome, "refused");
    assertDeliveryFacts(out, srv.hits());
  } finally {
    srv.stop();
  }
});

test("E1-② ★反例：tool_calls 数组第 1 项合法、第 2 项畸形 ⇒ 第一项也不得被提交（防半数组泄漏）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-e1-array-"));
  const srv = await startServer(dir, "malformed-tool-calls-array");
  try {
    const out = runBridge(srv.port, join(dir, "budget.json"), 1);
    assert.equal(out.text, "", "不得残留文本");
    assert.deepEqual(out.toolCalls, [], "★ 数组里第 1 项虽然合法，也必须整批不提交（原子提交）");
    assert.match(out.error, /响应解析失败/);
    assert.match(out.error, /tool_calls\[\]\.function\.name/);
    assert.match(out.error, /budget_exhausted/);
    assertDeliveryFacts(out, srv.hits());
  } finally {
    srv.stop();
  }
});

test("E1-③ 恢复对照：畸形响应之后**真的**拿到健康响应才可判成功（limit=2）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-e1-recover-"));
  const srv = await startServer(dir, "malformed-tool-calls");
  try {
    // limit=2：第 1 次畸形（解析失败）→ 第 2 次**超出序列表 ⇒ 健康响应** ⇒ 这才叫恢复成功
    const out = runBridge(srv.port, join(dir, "budget.json"), 2);
    assert.equal(srv.hits(), 2);
    assert.equal(out.text, "替身回复", "第二次真的成功 ⇒ 有文本");
    assert.equal(out.error, "", "恢复成功 ⇒ 顶层 error 为空");
    assert.equal(out.usageSource, "partial", "★ F3：第 1 次尝试没有用量 ⇒ 整次调用只能算**下界**（不能因最后一次健康就报 reported）");
    assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 5 }, "已得的数字仍保留（下界）");
    assert.match(out.attemptsLog[0].responseError ?? "", /响应解析失败/, "历史失败仍留在第 1 次记录上");
    assertDeliveryFacts(out, srv.hits());
  } finally {
    srv.stop();
  }
});

/**
 * E1 的下游对照（复核者要求「实际捕获最终请求与缓存，不只测桥字符串」）：
 * 用**真实 LlmBot**（真实桥 + 本机替身服务器）跑两条路径。
 */
test("E1-④ 真实 LlmBot：畸形响应 ⇒ 错误可见 + budgetExhausted 透传 + **不写成功缓存**", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-e1-llm-fail-"));
  const srv = await startServer(dir, "malformed-tool-calls");
  const prev = process.env.AICGUARD_BRIDGE;
  const cacheDir = join(dir, "cache");
  try {
    delete process.env.AICGUARD_BRIDGE;            // 走**真实桥**
    const bot = new LlmBot({
      model: "m-e1", baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: "sk-test-not-real",
      systemPrompt: "系统提示", cacheDir, timeoutMs: 3000,
      budget: { path: join(dir, "budget.json"), runId: "e1", limit: 1 },
    });
    const r = bot.respond("请只依据文档回答：滴灌压力是多少？");
    assert.equal(srv.hits(), 1, "只发出 1 次真实 HTTP（重试被预算拦在发送前）");
    assert.ok((r.error ?? "").length > 0, "★ 失败必须报错（修前这里 error 为空、写成成功）");
    assert.match(r.error ?? "", /响应解析失败/);
    assert.equal(r.budgetExhausted, true, "★ 预算中止必须透传（修前没有）");
    assert.equal(r.budgetStopReason, "exhausted");
    assert.equal(bot.errors, 1, "LlmBot 的失败计数要如实 +1");
    assert.equal(readdirSync(cacheDir).length, 0, "★ 失败路径**不得**写成功缓存（修前会多 1 个文件）");
  } finally {
    if (prev === undefined) delete process.env.AICGUARD_BRIDGE; else process.env.AICGUARD_BRIDGE = prev;
    srv.stop();
  }
});

test("E1-⑤ 真实 LlmBot 恢复对照：畸形响应之后真的成功 ⇒ 正常返回且写缓存（limit=2）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-e1-llm-ok-"));
  const srv = await startServer(dir, "malformed-tool-calls");
  const prev = process.env.AICGUARD_BRIDGE;
  const cacheDir = join(dir, "cache");
  try {
    delete process.env.AICGUARD_BRIDGE;
    const bot = new LlmBot({
      model: "m-e1", baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: "sk-test-not-real",
      systemPrompt: "系统提示", cacheDir, timeoutMs: 3000,
      budget: { path: join(dir, "budget.json"), runId: "e1", limit: 2 },
    });
    const r = bot.respond("请只依据文档回答：滴灌压力是多少？");
    assert.equal(srv.hits(), 2, "两次真实 HTTP（第 1 次畸形、第 2 次健康）");
    assert.equal(r.error ?? "", "", "真的成功了 ⇒ 不得带错误");
    assert.equal(r.text, "替身回复");
    assert.equal(bot.errors, 0);
    assert.equal(readdirSync(cacheDir).length, 1, "成功路径照常写缓存（与上面的失败路径形成对照）");
  } finally {
    if (prev === undefined) delete process.env.AICGUARD_BRIDGE; else process.env.AICGUARD_BRIDGE = prev;
    srv.stop();
  }
});

/**
 * Codex 复核 F1/F3 的反例组：**用量必须逐字段校验、并逐次尝试合成来源**。
 *
 * 修前实测（复核者 `usage-provenance-results.json`）：`usage:{}` / `[]` / 缺字段 / 字符串 / 负数
 * 都被"只判断是不是对象"的实现放行，缺字段还被 `?? 0` 补成 0 ⇒ 不完整成本被当成**完整零成本**
 * （走真实 Work Loop 时甚至让整个批次输出"6/6 未达阈值"的负结论）；
 * 同一桥内"先 500（无 usage）再健康 7/11"也只按最后一次算 reported ⇒ 未知重试成本被覆盖。
 */
test("F1-① ★反例：用量字段不完整/非法 ⇒ 一律不得算完整成本（但回答仍成功）", async () => {
  const cases: Array<[string, unknown, string]> = [
    ["empty", {}, "空对象"],
    ["array", [], "数组"],
    ["prompt-only", { prompt_tokens: 7 }, "只给一个字段"],
    ["string", { prompt_tokens: "7", completion_tokens: 11 }, "字符串计数"],
    ["negative", { prompt_tokens: -7, completion_tokens: 11 }, "负数计数"],
  ];
  for (const [mode, , label] of cases) {
    const dir = mkdtempSync(join(tmpdir(), `aicguard-f1-${mode}-`));
    const srv = await startServer(dir, `usage-${mode}`);
    try {
      const out = runBridge(srv.port, join(dir, "budget.json"), 1);
      assert.equal(out.text, "替身回复", `${label}：健康回答必须仍然成功（不得因缺用量把正常回答变成失败）`);
      assert.equal(out.error, "", `${label}：健康回答不该报错`);
      assert.notEqual(out.usageSource, "reported", `${label}：不完整/非法用量**绝不能**标成 reported`);
      const lower = mode === "prompt-only" ? { prompt_tokens: 7, completion_tokens: 0 }
        : mode === "string" || mode === "negative" ? { prompt_tokens: 0, completion_tokens: 11 }
        : { prompt_tokens: 0, completion_tokens: 0 };
      assert.equal(out.usageSource, Object.values(lower).some(n => n > 0) ? "partial" : "unknown", `${label}：合法单字段作为下界，缺失/非法字段不作完整成本`);
      assert.deepEqual(out.usage, lower, `${label}：仅保留合法字段下界，数值槽位不证明完整成本`);
      assert.equal(out.request.state, "submitted");
    } finally {
      srv.stop();
    }
  }
});

test("F1-② 阳性对照：健康 7/11 与**供应商明确报告 0/0** 都必须算 reported（不能把所有 0 一律当未知）", async () => {
  {
    const dir = mkdtempSync(join(tmpdir(), "aicguard-f1-ok-"));
    const srv = await startServer(dir, "usage-zero");
    try {
      const out = runBridge(srv.port, join(dir, "budget.json"), 1);
      assert.equal(out.usageSource, "reported", "供应商报告 0/0 是**合法** reported");
      assert.deepEqual(out.usage, { prompt_tokens: 0, completion_tokens: 0 });
    } finally {
      srv.stop();
    }
  }
  {
    const dir = mkdtempSync(join(tmpdir(), "aicguard-f1-ok711-"));
    const srv = await startServer(dir, "healthy");   // healthy 模式回 3/5；usage-500-then-ok 的 ok7-11 在下一例用
    try {
      const out = runBridge(srv.port, join(dir, "budget.json"), 1);
      assert.equal(out.usageSource, "reported");
      assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 5 });
    } finally {
      srv.stop();
    }
  }
});

test("F3-① ★反例：同一桥内先 500（无 usage）再健康 7/11 ⇒ 整次调用只能算 partial 下界", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-f3-retry-"));
  const srv = await startServer(dir, "http500-then-ok7-11");   // hit1 500、hit2 健康 7/11
  try {
    const out = runBridge(srv.port, join(dir, "budget.json"), 2);
    assert.equal(srv.hits(), 2, "两次真实 HTTP（500 + 健康）");
    assert.equal(out.text, "替身回复", "恢复成功 ⇒ 回答正常");
    assert.equal(out.error, "", "恢复成功 ⇒ 顶层 error 为空（不得把成本问题变成调用失败）");
    assert.equal(out.attemptsLog[0].outcome, "submitted");
    assert.match(out.attemptsLog[0].responseError ?? "", /HTTP 500/, "历史失败仍留在逐次轨迹里");
    assert.equal(out.usageSource, "partial", "★ 逐次合成：有尝试没用量 ⇒ partial（不是 reported）");
    assert.deepEqual(out.usage, { prompt_tokens: 7, completion_tokens: 11 }, "已得的 7/11 作为下界保留");
    assertDeliveryFacts(out, srv.hits());
  } finally {
    srv.stop();
  }
});
