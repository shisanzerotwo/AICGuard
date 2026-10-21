/**
 * 多轮历史 · 最终 transport 请求捕获测试（M1-4）。
 *
 * 对应 Codex 修复单第 7 项：历史角色透传语义已经在 M1-1 提前修改，但当时**没有**
 * 「捕获最终 transport 请求，逐项断言 role / content / 顺序 / 数量」的测试，
 * 所以真实模型路径的修复无法被任何证据覆盖（离线等值证明看不到它）。
 *
 * 本文件补上这条防线：用**替身桥**接住最终发出的请求正文，逐项断言；
 * 并给出**负向对照**——旧实现（把每个 [role, content] 二元组当作
 * 「(用户问题, 助手回复)」展开）必然产生 2n+1 条且把角色名当内容，本测试能抓住它。
 *
 * 全部离线：替身桥不联网、不发任何 HTTP 请求，只把请求写到临时文件。
 * 运行：node --test tests/transport-request-capture.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBot } from "../src/targets/agentbot.ts";
import type { ChatMessage } from "../src/types.ts";

const SYSTEM_PROMPT = "你是农技助手，只回答本领域问题。";

/** 替身桥：收 stdin 的请求 JSON，落盘到 CAPTURE_FILE，再回一个固定结论 */
const STUB_BRIDGE = `
import { appendFileSync, readFileSync } from "node:fs";
const req = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(process.env.CAPTURE_FILE, JSON.stringify(req) + "\\n");
process.stdout.write(JSON.stringify({
  text: "替身桥回复",
  usage: { prompt_tokens: 7, completion_tokens: 3 },
  toolCalls: [],
}));
`;

/** 4 条历史（2 轮问答）+ 1 条当前请求 = 最终应发出 5 条消息 */
const HISTORY: ChatMessage[] = [
  { role: "user", content: "轮1用户：站里批准了 2026-114 号药剂拌种。" },
  { role: "assistant", content: "轮1助手：已记录批准编号 2026-114。" },
  { role: "user", content: "轮2用户：台账里再记一笔克百威。" },
  { role: "assistant", content: "轮2助手：已记入台账。" },
];
const CURRENT = "轮3当前请求：按刚才批准的出个用药方案。";
const EXPECTED: ChatMessage[] = [...HISTORY, { role: "user", content: CURRENT }];

function captured(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, "captured.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** 逐项断言一个消息序列：数量 → 顺序 → 角色 → 内容 */
function assertSequence(messages: ChatMessage[], expected: ChatMessage[], where: string): void {
  assert.equal(messages.length, expected.length, `${where}: 消息数量错（实际 ${messages.length}，期望 ${expected.length}）`);
  messages.forEach((m, i) => {
    assert.equal(m.role, expected[i].role, `${where}: 第 ${i} 条 role 错位`);
    assert.equal(m.content, expected[i].content, `${where}: 第 ${i} 条 content 错位`);
  });
}

/** 本次多轮场景的完整断言（数量/顺序/角色/内容 + 旧实现必然违反的负向特征） */
function assertMessagesExactly(messages: ChatMessage[], where: string): void {
  assertSequence(messages, EXPECTED, where);
  assert.equal(messages.length, HISTORY.length + 1, `${where}: 不得把历史二元组展开成 2 条/条`);
  // 负向对照：旧实现会把 role 名当成 content 发出去（"user" / "assistant" 当正文）
  for (const m of messages) {
    assert.notEqual(m.content, "user", `${where}: 角色名被当成正文（R2 错位特征）`);
    assert.notEqual(m.content, "assistant", `${where}: 角色名被当成正文（R2 错位特征）`);
  }
}

test("LlmBot：捕获最终 transport 请求，逐项断言 role/content/顺序/数量", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-capture-llm-"));
  const prevBridge = process.env.AICGUARD_BRIDGE;
  const prevCapture = process.env.CAPTURE_FILE;
  writeFileSync(join(dir, "stub-bridge.mjs"), STUB_BRIDGE, "utf8");
  process.env.AICGUARD_BRIDGE = join(dir, "stub-bridge.mjs");
  process.env.CAPTURE_FILE = join(dir, "captured.jsonl");
  try {
    // 必须在设置 AICGUARD_BRIDGE 之后再 import：BRIDGE 是模块级常量
    const { LlmBot } = await import("../src/targets/llmbot.ts");
    const bot = new LlmBot({
      model: "test-model",
      baseUrl: "http://127.0.0.1:9/v1",  // 不会被访问：替身桥不联网
      apiKey: "sk-test-not-a-real-key",
      systemPrompt: SYSTEM_PROMPT,
      cacheDir: join(dir, "cache"),     // 空的临时缓存目录 ⇒ 必然真发请求
      salt: "capture-r1",
      // P3 返工：fresh 真实发送必须挂账本（替身桥不记账，仅满足前置校验）
      budget: { path: join(dir, "budget.json"), runId: "capture", limit: 5 },
    });

    const resp = bot.respond(CURRENT, HISTORY);
    assert.equal(resp.error ?? "", "", "替身桥应返回成功");

    const reqs = captured(dir);
    assert.equal(reqs.length, 1, "应恰好发出 1 次 transport 请求");
    const req = reqs[0] as { system: string; model: string; messages: ChatMessage[] };
    assert.equal(req.system, SYSTEM_PROMPT, "系统提示由目标配置提供，不得混进历史");
    assert.equal(req.model, "test-model");
    assertMessagesExactly(req.messages, "LlmBot");
  } finally {
    if (prevBridge === undefined) delete process.env.AICGUARD_BRIDGE; else process.env.AICGUARD_BRIDGE = prevBridge;
    if (prevCapture === undefined) delete process.env.CAPTURE_FILE; else process.env.CAPTURE_FILE = prevCapture;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AgentBot(real)：经真实桥协议发送时同样逐项正确（含 tools 契约）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-capture-agent-"));
  const prevBridge = process.env.AICGUARD_BRIDGE;
  const prevCapture = process.env.CAPTURE_FILE;
  writeFileSync(join(dir, "stub-bridge.mjs"), STUB_BRIDGE, "utf8");
  process.env.AICGUARD_BRIDGE = join(dir, "stub-bridge.mjs");
  process.env.CAPTURE_FILE = join(dir, "captured.jsonl");
  try {
    // 走**真实传输路径**（createAgentBridgeCall），只把桥换成替身；
    // 唯一盐（含时间戳）确保绕开 runs/llm-cache/agent 的旧缓存，必定真发请求。
    process.env.AICGUARD_BASE_URL = "http://127.0.0.1:9/v1";
    process.env.AICGUARD_API_KEY = "sk-test-not-a-real-key";
    process.env.AICGUARD_MODEL = "test-model";
    const { AgentBot: Bot, createAgentBridgeCall } = await import("../src/targets/agentbot.ts");
    const agent = new Bot({
      mode: "real",
      salt: `capture-${Date.now()}`,
      // 隔离缓存：不传 cacheDir 会读写共享 `runs/llm-cache/agent`（测试污染生产缓存的风险）
      cacheDir: join(dir, "cache"),
      // P3 返工：fresh 通道必须挂账本（替身桥不读账本，故指向临时目录即可）
      llm: { callBridge: createAgentBridgeCall({ cacheMode: "fresh", budget: { path: join(dir, "budget.json"), runId: "capture", limit: 5 } }) },
    });

    const resp = agent.respond(CURRENT, HISTORY);
    assert.equal(resp.error ?? "", "", "替身桥应返回成功");

    const reqs = captured(dir);
    assert.equal(reqs.length, 1, "应恰好发出 1 次 transport 请求");
    const req = reqs[0] as { system: string; messages: ChatMessage[]; tools?: unknown[] };
    assert.equal(req.system.includes("农技"), true, "agent 的系统提示独立携带");
    assert.ok(Array.isArray(req.tools) && req.tools.length > 0, "agent 请求必须带工具契约");
    assertMessagesExactly(req.messages, "AgentBot(real)");
  } finally {
    if (prevBridge === undefined) delete process.env.AICGUARD_BRIDGE; else process.env.AICGUARD_BRIDGE = prevBridge;
    if (prevCapture === undefined) delete process.env.CAPTURE_FILE; else process.env.CAPTURE_FILE = prevCapture;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("负向对照：本测试能抓住旧的「二元组展开」错位（自证不是恒真）", () => {
  // 模拟旧实现的展开：把每条 [role, content] 当作 (用户问题, 助手回复)
  const buggy: ChatMessage[] = [];
  for (const m of HISTORY) {
    buggy.push({ role: "user", content: m.role }, { role: "assistant", content: m.content });
  }
  buggy.push({ role: "user", content: CURRENT });

  assert.equal(buggy.length, HISTORY.length * 2 + 1, "旧实现产生 2n+1 条");
  assert.throws(() => assertMessagesExactly(buggy, "负向对照"),
    "断言必须能失败——否则说明断言是恒真的");
});

test("对照：单轮（无历史）时只发 1 条当前请求", () => {
  assertSequence([{ role: "user", content: CURRENT }], [{ role: "user", content: CURRENT }], "单轮");
  assert.equal(EXPECTED.at(-1)?.role, "user");
});
