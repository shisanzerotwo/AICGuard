/**
 * 缓存身份与 fresh/replay 模式（M2-1）· 行为测试。
 *
 * 对应审查 R3（缓存键缺模型/端点 ⇒ 换模型仍串用旧回答）与 docs/15 §2.3：
 *   - 相同身份（salt/模型/端点/系统提示/采样参数/消息/工具契约全同）⇒ 允许重放（缓存命中、不联网）；
 *   - 任一身份项变化 ⇒ 必须隔离（replay 模式下表现为"缓存缺失、失败"，而不是偷偷联网）；
 *   - replay 模式**只读缓存**：缺失时返回失败，绝不发网络请求；
 *   - 旧 v1 条目（键格式不同）不会被 v2 键命中，但文件保留在磁盘上。
 *
 * 全部离线：用 AICGUARD_BRIDGE 指向计数据数的替身桥，替身桥不发网络。
 * 运行：node --test tests/cache-identity.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CACHE_KEY_VERSION, cacheKey, normalizeEndpoint, replayMissError } from "../src/cache.ts";

/** 替身桥：每次被调用就向 COUNTER_FILE 追加一行（用来证明"有没有真的发请求"） */
const STUB_BRIDGE = `
import { appendFileSync, readFileSync } from "node:fs";
readFileSync(0, "utf8");
appendFileSync(process.env.COUNTER_FILE, "1\\n");
process.stdout.write(JSON.stringify({ text: "替身桥回复", usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: [] }));
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-cache-"));
  writeFileSync(join(dir, "stub-bridge.mjs"), STUB_BRIDGE, "utf8");
  const prev = {
    bridge: process.env.AICGUARD_BRIDGE,
    counter: process.env.COUNTER_FILE,
  };
  process.env.AICGUARD_BRIDGE = join(dir, "stub-bridge.mjs");
  process.env.COUNTER_FILE = join(dir, "calls.log");
  const calls = () => {
    try { return readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).length; }
    catch { return 0; }
  };
  const restore = () => {
    if (prev.bridge === undefined) delete process.env.AICGUARD_BRIDGE; else process.env.AICGUARD_BRIDGE = prev.bridge;
    if (prev.counter === undefined) delete process.env.COUNTER_FILE; else process.env.COUNTER_FILE = prev.counter;
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, calls, restore };
}

const baseOptions = (dir: string, patch: Record<string, unknown> = {}) => ({
  model: "test-model",
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "sk-test-not-a-real-key",
  systemPrompt: "系统提示",
  cacheDir: join(dir, "cache"),
  salt: "r1",
  // P3 返工：fresh 真实发送**必须**挂额度账本（缺则发送前拒绝）。本文件只关心缓存身份，
  // 故给一个隔离账本（替身桥不记账 ⇒ 文件是否存在都不影响本文件断言）。
  budget: { path: join(dir, "budget.json"), runId: "cache-identity", limit: 100 },
  ...patch,
});

test("相同身份：fresh 打一次请求，随后 replay 必须命中缓存且不再发请求", async () => {
  const { dir, calls, restore } = setup();
  try {
    const { LlmBot } = await import("../src/targets/llmbot.ts");
    const fresh = new LlmBot(baseOptions(dir) as never);
    assert.equal(fresh.respond("你好").error ?? "", "");
    assert.equal(calls(), 1, "fresh 模式应真的调用桥一次");

    const replay = new LlmBot(baseOptions(dir, { cacheMode: "replay" }) as never);
    const r = replay.respond("你好");
    assert.equal(r.error ?? "", "", "相同身份在 replay 下应命中缓存");
    assert.equal(r.text, "替身桥回复");
    assert.equal(calls(), 1, "命中缓存不得再发请求");
    assert.equal(replay.cacheHits, 1);
  } finally { restore(); }
});

test("身份隔离：模型 / 端点 / 系统提示 / 采样参数 / 消息 / salt 任一变 ⇒ replay 一律缺缓存且不联网", async () => {
  const { dir, calls, restore } = setup();
  try {
    const { LlmBot } = await import("../src/targets/llmbot.ts");
    new LlmBot(baseOptions(dir) as never).respond("你好");
    assert.equal(calls(), 1);

    const variants: Array<[string, Record<string, unknown>]> = [
      ["模型", { model: "other-model" }],
      ["端点", { baseUrl: "http://127.0.0.1:9/other" }],
      ["系统提示", { systemPrompt: "另一个系统提示" }],
      ["采样参数", { temperature: 0.1 }],
      ["消息", {}],   // 用不同 prompt 触发
      ["salt", { salt: "r2" }],
    ];
    for (const [label, patch] of variants) {
      const bot = new LlmBot(baseOptions(dir, { cacheMode: "replay", ...patch }) as never);
      const prompt = label === "消息" ? "不同的消息" : "你好";
      const r = bot.respond(prompt);
      assert.match(r.error ?? "", /replay 模式缓存缺失/, `${label}变化后必须隔离（实际 error=${JSON.stringify(r.error)}）`);
    }
    assert.equal(calls(), 1, "replay 全程不得发任何请求");
  } finally { restore(); }
});

test("replay 缺缓存时绝不联网：没有替身桥也返回失败而不是抛错/发请求", async () => {
  const { dir, calls, restore } = setup();
  try {
    delete process.env.AICGUARD_BRIDGE;   // 故意指向真实桥路径（缺失缓存时不该走到它）
    const { LlmBot } = await import("../src/targets/llmbot.ts");
    const bot = new LlmBot(baseOptions(dir, { cacheMode: "replay" }) as never);
    const r = bot.respond("你好");
    assert.match(r.error ?? "", /replay 模式缓存缺失/);
    assert.equal(r.text, "");
    assert.equal(calls(), 0);
    assert.equal(bot.requests, 0, "replay 不得计入 API 请求数");
  } finally { restore(); }
});

test("旧 v1 条目不被 v2 键命中，但文件保留在磁盘上（legacy 不删除）", async () => {
  const { dir, calls, restore } = setup();
  try {
    const { LlmBot } = await import("../src/targets/llmbot.ts");
    const cacheDir = join(dir, "cache");
    // 伪造一个 v1 时代的缓存文件（键形状与 v2 不同；内容故意是"旧回答"）
    const { mkdirSync } = await import("node:fs");
    mkdirSync(cacheDir, { recursive: true });
    const legacyKey = "0123456789abcdef0123456789abcdef01234567";
    writeFileSync(join(cacheDir, `${legacyKey}.json`), JSON.stringify({ text: "旧回答", latencyMs: 1 }), "utf8");

    const bot = new LlmBot(baseOptions(dir, { cacheMode: "replay" }) as never);
    const r = bot.respond("你好");
    assert.match(r.error ?? "", /replay 模式缓存缺失/, "v1 条目不得被 v2 键复用");
    assert.ok(readdirSync(cacheDir).includes(`${legacyKey}.json`), "旧文件必须保留");
    assert.equal(calls(), 0);
  } finally { restore(); }
});

test("缓存身份单元：normalizeEndpoint 归一化 + cacheKey 覆盖全部输入项", () => {
  assert.equal(normalizeEndpoint("HTTP://Example.COM:8080/v1/"), "http://example.com:8080/v1");
  assert.equal(CACHE_KEY_VERSION, 2);

  const base = {
    salt: "s", model: "m", endpoint: "http://a/v1", systemPrompt: "sys",
    messages: [{ role: "user", content: "hi" }], temperature: 0.7, maxTokens: 500,
  };
  const k0 = cacheKey(base);
  assert.equal(cacheKey(base), k0, "同身份必须得到同键");
  const diffs: Array<[string, Record<string, unknown>]> = [
    ["salt", { salt: "s2" }], ["model", { model: "m2" }],
    ["endpoint", { endpoint: "http://b/v1" }], ["system", { systemPrompt: "sys2" }],
    ["messages", { messages: [{ role: "user", content: "hi2" }] }],
    ["temperature", { temperature: 0.2 }], ["maxTokens", { maxTokens: 100 }],
    ["toolContract", { toolContract: "v1" }],
  ];
  for (const [label, patch] of diffs) {
    assert.notEqual(cacheKey({ ...base, ...patch }), k0, `${label} 变化必须改变缓存键`);
  }
  // 端点的大小写/尾斜杠差异不应产生新键（同一端点）
  assert.equal(cacheKey({ ...base, endpoint: "HTTP://A/v1/" }), k0, "同一端点应归一化到同一键");
});

test("replayMissError 文案点名原因（供报告与审计读）", () => {
  assert.match(replayMissError("abcdef0123"), /replay 模式缓存缺失/);
  assert.match(replayMissError("abcdef0123"), /不得联网/);
});
