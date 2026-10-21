/**
 * 步骤 3：桥在「HTTP 200 但拿不到可用结果」时，必须把**结构性**证据落盘（`diagnostics`），
 * 否则下游只能看到兜底串 `未知错误`（RAG 重采 7 条空响应至今不可归因，见证据 76 §22.4）。
 *
 * 三条口径：
 *   ① 200 + 空正文 ⇒ 顶层 error 非空 **且** diagnostics.httpStatus=200 / finishReason="length" / choicesLen=1 / textChars=0；
 *   ② 200 + 正常正文（阳性对照）⇒ error 为空 **且不含** diagnostics 字段（成功路径形状不变，避免下游契约误判）；
 *   ③ 连接层失败（端口无监听）⇒ diagnostics.httpStatus 为 null 且 attemptErrorKinds 含 "connection"。
 * 全程离线：替身服务器在 127.0.0.1 随机端口，凭据为假串。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const BRIDGE = resolve(TS_ROOT, "src", "targets", "llm-bridge.mjs");
const SERVER = join(HERE, "fixtures", "bridge-empty-response-server.mjs");

interface Out {
  text: string;
  error: string;
  toolCalls: unknown[];
  diagnostics?: { parsedAny: boolean; textChars: number; toolCalls: number; httpStatus: number | null; finishReason: string | null; choicesLen: number | null; attemptErrorKinds: Array<string | null> };
}

function startServer(mode: "empty" | "text", hitLog: string): Promise<{ port: number; stop: () => void }> {
  return new Promise((ready, fail) => {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, MODE: mode, HITLOG: hitLog }, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const t = setTimeout(() => fail(new Error("替身服务器启动超时")), 10000);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = /READY (\d+)/.exec(buf);
      if (m) { clearTimeout(t); ready({ port: Number(m[1]), stop: () => child.kill() }); }
    });
    child.on("error", fail);
  });
}

function runBridge(port: number): Out {
  const dir = mkdtempSync(join(tmpdir(), "empty-diag-"));
  const r = spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify({
      baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test-not-real", model: "m-diag",
      system: "系统提示", messages: [{ role: "user", content: "滴灌压力是多少？" }],
      maxTokens: 64, temperature: 0, timeoutMs: 5000,
      budget: { path: join(dir, "budget.json"), runId: "diag", source: "bridge", limit: 1 },
    }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `桥必须正常退出：${r.stderr || "(no stderr)"}`);
  return JSON.parse(r.stdout) as Out;
}

test("① 200 + 空正文 ⇒ error 非空且 diagnostics 记录 httpStatus/finishReason/choicesLen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-diag-log-"));
  const s = await startServer("empty", join(dir, "hits.log"));
  try {
    const out = runBridge(s.port);
    assert.notEqual(out.error, "", "空正文必须不是成功");
    assert.ok(out.diagnostics, "必须挂出 diagnostics");
    assert.equal(out.diagnostics!.httpStatus, 200);
    assert.equal(out.diagnostics!.finishReason, "length");
    assert.equal(out.diagnostics!.choicesLen, 1);
    assert.equal(out.diagnostics!.textChars, 0);
    assert.equal(out.diagnostics!.parsedAny, true, "JSON 是可解析的（这正是不可归因的形态）");
  } finally { s.stop(); }
});

test("② 阳性对照：正常正文 ⇒ error 为空且**不含** diagnostics（成功路径形状不变）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-diag-ok-"));
  const s = await startServer("text", join(dir, "hits.log"));
  try {
    const out = runBridge(s.port);
    assert.equal(out.error, "");
    assert.ok(out.text.length > 0);
    assert.equal("diagnostics" in out, false, "成功路径不得新增字段");
  } finally { s.stop(); }
});

test("③ 连接层失败 ⇒ diagnostics.httpStatus=null 且 attemptErrorKinds 含 connection", () => {
  // 取一个几乎不可能被监听的端口：先起再停一个服务器拿到端口号，避免依赖固定端口
  const out = runBridge(9); // 127.0.0.1:9 discard 端口，本机不可连
  assert.notEqual(out.error, "");
  assert.ok(out.diagnostics, "必须有 diagnostics");
  assert.equal(out.diagnostics!.httpStatus, null);
  assert.equal(out.diagnostics!.parsedAny, false);
  assert.ok(out.diagnostics!.attemptErrorKinds.includes("connection"),
    `应含 connection：${JSON.stringify(out.diagnostics!.attemptErrorKinds)}`);
});
