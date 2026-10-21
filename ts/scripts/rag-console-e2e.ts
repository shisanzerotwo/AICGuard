#!/usr/bin/env node
/**
 * RAG 控制台端到端（M5-7）—— 浏览器流程的**可复算替身**：真起服务器、真走 HTTP、真轮询、真读产物。
 *
 * 为什么不让脚本直接调 `rag-eval.ts`：那样验的是"脚本能跑"，不是"**控制台**能跑"。
 * 本脚本只通过 HTTP 与产物文件断言，等价于人在控制台点了「靶子 = RAG 知识库检索 → 开始跑批」：
 *   ① `POST /api/rag/eval` 起任务（编排 `scripts/rag-eval.ts`）
 *   ② 用 `/api/job/status` 轮询到 `done`，核对 `result.type === "rag-eval"` 与三口径字段
 *   ③ 打开 `/runs/<id>/rag-evidence.html`，断言**五类证据分区**齐全（检索排名 / 选中片段 / 阻断 / 送达 / 判定）
 *   ④ 核对 forced 装配语义：`RAGD-07` 自然检索未命中、载荷仍由**装配**送入
 *   ⑤ 首尾哈希 `data/`：控制台 RAG 流程**只读**正式语料
 *
 * 离线纪律：靶子 = AgroBot（离线），零真实模型调用、零出网；文档用开发夹具（显式目录，不碰留出集）。
 * 用法：node scripts/rag-console-e2e.ts [--port 7941]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const REPO_ROOT = join(TS_ROOT, "..");
const WORK = join(TS_ROOT, "runs", "rag-console-e2e");
const LIVE_DATA = join(REPO_ROOT, "data");
const PORT = Number((() => { const i = process.argv.indexOf("--port"); return i >= 0 ? process.argv[i + 1] : 7941; })());
const BASE = `http://127.0.0.1:${PORT}`;

const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (name.endsWith(".lock") || name.includes(".tmp-")) continue;
      out[relative(dir, p).split("\\").join("/")] = sha256(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

interface Step { name: string; detail: string; ok: boolean; raw?: unknown }
const steps: Step[] = [];
let failed = false;
const record = (name: string, detail: string, ok: boolean, raw?: unknown): void => {
  steps.push({ name, detail, ok, raw });
  console.log(`${ok ? "✅" : "❌"} ${name}｜${detail}`);
  if (!ok) failed = true;
};

async function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(TS_ROOT, "src", "server.ts")], {
    env: { ...process.env, AICGUARD_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("服务器未在 25s 内就绪")), 25_000);
    const onData = (d: Buffer): void => {
      if (String(d).includes("控制台")) { clearTimeout(timer); resolveReady(); }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", reject);
  });
  return child;
}

async function main(): Promise<void> {
  console.log(`RAG 控制台端到端：端口 ${PORT}｜工作目录 ${WORK}`);
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const liveBefore = hashTree(LIVE_DATA);

  const server = await startServer();
  let runId = "";
  let status: Record<string, unknown> = {};
  let evidenceHtml = "";
  try {
    // ① 元信息里必须有 RAG 目标（控制台据此把它列成可选项）
    const meta = await fetch(`${BASE}/api/meta`).then((r) => r.json() as Promise<Record<string, unknown>>);
    const rag = (meta as { rag?: Record<string, unknown> }).rag;
    record("① /api/meta 暴露 RAG 目标", rag ? `docsDefault=${String(rag.docsDefault).slice(0, 40)}…` : "缺少 rag 段", !!rag, rag);

    // ② 起任务（显式给开发夹具目录与用例；相对 ts/ 解析）
    const res = await fetch(`${BASE}/api/rag/eval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: "rules+norm",
        docsDir: "tests/fixtures/rag-dev-docs",
        cases: "tests/fixtures/rag-dev-cases.jsonl",
      }),
    });
    const started = await res.json() as { jobId?: string; runId?: string; error?: string };
    record("② POST /api/rag/eval 起任务", `HTTP ${res.status}｜jobId=${started.jobId ?? "-"}｜runId=${started.runId ?? "-"}`,
      res.status === 200 && !!started.jobId && !!started.runId, started);
    if (!started.jobId) throw new Error(started.error ?? "未拿到 jobId");
    runId = started.runId ?? "";

    // ③ 轮询（与前端同一接口、同一字段）
    let done = false;
    for (let i = 0; i < 120 && !done; i++) {
      await new Promise((r) => setTimeout(r, 500));
      status = await fetch(`${BASE}/api/job/status?jobId=${started.jobId}`).then((r) => r.json() as Promise<Record<string, unknown>>);
      done = status.done === true || status.missing === true;
    }
    const result = (status.result ?? {}) as Record<string, unknown>;
    record("③ 轮询 /api/job/status 完成", `done=${done}｜code=${String(status.code)}｜type=${String(result.type)}`,
      done && status.code === 0 && result.type === "rag-eval", { done, code: status.code, kind: status.kind, result });

    // ④ 三口径字段齐全（控制台直接渲染的就是这些）
    const metrics = (result.metrics ?? {}) as Record<string, unknown>;
    const e2e = (metrics.endToEnd ?? {}) as Record<string, unknown>;
    const cov = (metrics.coverage ?? {}) as Record<string, unknown>;
    const okMetrics = metrics.scope === "rag" && typeof e2e.asr !== "undefined" && typeof cov.invalidTests !== "undefined";
    record("④ 结果含 scope=rag 三口径与覆盖", `scope=${String(metrics.scope)}｜e2e.asr=${String(e2e.asr)}｜invalidTests=${String(cov.invalidTests)}`,
      okMetrics, { metrics, docs: result.docs });

    // ⑤ forced 装配语义（RAGD-07：自然检索未命中，载荷仍由装配送入）
    const cases = (result.cases ?? []) as Array<Record<string, unknown>>;
    const c07 = cases.find((c) => c.id === "RAGD-07");
    const okAssembly = !!c07 && c07.naturalHit === false && c07.selectionMode === "forced"
      && c07.forcedAssembled === true && c07.delivered === true && c07.rankedCount === 0;
    record("⑤ forced 装配：检索未命中仍送达", c07
      ? `naturalHit=${String(c07.naturalHit)}｜rankedCount=${String(c07.rankedCount)}｜delivered=${String(c07.delivered)}｜forcedMet=${String(c07.forcedMet)}`
      : "缺 RAGD-07", okAssembly, { cases });

    // ⑥ 证据页：五类分区 + 请求哈希 + 自包含
    const evPath = String(result.evidence ?? "");
    if (evPath) evidenceHtml = await fetch(`${BASE}${evPath}`).then((r) => r.text());
    const sections = ["① 检索排名", "② 选中片段（装配后顺序）", "③ 阻断", "④ 送达", "⑤ 判定"];
    const missing = sections.filter((s) => !evidenceHtml.includes(s));
    const hasHash = cases.length > 0 && cases.every((c) => evidenceHtml.includes(String(c.requestSha256)));
    const selfContained = !/src="https?:/.test(evidenceHtml) && !/href="https?:/.test(evidenceHtml);
    record("⑥ 证据页五类分区 + 请求哈希 + 自包含",
      `HTTP 200?=${evidenceHtml.length > 0}｜缺分区 ${missing.length ? missing.join("/") : "无"}｜哈希齐全=${hasHash}｜自包含=${selfContained}`,
      evidenceHtml.length > 0 && missing.length === 0 && hasHash && selfContained, { evPath, bytes: evidenceHtml.length });

    // ⑦ 负向自证：证据页里不得出现留出集字样（证明跑的是开发夹具，不是留出集）
    const leak = /holdout/i.test(evidenceHtml);
    record("⑦ 负向自证：证据页不含留出集字样", `matches=${leak}`, !leak);
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 400));
  }

  // ⑧ 正式 data/ 只读自证
  const liveAfter = hashTree(LIVE_DATA);
  const same = JSON.stringify(liveBefore) === JSON.stringify(liveAfter);
  record("⑧ 正式 data/ 只读自证", `${Object.keys(liveAfter).length} 个文件｜逐字节未变=${same}`, same);

  const report = {
    generatedAt: new Date().toISOString(),
    port: PORT, runId, offline: true,
    liveDataUntouched: same,
    steps, conclusion: failed ? "存在失败步骤" : "全流程通过（起任务 → 轮询 → 三口径 → 装配语义 → 五类证据页）",
    jobStatus: status,
  };
  writeFileSync(join(WORK, "console-e2e.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  if (evidenceHtml) writeFileSync(join(WORK, "rag-evidence.copied.html"), evidenceHtml, "utf8");

  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>RAG 控制台端到端证据（M5-7）</title>
<style>body{font:14px/1.6 system-ui,"Segoe UI",sans-serif;max-width:1100px;margin:24px auto;padding:0 16px}
h1{font-size:20px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;font-size:13px}
.ok{color:#0a7a2f;font-weight:600}.bad{color:#b3261e;font-weight:600}pre{background:#f6f8fa;padding:8px;overflow:auto;font-size:12px;white-space:pre-wrap}
.meta{color:#555;font-size:12px}details{margin:6px 0}</style></head><body>
<h1>AICGuard · RAG 控制台端到端证据（M5-7）</h1>
<p class="meta">生成时间：${report.generatedAt}｜端口 ${PORT}｜run <code>${esc(runId)}</code>｜离线（零真实模型）｜正式 data/ 未变：<span class="${same ? "ok" : "bad"}">${same ? "是 ✅" : "否 ❌"}</span></p>
<p><strong>结论：</strong><span class="${failed ? "bad" : "ok"}">${esc(report.conclusion)}</span></p>
<table><tr><th>步骤</th><th>结果</th><th>详情</th></tr>
${steps.map((s) => `<tr><td>${esc(s.name)}</td><td class="${s.ok ? "ok" : "bad"}">${s.ok ? "通过" : "失败"}</td><td>${esc(s.detail)}</td></tr>`).join("")}
</table>
${steps.filter((s) => s.raw !== undefined).map((s) => `<details><summary>${esc(s.name)} 原始报文</summary><pre>${esc(JSON.stringify(s.raw, null, 2).slice(0, 6000))}</pre></details>`).join("")}
<p class="meta">五类证据页本体：<code>runs/${esc(runId)}/rag-evidence.html</code>（本页的 <code>rag-evidence.copied.html</code> 是同一份内容的落盘副本）。</p>
</body></html>`;
  writeFileSync(join(WORK, "console-e2e.html"), html, "utf8");

  console.log(`\n证据：${join(WORK, "console-e2e.html")} / console-e2e.json`);
  console.log(`结论：${report.conclusion}｜正式 data/ 未改动=${same}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(`失败：${(e as Error).message}`);
  process.exitCode = 1;
});
