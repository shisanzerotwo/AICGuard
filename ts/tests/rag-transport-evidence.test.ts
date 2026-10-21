/**
 * 送达证据来自**实际 HTTP 正文**的端到端验收（P3 返工项 3）。
 *
 * 为什么必须用「本地 transport 替身」：只有真的发一次 HTTP，才能证明
 *   ① 桥在 `fetch` 构造点算出的 `requestSha256` 与**服务端实际收到的那份正文**逐字相同；
 *   ② 它不是 IPC 包装（父进程发给桥的那份含 baseUrl/apiKey/budget/timeoutMs）；
 *   ③ dry-run / 预算拒绝 / 无账本 时**一个字节都不会发出**（不得算送达）；
 *   ④ 缓存重放的证据被**显式标注**来自历史请求。
 *
 * 全程离线：服务器跑在 127.0.0.1 的随机端口，凭据是假串；**不访问任何外部网络**。
 * 服务器必须跑在**独立子进程**里（桥是 spawnSync 调起来的，阻塞父进程的事件循环）。
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureLedger, peekLedger, reserveAttempts } from "../src/budget.ts";
import { LlmBot } from "../src/targets/llmbot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const SERVER = join(HERE, "fixtures", "capture-http-server.mjs");
const BRIDGE = resolve(TS_ROOT, "src", "targets", "llm-bridge.mjs");
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const SECRET = "sk-test-SECRET-VALUE-transport";

interface Captured { method: string; url: string; headerNames: string[]; hasAuthorization: boolean; body: string }

/** 起替身服务器（独立子进程），返回端口与读取函数 */
async function startCapture(dir: string, script: string = SERVER): Promise<{ port: number; bodies: () => Captured[]; stop: () => void }> {
  const file = join(dir, "bodies.jsonl");
  const child = spawn(process.execPath, [script, file], { stdio: ["ignore", "pipe", "inherit"] });
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
    bodies: () => (existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Captured)
      : []),
    stop: () => child.kill(),
  };
}

function botFor(dir: string, port: number, opts: { cacheMode?: "fresh" | "replay"; salt?: string; budgetPath?: string; limit?: number } = {}): LlmBot {
  const cacheDir = join(dir, "cache");
  return new LlmBot({
    model: "m-capture", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, systemPrompt: "系统提示（SYS）",
    cacheDir, cacheMode: opts.cacheMode ?? "fresh", salt: opts.salt ?? "s-cap",
    ...(opts.budgetPath ? { budget: { path: opts.budgetPath, runId: "cap", ...(opts.limit !== undefined ? { limit: opts.limit } : {}) } } : {}),
  });
}

test("P3-⑬ ★验收：requestSha256 === sha256(服务端实际收到的正文)，且正文不是 IPC 包装", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-transport-"));
  const srv = await startCapture(dir);
  const budget = join(dir, "budget.json");
  try {
    const bot = botFor(dir, srv.port, { budgetPath: budget, limit: 5 });
    const resp = bot.respond("请只依据文档回答：滴灌压力是多少？");
    assert.equal(resp.error ?? "", "", "替身服务器应返回成功");
    const got = srv.bodies();
    assert.equal(got.length, 1, "应恰好发出 1 次 HTTP");
    // ★ 核心：桥报回的哈希 = 服务端实际收到的那份正文的哈希（逐字）
    assert.equal(resp.transport?.state, "submitted");
    assert.equal(resp.transport?.requestSha256, sha256(got[0].body), "哈希必须来自实际 HTTP 正文");
    assert.equal(resp.transport?.requestBytes, Buffer.byteLength(got[0].body, "utf8"));
    // 正文形状：HTTP payload（不是 IPC 包装 —— IPC 才有 baseUrl/apiKey/budget/timeoutMs）
    const body = JSON.parse(got[0].body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "temperature"],
      "HTTP 正文只应含模型请求字段：不得把 IPC 包装字段（baseUrl/apiKey/budget/timeoutMs）发出去");
    assert.ok(!got[0].body.includes(SECRET), "正文里不得出现 apiKey 真值（key 只走 header）");
    assert.equal(got[0].hasAuthorization, true, "凭据应走认证头（而不是塞进正文）");
    // 证据里也不得出现凭据（红线）
    assert.ok(!JSON.stringify(resp).includes(SECRET), "返回的证据/响应不得含凭据");
    // 解码文本可用于保留范围测量：攻击正文在**解码文本**里应能找到
    assert.ok(resp.transport?.decodedText.includes("滴灌压力是多少"), "解码文本应含实际发送的内容");
    // 账本口径：一次 attempt ⇒ used=1（与 httpAttempts 对账）
    assert.equal(bot.httpAttempts, 1);
    // 6) 计数与**隔离账本**对账（P3 项 6）：used 必须等于桥回报的底层 HTTP 尝试数
    const view = peekLedger(budget);
    assert.equal(view?.used, 1, "账本 used 应为 1（底层 HTTP 尝试口径）");
    assert.equal(view?.used, bot.httpAttempts, "账本与观测到的 HTTP 尝试必须能对上");
  } finally {
    srv.stop();
  }
});

test("P3-⑭ 发送前拒绝（预算耗尽 / 无账本）⇒ 服务端一个字节都收不到，且不算送达", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-transport2-"));
  const srv = await startCapture(dir);
  try {
    // ① 预算用满 ⇒ 第二次发送前被拦
    const budget = join(dir, "budget.json");
    ensureLedger(budget, { runId: "cap", limit: 1 });
    reserveAttempts(budget, 1, "test");
    const bot = botFor(dir, srv.port, { budgetPath: budget, limit: 1 });
    const resp = bot.respond("第二次请求应被拦");
    assert.equal(resp.budgetExhausted, true);
    assert.equal(resp.transport?.state, "refused", "预算拒绝 ⇒ refused（不是 not-connecting）");
    assert.equal(resp.transport?.requestSha256, "", "没发出去就没有正文哈希");
    assert.equal(srv.bodies().length, 0, "★服务端必须一个字节都收不到");
    assert.equal(bot.httpAttempts, 0, "发送前拒绝不得计为 HTTP 请求");

    // ② 桥未收到账本 ⇒ 桥自身也拒绝（兜底：任何调用方都绕不过）
    const r = spawnSync(process.execPath, [BRIDGE], {
      input: JSON.stringify({ baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: SECRET, model: "m-capture", system: "", messages: [{ role: "user", content: "hi" }] }),
      encoding: "utf8",
    });
    const out = JSON.parse(r.stdout) as { budgetStop?: string; request?: { state?: string } };
    assert.equal(out.budgetStop, "missing", "无账本时桥必须拒绝发送（budget_missing）");
    assert.equal(out.request?.state, "refused");
    assert.equal(srv.bodies().length, 0, "桥兜底拒绝时也不得发出任何请求");
  } finally {
    srv.stop();
  }
});

test("P3-⑮ 缓存重放：证据标为历史请求，且与首次发送的哈希一致（本次零发送）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-transport3-"));
  const srv = await startCapture(dir);
  const budget = join(dir, "budget.json");
  try {
    const fresh = botFor(dir, srv.port, { budgetPath: budget, limit: 5, salt: "s-replay" });
    const r1 = fresh.respond("同一身份的问题");
    const h1 = r1.transport?.requestSha256;
    assert.equal(srv.bodies().length, 1);
    assert.equal(fresh.httpAttempts, 1);

    // replay（只读缓存）：不得再发请求；证据来自历史请求且显式标注
    const replay = botFor(dir, srv.port, { cacheMode: "replay", salt: "s-replay" });
    const r2 = replay.respond("同一身份的问题");
    assert.equal(r2.text, r1.text, "缓存命中应返回同样的回答");
    assert.equal(srv.bodies().length, 1, "replay 不得再发 HTTP");
    assert.equal(replay.requests, 0, "缓存命中不计桥调用");
    assert.equal(replay.httpAttempts, 0);
    assert.equal(r2.transport?.state, "cache-replay", "证据必须标明来自历史请求");
    assert.equal(r2.transport?.fromCache, true);
    assert.equal(r2.transport?.requestSha256, h1, "历史哈希原样带出（可复算）");
  } finally {
    srv.stop();
  }
});

test("P3-⑯ 超时（提交后状态未知）：不得推断模型已处理，也不得当成未送达=防住了", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-transport4-"));
  const srv = await startCapture(dir);
  const budget = join(dir, "budget.json");
  try {
    // timeoutMs 极小 ⇒ 桥侧 AbortError ⇒ unknown-after-submit（正文可能已到服务端）
    const bot = new LlmBot({
      model: "m-capture", baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: SECRET, systemPrompt: "",
      cacheDir: "", salt: "s-timeout", timeoutMs: 1,
      // limit=1：第 1 次尝试超时后，重试会在**发送前**被预算拦下（省掉 2s+5s 退避，同时验证状态不被降级）
      budget: { path: budget, runId: "cap", limit: 1 },
    });
    const resp = bot.respond("会超时的请求");
    assert.equal(resp.transport?.state, "unknown-after-submit", "超时必须记“提交后状态未知”");
    assert.ok((resp.error ?? "").length > 0, "超时必须带错误信息（不得静默）");
    assert.ok(bot.httpAttempts >= 1, "超时也算一次 HTTP 尝试（账本口径）");
    // 状态只升级：第 2 次尝试是被预算拒绝的，但不得把“提交后状态未知”降级成“没发出去”
    assert.notEqual(resp.transport?.state, "refused", "预算拒绝不得覆写更早那次已提交（状态未知）的事实");
  } finally {
    srv.stop();
  }
});
test("P3-⑰ ★反例（Codex 5）：首次 500、之后连接失败 ⇒ 三元组必须来自**同一次尝试**（且逐次留痕）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-flaky-"));
  const srv = await startCapture(dir, join(HERE, "fixtures", "flaky-http-server.mjs"));
  const budget = join(dir, "budget.json");
  try {
    // limit=2：第 0 次（500）与第 1 次（断连）各占 1 次；第 2 次重试会在**发送前**被预算拦下（顺便省掉 5s 退避）
    const bot = new LlmBot({
      model: "m-flaky", baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: SECRET, systemPrompt: "sys",
      cacheDir: "", salt: "s-flaky", timeoutMs: 3000,
      budget: { path: budget, runId: "flaky", limit: 2 },
    });
    const resp = bot.respond("先 500 再断连的请求");
    const t = resp.transport;
    assert.ok(t, "必须有 transport 证据");
    // ① 状态取"最强的那条"：第 0 次拿到了 HTTP 响应 ⇒ submitted（不得因后续断连降级）
    assert.equal(t?.state, "submitted", "先 500 后断连 ⇒ 状态仍是 submitted（不降级）");
    // ② 逐次留痕：两次尝试各自的 outcome 都在
    const attempts = t?.attempts ?? [];
    assert.ok(attempts.length >= 2, `应逐次记录（至少 2 条），实际 ${attempts.length}`);
    assert.equal(attempts[0].outcome, "submitted", "第 0 次拿到了 500 ⇒ submitted");
    assert.ok(attempts.slice(1).every((a) => a.outcome === "not-connecting" || a.outcome === "refused"),
      "后续尝试应为 not-connecting（连接失败）；若已被预算拦下则为 refused");
    // ③ ★同源：顶层三元组必须与"那条 submitted 记录"逐字段一致（不能是后来那次覆写的结果）
    const submitted = attempts.find((a) => a.outcome === "submitted")!;
    assert.equal(t?.attemptId, submitted.attemptId, "attemptId 必须来自 submitted 的那一次");
    assert.equal(t?.requestSha256, submitted.requestSha256, "哈希必须来自 submitted 的那一次");
    assert.equal(t?.requestBytes, submitted.requestBytes);
    assert.ok(t?.attemptId.endsWith("-0-" + submitted.requestSha256.slice(0, 12)),
      `attemptId 应指回第 0 次尝试：${t?.attemptId}`);
  } finally {
    srv.stop();
  }
});
