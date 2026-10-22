#!/usr/bin/env node
/**
 * 导出 Pages 只读 API 快照：functions/api/_snapshot.js
 *
 * 做法：临时启动本地控制台服务器（ts/src/server.ts），直接抓取真实只读接口响应，
 * 合并成静态快照供 Pages Functions 返回——保证线上控制台展示的数据与本地一致，
 * 不在脚本里重新实现一遍读取逻辑。
 *
 * 用法：node scripts/export-pages-snapshot.mjs
 * 依赖：Node >= 23.6（与 start.sh / start.bat 相同）
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.EXPORT_PORT ?? 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(ROOT, "functions", "api", "_snapshot.js");

const CORPUS = [
  "probes_zh", "probes_mt_zh", "probes_agro", "probes_tool_abuse", "probes_workloop",
  "probes_garak_mt", "benign_zh", "sanity_positive", "probes_candidates",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + path);
      if (r.ok) return await r.json();
    } catch { /* 服务尚未就绪 */ }
    await sleep(500);
  }
  throw new Error(`接口无响应：${path}`);
}

const server = spawn(process.execPath, [join(ROOT, "ts", "src", "server.ts")], {
  cwd: ROOT,
  env: { ...process.env, AICGUARD_PORT: String(PORT) },
  stdio: "ignore",
});

const stop = () => { try { server.kill(); } catch { /* 已退出 */ } };
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });

try {
  const snapshot = {
    meta: await getJson("/api/meta"),
    runs: await getJson("/api/runs"),
    evolveHistory: await getJson("/api/evolve/history"),
    evolveCandidates: await getJson("/api/evolve/candidates"),
    corpus: Object.fromEntries(await Promise.all(
      CORPUS.map(async (k) => [k, await getJson(`/api/corpus?file=${k}`)])
    )),
  };

  writeFileSync(OUT, `export default\n${JSON.stringify(snapshot)}\n;\n`, "utf8");
  const runs = snapshot.runs.runs ?? [];
  console.log(`快照已写入：${OUT}`);
  console.log(`  runs=${runs.length}（最新 ${runs[0]?.runId ?? "—"}）  corpus=${Object.keys(snapshot.corpus).length} 库`);
  console.log("提示：提交后 Pages 会自动重新部署；写操作接口仍返回 503（需本地后端）。");
} finally {
  stop();
}
