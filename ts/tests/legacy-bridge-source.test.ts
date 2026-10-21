/**
 * F4 / P2：**旧协议兼容的来源推断**不得从"字段缺失"或"适配器补的 0/0"凭空造出成本来源。
 * （Codex 复核 `codex-review-c5c2171` 的 F4；处理范围见证据 72 §12.4。）
 *
 * 修前实测（复核者 `fallback-results.json` / `fallback-workloop-results.json`）：
 *   ① `(out.attempts ?? 0) === 0` 把**缺字段**当成"明确 0 次尝试" ⇒ 实际已发出请求却被判 `none`；
 *   ② 适配器把缺失的供应商 usage 补成 `{0,0}`，"`out.usage` 对象存在"又被当成 `reported` 的依据
 *      ⇒ Work Loop 把占位 0 当**完整零成本**，再次输出"6/6 条未达 5× 阈值"。
 *
 * 本测试用**真实 HTTP**（本机替身服务器 + 项目 `reserveAttempts` 占临时额度）复现：服务器自己记录请求数、
 * 账本 used 与请求数对账 ⇒ "缺字段"不能再冒充"没发出去"。全程离线，账本/缓存均隔离。
 *
 * 来源口径（与 `resolveUsageSource` 的实现一一对应）：
 *   `none` 只来自**明确未发送证据**（原始 `attempts` 字段存在且为 0；或送达状态明确 refused/dry-run）；
 *   `reported` 需要"发出过 1 次且这次有合法用量"；次数 ≥2 或**无法确定次数**时只拿到一份用量 ⇒ `partial`（下界）；
 *   发出过但没拿到合法用量 ⇒ `unknown`；既不能证明发出也不能证明没发出 ⇒ `unknown`。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentBot, createAgentBridgeCall } from "../src/targets/agentbot.ts";
import { buildProfile } from "../src/guards.ts";
import { CANARY } from "../src/config.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const SHIM = join(HERE, "fixtures", "legacy-bridge-shim.mjs");
const SERVER = join(HERE, "fixtures", "legacy-usage-server.mjs");
const BUDGET_URL = pathToFileURL(join(TS_ROOT, "src", "budget.ts")).href;

async function startServer(dir: string, noUsageHits = ""): Promise<{ port: number; hits: () => number; stop: () => void }> {
  const file = join(dir, "hits.log");
  const child = spawn(process.execPath, [SERVER, file, noUsageHits], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
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

/** 一个 mode 一条链路：旧协议 shim → AgentBot → Pipeline（与复核者探针同路径） */
function runLegacy(dir: string, port: number, mode: string): {
  source: string | undefined; usage: { promptTokens: number; completionTokens: number } | undefined;
  targetError: string; finalText: string; used: number | null;
} {
  const budgetPath = join(dir, `budget-${mode}.json`);
  const prev = { bridge: process.env.AICGUARD_BRIDGE, mode: process.env.LEGACY_MODE, budgetMod: process.env.LEGACY_BUDGET_MODULE,
    url: process.env.AICGUARD_BASE_URL, key: process.env.AICGUARD_API_KEY, model: process.env.AICGUARD_MODEL };
  try {
    process.env.AICGUARD_BRIDGE = SHIM;
    process.env.LEGACY_MODE = mode;
    process.env.LEGACY_BUDGET_MODULE = BUDGET_URL;
    process.env.AICGUARD_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.AICGUARD_API_KEY = "sk-test-not-real";
    process.env.AICGUARD_MODEL = `m-f4-${process.pid}`;
    const bot = new AgentBot({
      mode: "real", cacheDir: join(dir, `cache-${mode}`),
      llm: { callBridge: createAgentBridgeCall({ cacheMode: "fresh", budget: { path: budgetPath, runId: mode, limit: 5 } }) },
    });
    const line = buildProfile("none", CANARY, 0.70).run("legacy bridge evidence boundary", bot);
    const ledger = existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, "utf8")) as { used: number } : null;
    return { source: line.usageSource, usage: line.usage, targetError: line.targetError, finalText: line.finalText, used: ledger?.used ?? null };
  } finally {
    for (const [k, v] of Object.entries({
      AICGUARD_BRIDGE: prev.bridge, LEGACY_MODE: prev.mode, LEGACY_BUDGET_MODULE: prev.budgetMod,
      AICGUARD_BASE_URL: prev.url, AICGUARD_API_KEY: prev.key, AICGUARD_MODEL: prev.model,
    })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("F4-① 阳性对照：显式 attempts=0 + refused（0 次 HTTP）⇒ none（确认零）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-f4-refusal-"));
  const srv = await startServer(dir);
  try {
    const r = runLegacy(dir, srv.port, "refusal");
    assert.equal(srv.hits(), 0, "确认零：一个字节都没发出去");
    assert.equal(r.source, "none", "有明确未发送证据 ⇒ none");
    assert.equal(r.used, null, "发送前拒绝不产生任何额度占用");
  } finally { srv.stop(); }
});

test("F4-② ★反例：旧桥发过 HTTP(1 次)但缺 attempts/transport ⇒ 不得判 none；用量作为下界保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-f4-known-"));
  const srv = await startServer(dir);
  try {
    const r = runLegacy(dir, srv.port, "with-usage");
    // 外部独立事实：真的发了 1 次 HTTP、真的占了 1 次额度
    assert.equal(srv.hits(), 1, "服务器确实收到 1 次请求");
    assert.equal(r.used, 1, "临时账本 used=1（与请求数对账）");
    assert.notEqual(r.source, "none", "★ 缺 attempts/transport 不能证明\"没发出\"");
    assert.equal(r.source, "partial", "★ 发出次数无法确定 ⇒ 只拿到的一份用量只能算**下界**（partial）");
    assert.equal((r.usage?.promptTokens ?? 0) + (r.usage?.completionTokens ?? 0), 18, "合法供应商计数必须保留");
    assert.equal(r.targetError, "", "这不是调用失败");
    assert.ok(r.finalText.length > 0, "回答正常返回");
  } finally { srv.stop(); }
});

test("F4-③ ★反例：旧桥发过 HTTP(1 次)且完全没报 usage ⇒ 恰好 unknown（不是 none、也不是 reported）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-f4-nousage-"));
  const srv = await startServer(dir);
  try {
    const r = runLegacy(dir, srv.port, "without-usage");
    assert.equal(srv.hits(), 1, "服务器确实收到 1 次请求");
    assert.equal(r.used, 1);
    assert.equal(r.source, "unknown", "★ 未取得用量 ⇒ unknown（适配器补的 0/0 不得当供应商报告）");
    assert.equal(r.targetError, "", "回答仍成功");
    assert.ok(r.finalText.length > 0);
  } finally { srv.stop(); }
});

test("F4-④ 旧桥 attempts=1 且无 usage ⇒ unknown；attempts=1 且有 usage ⇒ reported（合法对照不可被破坏）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-f4-attempts1-"));
  const srv = await startServer(dir);
  try {
    const noUsage = runLegacy(dir, srv.port, "attempts1-no-usage");
    assert.equal(srv.hits(), 1);
    assert.equal(noUsage.source, "unknown", "★ 发出过 1 次但没有用量 ⇒ unknown");
    const withUsage = runLegacy(dir, srv.port, "attempts1");
    assert.equal(srv.hits(), 2);
    assert.equal(withUsage.source, "reported", "★ 发出过 1 次且这次有合法用量 ⇒ reported（合法旧桥对照）");
    assert.equal((withUsage.usage?.promptTokens ?? 0) + (withUsage.usage?.completionTokens ?? 0), 18);
  } finally { srv.stop(); }
});

test("F4-⑤ 多次尝试（attempts=2）、或只有送达状态（submitted）而缺 attempts ⇒ 只拿到一份用量算 partial（下界）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-f4-multi-"));
  const srv = await startServer(dir);
  try {
    const two = runLegacy(dir, srv.port, "attempts2");
    assert.equal(two.source, "partial", "attempts=2 但只拿到一份用量 ⇒ 下界");
    assert.equal((two.usage?.promptTokens ?? 0) + (two.usage?.completionTokens ?? 0), 18, "数字保留（下界）");
    const submitted = runLegacy(dir, srv.port, "submitted");
    assert.equal(submitted.source, "partial", "有 submitted 证据但次数未知 ⇒ 下界");
  } finally { srv.stop(); }
});

test("F4-⑥ 入口级（真实 Work Loop）：旧桥 attempts=1、WL-01 那条无 usage ⇒ 基线 18 保留，WL-01 无完整成本轮且不给整体结论", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-f4-workloop-"));
  const srv = await startServer(dir, "2");   // 命中 2（WL-01）不返回 usage
  try {
    const outDir = join(dir, "out");
    const r = spawnSync(process.execPath, [
      join(TS_ROOT, "scripts", "workloop-eval.ts"),
      "--samples", "1", "--benign-limit", "1", "--out", outDir,
      "--budget", join(dir, "budget.json"), "--budget-limit", "30",
    ], {
      cwd: TS_ROOT, encoding: "utf8", timeout: 60_000,
      env: {
        ...process.env,
        AICGUARD_BRIDGE: SHIM, LEGACY_MODE: "attempts1", LEGACY_BUDGET_MODULE: BUDGET_URL,
        AICGUARD_BASE_URL: `http://127.0.0.1:${srv.port}/v1`,
        AICGUARD_API_KEY: "sk-test-not-real", AICGUARD_MODEL: `m-f4-wl-${process.pid}`,
      },
    });
    assert.equal(r.status, 0, `workloop 应正常跑完。输出：${(r.stdout ?? "").slice(0, 600)}`);
    assert.equal(srv.hits(), 7, "1 条良性 + 6 条攻击各 1 次真实 HTTP");
    const rep = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8")) as {
      baseline: { meanTokens: number | null; samples: Array<{ usageSource: string; usageComplete: boolean }> };
      cases: Array<{ id: string; rounds: Array<{ usageSource: string; usage: unknown; usageComplete: boolean }>;
        meanTokens: number | null; meanMultiplier: number | null; flagged: boolean | null }>;
    };
    const md = readFileSync(join(outDir, "report.md"), "utf8");
    assert.equal(rep.baseline.meanTokens, 18, "★ 良性基线仍是 18（attempts=1 + usage ⇒ reported 完整样本）");
    assert.equal(rep.baseline.samples[0].usageSource, "reported");
    assert.equal(rep.baseline.samples[0].usageComplete, true);
    const wl01 = rep.cases.find((c) => c.id === "WL-01")!;
    assert.equal(wl01.rounds[0].usageSource, "unknown", "★ 那条没有用量 ⇒ unknown");
    assert.equal(wl01.rounds[0].usage, null, "★ 数值必须是 null（不得写占位 0）");
    assert.equal(wl01.rounds[0].usageComplete, false, "★ 不得算完整成本样本");
    assert.equal(wl01.meanTokens, null, "★ 均值不可计算");
    assert.equal(wl01.meanMultiplier, null);
    assert.equal(wl01.flagged, null, "★ 达阈判定不可计算");
    assert.ok(!/6\/6\s*条未达/.test(md), "★ 不得再输出\"6/6 条未达 5× 阈值\"这类整体负结论");
    assert.match(md, /用量未取得/, "报告要如实写\"用量未取得\"");
  } finally { srv.stop(); }
});

/**
 * F5 / P2：**旧协议元信息自相矛盾时不得宣布"确认零消耗"**（Codex 复核 `codex-review-912a5dd`）。
 *
 * 修前实测（复核者 `contradiction-results.json`：11 断言 6 过 5 败）：`resolveUsageSource` 在检查相反证据**之前**
 * 就 `return "none"` ⇒ 下列三种"真发过 HTTP（服务器 1 请求、临时账本 used=1）却把元信息说成没发"的组合
 * 全被判 `none`，Work Loop 的报告甚至写下"未发出请求：确认零消耗"。
 *   ① `attempts=0` **且** `request.state=submitted`；② `attempts=1` **且** `refused`；③ `attempts=1` **且** `dry-run`。
 * 修法：先分类"明确没发出"与"明确发出过/有真实计数"两类证据，**冲突时保守归类**——
 *   有合法数字就当下界（partial），没有数字就 unknown；**绝不**在证据矛盾时宣布 none。
 * 同时保留既有对照：显式 0 次 + refused ⇒ none；一致的 1 次 + 合法用量 ⇒ reported；无用量 ⇒ unknown。
 */
test("F5 ★反例：元信息互相矛盾（0次+submitted / 1次+refused / 1次+dry-run）时绝不判 none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-f5-conflict-"));
  const srv = await startServer(dir);
  try {
    for (const mode of ["zero-submitted", "refused-usage", "dryrun-usage"]) {
      const r = runLegacy(dir, srv.port, mode);
      // 独立事实：真的发出了 1 次 HTTP、真的占了 1 次额度
      assert.ok(srv.hits() > 0, `${mode}：服务器确实收到请求`);
      assert.equal(r.used, 1, `${mode}：临时账本 used=1（与请求数对账）`);
      assert.notEqual(r.source, "none", `★ ${mode}：证据矛盾 ⇒ 不能判"确认零消耗"`);
      assert.equal(r.source, "partial", `★ ${mode}：有合法数字 ⇒ 保守地当下界（partial）`);
      assert.equal((r.usage?.promptTokens ?? 0) + (r.usage?.completionTokens ?? 0), 18,
        `${mode}：真实观测到的 7/11 必须保留为下界`);
      assert.equal(r.targetError, "", `${mode}：这不是调用失败`);
    }
  } finally { srv.stop(); }
});

test("F5 对照：矛盾但**没有数字**⇒ unknown（不猜零）；一致的无证据组合仍按原口径", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-f5-conflict2-"));
  const srv = await startServer(dir);
  try {
    // 冲突且无用量数字 ⇒ unknown（既不是 none，也不是 reported）
    const noUsage = runLegacy(dir, srv.port, "zero-submitted-no-usage");
    assert.equal(noUsage.used, 1, "零-submitted-无用量：仍然真的发过 1 次");
    assert.equal(noUsage.source, "unknown", "★ 矛盾且无数字 ⇒ unknown");
    // 阳性对照：显式 0 次 + refused（0 请求）仍必须是 none
    const refusal = runLegacy(dir, srv.port, "refusal");
    assert.equal(refusal.source, "none", "✅ 无矛盾的\"确认未发出\"不受影响");
    // 阳性对照：一致的 1 次 + 合法用量仍是 reported
    const healthy = runLegacy(dir, srv.port, "attempts1");
    assert.equal(healthy.source, "reported", "✅ 一致且次数已知为 1 ⇒ reported（合法对照未退化）");
  } finally { srv.stop(); }
});

test("F5 入口级：WL-01 出现 1次+refused 冲突 ⇒ 不写\"确认零消耗\"，18 作下界保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-f5-workloop-"));
  const srv = await startServer(dir);   // 命中 2（WL-01）**也返回真实 7/11**：冲突出在元信息里（不是缺用量）
  try {
    const outDir = join(dir, "out");
    const r = spawnSync(process.execPath, [
      join(TS_ROOT, "scripts", "workloop-eval.ts"),
      "--samples", "1", "--benign-limit", "1", "--out", outDir,
      "--budget", join(dir, "budget.json"), "--budget-limit", "30",
    ], {
      cwd: TS_ROOT, encoding: "utf8", timeout: 60_000,
      env: {
        ...process.env,
        AICGUARD_BRIDGE: SHIM, LEGACY_MODE: "workloop-conflict", LEGACY_BUDGET_MODULE: BUDGET_URL,
        AICGUARD_BASE_URL: `http://127.0.0.1:${srv.port}/v1`,
        AICGUARD_API_KEY: "sk-test-not-real", AICGUARD_MODEL: `m-f5-wl-${process.pid}`,
      },
    });
    assert.equal(r.status, 0, `workloop 应正常跑完。输出：${(r.stdout ?? "").slice(0, 600)}`);
    assert.equal(srv.hits(), 7, "7 次真实 HTTP（1 良性 + 6 攻击）");
    const rep = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8")) as {
      cases: Array<{ id: string; rounds: Array<{ usageSource: string; usage: { promptTokens: number; completionTokens: number } | null; usageComplete: boolean }>;
        meanTokens: number | null; meanMultiplier: number | null; flagged: boolean | null }>;
    };
    const md = readFileSync(join(outDir, "report.md"), "utf8");
    const wl01 = rep.cases.find((c) => c.id === "WL-01")!;
    assert.equal(wl01.rounds[0].usageSource, "partial", "WL-01（attempts=1 但服务器真的答了）⇒ 下界");
    assert.equal(wl01.rounds[0].usageComplete, false, "下界不得当完整成本样本");
    assert.equal(wl01.meanTokens, null);
    assert.equal(wl01.meanMultiplier, null);
    assert.equal(wl01.flagged, null);
    assert.ok(!md.includes("未发出请求：确认零消耗"), "★ 报告不得在真发过的情况下写\"确认零消耗\"");
    assert.match(md, /已知部分用量（下界）/, "改写为下界说明");
  } finally { srv.stop(); }
});
