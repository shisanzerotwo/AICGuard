/**
 * Run 元信息（M2-2）· 行为测试。
 *
 * 依据 docs/15 §2.3：每个 run 必须能回答"哪份代码 / 哪份语料 / 哪版护栏与判据 /
 * 哪个模型 / 什么采样参数 / 请求与缓存计数"，且**不得包含密钥或认证头**。
 *
 * 全部离线（不调用真实模型）。运行：node --test tests/runmeta.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CACHE_KEY_VERSION } from "../src/cache.ts";
import { JUDGE_VERSION } from "../src/judge.ts";
import { GUARD_VERSION } from "../src/guards.ts";
import { collectCodeInfo, collectRunVersions, hashCorpus, targetRuntimeInfo } from "../src/runmeta.ts";
import { buildPayload, writeMarkdown, type RunMeta } from "../src/report.ts";
import { AgroBot } from "../src/targets/agrobot.ts";
import { AgentBot, TOOL_CONTRACT_VERSION } from "../src/targets/agentbot.ts";
import { LlmBot } from "../src/targets/llmbot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = join(HERE, "..");
const DATA_DIR = join(TS_ROOT, "..", "data");

test("语料哈希：稳定、可复算，内容变则哈希变", () => {
  const a = hashCorpus(DATA_DIR);
  const b = hashCorpus(DATA_DIR);
  assert.equal(a.corpusHash, b.corpusHash, "同目录两次哈希必须一致");
  assert.ok(a.corpusFiles.length >= 8, `应覆盖全部语料文件（实际 ${a.corpusFiles.length}）`);
  assert.match(a.corpusHash, /^[0-9a-f]{64}$/);
  for (const f of a.corpusFiles) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.lines > 0, `${f.file} 行数应 > 0`);
  }

  // 内容变化必须被检出（用临时目录，不动正式语料）
  const dir = mkdtempSync(join(tmpdir(), "aicguard-corpus-"));
  try {
    writeFileSync(join(dir, "a.jsonl"), JSON.stringify({ id: "A" }) + "\n", "utf8");
    const h1 = hashCorpus(dir).corpusHash;
    writeFileSync(join(dir, "a.jsonl"), JSON.stringify({ id: "B" }) + "\n", "utf8");
    const h2 = hashCorpus(dir).corpusHash;
    assert.notEqual(h1, h2, "语料内容变 ⇒ 哈希必须变");
    // 新增文件同样要变
    writeFileSync(join(dir, "b.jsonl"), "{}\n", "utf8");
    assert.notEqual(h2, hashCorpus(dir).corpusHash, "新增语料文件 ⇒ 哈希必须变");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("代码信息：40 位 SHA 或 (unknown)，dirty 为布尔", () => {
  const info = collectCodeInfo(TS_ROOT);
  assert.ok(/^[0-9a-f]{40}$/.test(info.codeSha) || info.codeSha === "(unknown)", `codeSha=${info.codeSha}`);
  assert.equal(typeof info.codeDirty, "boolean");
});

test("护栏/判据/工具契约/缓存键版本都可取且非空", () => {
  assert.match(GUARD_VERSION, /profiles\[/);
  assert.match(GUARD_VERSION, /registry\[/);
  assert.match(JUDGE_VERSION, /^m1-/);
  assert.match(TOOL_CONTRACT_VERSION, /^v\d+/);
  assert.equal(CACHE_KEY_VERSION, 2);
});

test("靶子运行信息：登记身份与计数，且**不含密钥字段**", () => {
  const agro = targetRuntimeInfo(new AgroBot("CANARY-X", "sys"));
  assert.equal(agro.kind, "offline");

  const llm = targetRuntimeInfo(new LlmBot({
    model: "test-model", baseUrl: "HTTP://Example.COM:8080/v1/", apiKey: "sk-secret-should-not-appear",
    systemPrompt: "sys", salt: "r1", temperature: 0.3, maxTokens: 128,
  }));
  assert.equal(llm.kind, "llm");
  assert.equal(llm.model, "test-model");
  assert.equal(llm.endpoint, "http://example.com:8080/v1", "端点必须规范化");
  assert.equal(llm.temperature, 0.3);
  assert.equal(llm.maxTokens, 128);
  assert.equal(llm.salt, "r1");
  assert.equal(llm.cacheMode, "fresh");
  assert.equal(JSON.stringify(llm).includes("sk-"), false, "运行信息不得携带密钥");

  const agent = targetRuntimeInfo(new AgentBot({ mode: "mock" }));
  assert.equal(agent.kind, "offline", "mock 模式按离线记");
  assert.equal(agent.toolContractVersion, TOOL_CONTRACT_VERSION);
});

test("报告产物：携带来源字段，且全文不含任何 sk- 形式的密钥", () => {
  const versions = collectRunVersions({
    repoRoot: TS_ROOT, dataDir: DATA_DIR,
    guardVersion: GUARD_VERSION, judgeVersion: JUDGE_VERSION,
    toolContractVersion: TOOL_CONTRACT_VERSION, cacheKeyVersion: CACHE_KEY_VERSION,
  });
  const meta: RunMeta = {
    runId: "t-runmeta", startedAt: "2026-01-01T00:00:00Z", target: "AgroBot(农技问答机器人)",
    profile: "full", profileLabel: "档位 3：完整防御", guardsEnabled: ["N1-Normalizer"], threshold: 0.7,
    versions,
    runtime: { node: process.version, platform: process.platform },
    targetRuntime: targetRuntimeInfo(new AgroBot("CANARY-X", "sys")),
  };
  const metrics = {
    probeTotal: 0, benignTotal: 0, baselineBreach: 0, guardedBreach: 0,
    unclearBaseline: 0, unclearGuarded: 0, blockedAtInput: 0, blockedAtOutput: 0, benignBlocked: 0,
    avgLatencyMs: 0,
    baselineTally: { attempted: 0, decided: 0, breaches: 0, unclear: 0, callErrors: 0, budgetExhausted: 0, invalidTests: 0, coverage: null, asr: null, ci: null, zeroUpper: null },
    guardedTally: { attempted: 0, decided: 0, breaches: 0, unclear: 0, callErrors: 0, budgetExhausted: 0, invalidTests: 0, coverage: null, asr: null, ci: null, zeroUpper: null },
    benignEvaluated: 0, benignCallErrors: 0,
    baselineAsr: null, guardedAsr: null, defenseRate: null, falsePositiveRate: null,
    defensePairs: { comparable: 0, defended: 0, unknown: 0, notEligible: 0, breachWithError: 0, rate: null },
  } as never;

  const payload = buildPayload(meta, metrics, [], [], []);
  const v = payload.versions as Record<string, unknown>;
  assert.equal(v.codeSha, versions.codeSha);
  assert.equal(v.corpusHash, versions.corpusHash);
  assert.equal(v.judgeVersion, JUDGE_VERSION);
  assert.equal(v.cacheKeyVersion, CACHE_KEY_VERSION);

  const dir = mkdtempSync(join(tmpdir(), "aicguard-runmeta-"));
  try {
    const md = readFileSync(writeMarkdown(meta, metrics, [], [], [], join(dir, "r.md")), "utf8");
    assert.match(md, /来源与可复现性/, "报告必须带来源节");
    assert.ok(md.includes(versions.codeSha), "报告必须写出代码快照");
    assert.ok(md.includes(versions.corpusHash.slice(0, 16)), "报告必须写出语料哈希");
    assert.ok(md.includes(JUDGE_VERSION), "报告必须写出判据版本");
    assert.equal(/sk-[A-Za-z0-9]/.test(md), false, "报告正文不得出现密钥形态字符串");
    assert.equal(/Authorization|Bearer\s/i.test(md), false, "报告正文不得出现认证头");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
