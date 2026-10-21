/**
 * RAG × 真实模型通道接线测试（M6 前置 P2 + **P3 返工**，`docs/37` §P2/§3）。
 *
 * 锁的是**接线契约**与**送达取证来源**（重新按返工后的机制写）：
 *   ① `--target llm` fresh **拒无 budget**（P1 额度护栏是硬前置）；replay **不要求** budget（不发请求）；
 *   ② 缺 baseUrl / model /（非 dry-run 的）API_KEY ⇒ 抛错，**不静默回落 offline**；
 *   ③ **`--mode` 必须显式解析并校验**（P3 返工项 2：此前只在用法里宣称支持，实际没解析）；
 *      fresh 生成采样标识并落盘，replay 默认复用上次 fresh 的盐（否则永远 miss）；
 *   ④ ★核心反例：送达证据的 `requestSha256` === sha256(**实际 HTTP 正文**)，且 ≠ sha256(sentText)，
 *      也 ≠ sha256(**IPC 包装**) —— 证明取证来自「真正发出去的那份正文」；
 *   ⑤ **dry-run 不得算送达**（一个字节都没发）；预算拒绝同样不得算送达；
 *   ⑥ 证据**不含凭据**（apiKey 真值绝不出现）。
 *
 * 全程进程内：mock/直接构造，**无 spawnSync、无网络、无真实模型**。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { deliveryOfSentText } from "../src/rag-delivery.ts";
import { makeRagTarget } from "../src/rag-target.ts";
import { LlmBot } from "../src/targets/llmbot.ts";
import type { TransportEvidence } from "../src/types.ts";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const SECRET = "sk-test-SECRET-VALUE-9f8e7d";
const BASE = { baseUrl: "https://gw.example.test/v1", model: "m-x", apiKey: SECRET };
const tmp = (): string => mkdtempSync(join(tmpdir(), "aicguard-ragtarget-"));

test("P3-① --target llm fresh 拒无 budget；replay 不要求 budget（不发请求）", () => {
  assert.throws(() => makeRagTarget({ targetKind: "llm", canary: "C", ...BASE, cacheDir: tmp() }), /--budget/);
  // replay：不发请求 ⇒ 不该因缺账本而失败
  const w = makeRagTarget({ targetKind: "llm", canary: "C", ...BASE, mode: "replay", salt: "s1", cacheDir: tmp() });
  assert.equal(w.cacheMode, "replay");
  assert.equal(w.budgetPath, undefined, "replay 不挂账本");
});

test("P3-② 缺 baseUrl / model / 非 dry-run 的 API_KEY ⇒ 抛错（不回落 offline）", () => {
  assert.throws(() => makeRagTarget({ targetKind: "llm", canary: "C", model: "m-x", apiKey: SECRET }), /baseUrl/);
  assert.throws(() => makeRagTarget({ targetKind: "llm", canary: "C", baseUrl: BASE.baseUrl, apiKey: SECRET }), /model/);
  assert.throws(
    () => makeRagTarget({ targetKind: "llm", canary: "C", baseUrl: BASE.baseUrl, model: "m-x", budgetPath: "/tmp/b.json" }),
    /API_KEY/,
  );
});

test("P3-③ --mode 显式校验；fresh 落盘采样标识、replay 默认复用（否则永远 miss）", () => {
  assert.throws(() => makeRagTarget({ targetKind: "llm", canary: "C", ...BASE, mode: "frosh", cacheDir: tmp() }), /未知 --mode/);
  const dir = tmp();
  const fresh = makeRagTarget({ targetKind: "llm", canary: "C", ...BASE, cacheDir: dir, budgetPath: join(dir, "b.json"), now: () => 0 });
  assert.equal(fresh.cacheMode, "fresh");
  assert.match(fresh.salt, /^rag-\d{14,17}$/, "fresh 必须生成自己的采样标识");
  assert.ok(existsSync(join(dir, "rag-last-salt.json")), "fresh 必须把盐落盘（否则 replay 拿不到）");

  const replay = makeRagTarget({ targetKind: "llm", canary: "C", ...BASE, mode: "replay", cacheDir: dir });
  assert.equal(replay.cacheMode, "replay");
  assert.equal(replay.salt, fresh.salt, "replay 默认复用上次 fresh 的盐");
  const explicit = makeRagTarget({ targetKind: "llm", canary: "C", ...BASE, mode: "replay", salt: "chosen", cacheDir: dir });
  assert.equal(explicit.salt, "chosen", "显式 --salt 优先");
});

test("P3-④ ★核心反例：证据哈希 = sha256(实际 HTTP 正文)，≠ sentText、≠ IPC 包装", () => {
  const sentText = "用户问题（拼装前）";
  // 实际 HTTP 正文（bridge 在 fetch 构造点序列化出来的那份，形状与真实桥一致）
  const httpBody = JSON.stringify({
    model: "m-x",
    messages: [{ role: "user", content: sentText }],
    max_tokens: 500, temperature: 0.7,
  });
  // 父进程发给 bridge 的 IPC 包装（含 baseUrl/apiKey/budget）——**不是** HTTP 正文
  const ipcWrapper = JSON.stringify({
    baseUrl: BASE.baseUrl, apiKey: SECRET, model: "m-x", messages: [{ role: "user", content: sentText }],
    maxTokens: 500, temperature: 0.7, timeoutMs: 60000, budget: { path: "/tmp/b.json", runId: "r" },
  });
  const transport: TransportEvidence = {
    state: "submitted", requestSha256: sha256(httpBody), requestBytes: httpBody.length,
    attemptId: "123-0-abc", decodedText: sentText,
  };
  const d = deliveryOfSentText({ sentText, selected: [{ docId: "docA#0" }], transport }, "PAYLOAD", "P3-④");
  assert.equal(d.requestSha256, sha256(httpBody), "取证必须来自**实际 HTTP 正文**");
  assert.notEqual(d.requestSha256, sha256(sentText), "绝不能用拼装前字符串顶替");
  assert.notEqual(d.requestSha256, sha256(ipcWrapper), "IPC 包装不是 HTTP 正文（返工要点）");
  assert.equal(d.transportState, "submitted");
});

test("P3-⑤ dry-run / 预算拒绝：载荷存在也不得算送达", () => {
  const sentText = "含攻击正文 PAYLOAD 的请求";
  for (const state of ["dry-run", "refused"] as const) {
    const transport: TransportEvidence = {
      state, requestSha256: "", requestBytes: 0, attemptId: "", decodedText: sentText,
    };
    const d = deliveryOfSentText({ sentText, selected: [], transport }, "PAYLOAD", `P3-⑤-${state}`);
    assert.equal(d.delivered, false, `${state} 绝不算送达`);
    assert.equal(d.requestSha256, "", `${state} 时不存在请求正文哈希`);
    assert.ok(d.notes.some((n) => n.includes("不得算送达")), "必须给出原因（人话）");
  }
});

test("P3-⑥ dry-run 的证据：有解码文本（可验接线）但不含凭据、describe 报 dryRun", () => {
  const dir = tmp();
  const w = makeRagTarget({
    targetKind: "llm", canary: "C",
    baseUrl: BASE.baseUrl, model: "m-x", apiKey: SECRET, dryRun: true, cacheDir: dir,
  });
  assert.equal(w.dryRun, true);
  const resp = w.target.respond("你好，世界");
  assert.match(resp.error ?? "", /dry-run/);
  assert.equal(resp.text, "");
  assert.equal(resp.transport?.state, "dry-run");
  assert.equal(resp.transport?.decodedText.includes("你好，世界"), true, "dry-run 也要能验接线（给出本会发送的文本）");
  assert.ok(!JSON.stringify(resp).includes(SECRET), "证据/响应里绝不含 apiKey 真值");
  assert.equal(w.target.describe?.().dryRun, true);
});

test("P3-⑦ fresh 真实发送必须有账本：LlmBot 缺 budget ⇒ 发送前拒绝（不 spawn）", () => {
  const bot = new LlmBot({ model: "m-x", baseUrl: BASE.baseUrl, apiKey: SECRET, systemPrompt: "", cacheDir: "" });
  const resp = bot.respond("ping");
  assert.equal(resp.budgetExhausted, true);
  assert.match(resp.error ?? "", /^budget_missing/);
  assert.equal(resp.transport?.state, "refused");
  assert.equal(bot.requests, 0, "缺账本时**一次都不许 spawn**");
  assert.equal(bot.httpAttempts, 0);
});

test("P3-⑧ replay 缺缓存 ⇒ 不发送、不碰账本（额度用完也能读缓存）", () => {
  const dir = tmp();
  const budgetPath = join(dir, "budget.json");   // 故意不存在：一旦被触碰就会露馅
  const bot = new LlmBot({
    model: "m-x", baseUrl: BASE.baseUrl, apiKey: SECRET, systemPrompt: "",
    cacheDir: dir, cacheMode: "replay",
    budget: { path: budgetPath, runId: "r", limit: 1 },
  });
  const resp = bot.respond("cache miss 的请求");
  assert.match(resp.error ?? "", /缓存|replay/i, "replay miss 必须显式失败");
  assert.equal(resp.text, "");
  assert.ok(!existsSync(budgetPath), "replay 路径不得触碰账本（不扣额度）");
  assert.equal(bot.requests, 0, "replay miss 不得发请求");
});
