/**
 * M3-3b 验收测试：CLI 与服务器**共用同一写入模块与跨进程独占锁**（docs/21 §M3-3 的准入条件）。
 *
 * 怎么测（全部离线、不碰 data/）：
 *   1. 临时状态文件 + 临时锁目录（环境变量 `AICGUARD_CANDIDATES_STATE` 覆盖），
 *      保证测试不写生产路径；
 *   2. 真起服务器子进程（`node src/server.ts`，端口取空闲高位）；
 *   3. 让"服务器端点"与"CLI 进程"**同时**审核同一候选 ⇒ 断言：
 *      - **恰好一个成功**（版本 1 → 2），另一个被拒（版本冲突或锁冲突），
 *      - 最终状态只有一次有效应用（version=2，且决定与成功者一致）；
 *   4. 另一条独立断言：锁被外部持有时，服务器端点必须返回 **409** 且不写盘。
 *
 * 注：并发时序不确定（谁先谁后都可能），所以断言写成"恰好一个成功 + 另一个拿到冲突/锁拒绝"，
 * 这在两种交错下都成立——这也是契约的写法（docs/15 §3.1）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptyState, saveState, acquireLock, releaseLock, loadState } from "../src/candidate-store.ts";
import { migrateCandidate } from "../src/candidates.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = join(HERE, "..");
const TMP = mkdtempSync(join(tmpdir(), "aicguard-m33b-"));
const STATE = join(TMP, "candidates-state.json");
const PORT = 7911;

const seedState = (): void => {
  const s = { ...emptyState() };
  s.candidates = [
    migrateCandidate({ id: "EV-01", family: "direct_injection", text: "文本一", goal: "leak_system_prompt", severity: 3, notes: "备注一", source: "native", status: "pending" }),
    migrateCandidate({ id: "EV-02", family: "direct_injection", text: "文本二", goal: "leak_system_prompt", severity: 3, notes: "备注二", source: "native", status: "pending" }),
  ];
  saveState(STATE, s);
};

async function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(TS_ROOT, "src", "server.ts")], {
    env: { ...process.env, AICGUARD_PORT: String(PORT), AICGUARD_CANDIDATES_STATE: STATE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务器未在 20s 内就绪")), 20000);
    const onData = (d: Buffer): void => {
      if (String(d).includes("控制台")) { clearTimeout(timer); resolve(); }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", reject);
  });
  return child;
}

const post = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

/** 起一个 CLI 子进程审核指定候选，返回 {code, stdout} */
function runCli(id: string, by: string, decision: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      join(TS_ROOT, "scripts", "review-candidates.ts"),
      "--state", STATE,
      "--review", id, "--action", decision, "--expect-version", "1",
      "--by", by, "--note", "并发测试",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("CLI 与服务器同时审核同一候选 ⇒ 恰好一个成功，另一个拿到冲突，最终只有一次应用", async (t) => {
  seedState();
  const server = await startServer();
  try {
    // 两边都基于"version=1"的同一快照；同时发出
    const [serverRes, cliRes] = await Promise.all([
      post("/api/candidates/review", {
        requests: [{ id: "EV-01", expectedVersion: 1, decision: "approved", mode: "manual_confirm", by: "human:server-tab", note: "控制台审核" }],
      }),
      runCli("EV-01", "human:cli-user", "rejected"),
    ]);

    const serverApplied = Number(
      ((serverRes.json.report as { applied?: unknown[] } | undefined)?.applied ?? []).length ?? 0,
    );
    const cliApplied = /已应用/.test(cliRes.out) ? 1 : 0;
    assert.equal(serverApplied + cliApplied, 1, `恰好一个成功（server=${serverApplied}, cli=${cliApplied}）\nserver=${JSON.stringify(serverRes.json)}\ncli=${cliRes.out}`);
    assert.ok(serverRes.status === 200 || serverRes.status === 409, `服务器响应码应为 200/409，实际 ${serverRes.status}`);

    const s = loadState(STATE);
    const c = s.candidates.find((x) => x.id === "EV-01")!;
    assert.equal(c.version, 2, "只允许一次有效应用（版本只前进一次）");
    const winnerIsServer = serverApplied === 1;
    assert.equal(c.review.by, winnerIsServer ? "human:server-tab" : "human:cli-user", "最终决定必须来自成功者");
    assert.equal(c.status, winnerIsServer ? "approved" : "rejected");

    // 失败方必须拿到明确的冲突/拒绝理由（而不是静默失败）
    if (winnerIsServer) {
      assert.match(cliRes.out, /未应用（冲突|拒绝写入/);
    } else {
      const report = serverRes.json.report as { conflicts?: Array<{ reason: string }> } | undefined;
      const reasons = (report?.conflicts ?? []).map((x) => x.reason);
      assert.ok(reasons.includes("versionConflict") || serverRes.status === 409, `服务器应报冲突/锁拒绝：${JSON.stringify(serverRes.json)}`);
    }
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
  t.diagnostic("并发交错下的断言已覆盖两种先后顺序（恰好一个成功）");
});

test("外部持锁时，服务器端点必须 409 且不写盘", async () => {
  seedState();
  const server = await startServer();
  const lockPath = join(TS_ROOT, "runs", "locks", "candidates-state.json.lock");
  try {
    const held = acquireLock(lockPath, { owner: "test-holder", purpose: "模拟另一个写者持锁" });
    assert.equal(held.ok, true, "测试自身应先拿到锁");
    const before = readFileSync(STATE, "utf8");
    const res = await post("/api/candidates/review", {
      requests: [{ id: "EV-02", expectedVersion: 1, decision: "approved", mode: "manual_confirm", by: "human:tab", note: "锁占用时写入" }],
    });
    assert.equal(res.status, 409, `锁被占用时必须拒绝写入：${JSON.stringify(res.json)}`);
    assert.equal(readFileSync(STATE, "utf8"), before, "被拒时不得改写状态文件");
    if (held.ok) releaseLock(lockPath, held.lock.lockId);
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("服务器端点：auto_approve 未启用时拒绝 AI 请求；启用后写入并标记 AI", async () => {
  seedState();
  const server = await startServer();
  try {
    // 未启用 ⇒ 拒绝
    const denied = await post("/api/candidates/review", {
      requests: [{ id: "EV-01", expectedVersion: 1, decision: "approved", mode: "auto_approve", by: "ai:jev", confidence: 0.99, note: "AI 代审" }],
    });
    const deniedReport = denied.json.report as { conflicts?: Array<{ reason: string }> } | undefined;
    assert.equal(deniedReport?.conflicts?.[0]?.reason, "autoApproveNotEnabled");
    assert.equal(loadState(STATE).candidates.find((c) => c.id === "EV-01")!.review.mode, "legacy", "被拒时不得改动记录");

    // 显式启用（需要 confirm:true）
    const noConfirm = await post("/api/candidates/mode", { mode: "auto_approve" });
    assert.equal(noConfirm.status, 400);
    const enabled = await post("/api/candidates/mode", { mode: "auto_approve", confirm: true, minConfidence: 0.9 });
    assert.equal(enabled.status, 200);

    const ok = await post("/api/candidates/review", {
      requests: [{ id: "EV-01", expectedVersion: 1, decision: "approved", mode: "auto_approve", by: "ai:jev", confidence: 0.99, note: "AI 代审" }],
    });
    assert.equal(ok.status, 200);
    const c = loadState(STATE).candidates.find((x) => x.id === "EV-01")!;
    assert.equal(c.review.mode, "auto_approve");
    assert.equal(c.review.by, "ai:jev");
    assert.equal(c.review.needsRecheck, true, "AI 审核 ⇒ 仍需人工复核");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("写路径硬守卫（M3-5c）：显式目录/快照下，v1 候选审核端点必须 409 且不落盘", async () => {
  // 隔离数据目录（模拟"环境变量指向了非工作区目录"⇒ 明确不可就地写）
  const dataDir = join(TMP, "explicit-data");
  mkdirSync(dataDir, { recursive: true });
  const legacyFile = join(dataDir, "probes_candidates.jsonl");
  writeFileSync(legacyFile, '{"id":"EV-90","status":"pending","text":"旧形状候选"}\n', "utf8");
  const before = readFileSync(legacyFile, "utf8");

  const child = spawn(process.execPath, [join(TS_ROOT, "src", "server.ts")], {
    env: { ...process.env, AICGUARD_PORT: String(PORT + 1), AICGUARD_DATA_DIR: dataDir, AICGUARD_CANDIDATES_STATE: join(TMP, "guard-state.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务器未在 20s 内就绪")), 20000);
    const onData = (d: Buffer): void => { if (String(d).includes("控制台")) { clearTimeout(timer); resolve(); } };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", reject);
  });
  try {
    const res = await fetch(`http://127.0.0.1:${PORT + 1}/api/evolve/review`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "EV-90", action: "approved" }),
    });
    const body = (await res.json()) as { error?: string };
    assert.equal(res.status, 409, `必须拒绝就地写入：${JSON.stringify(body)}`);
    assert.match(String(body.error), /拒绝就地写入显式指定目录/, "拒绝理由必须可执行（说明为什么、该怎么做）");
    assert.equal(readFileSync(legacyFile, "utf8"), before, "被拒时不得改写文件");
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("清理（本测试自带；不触碰 data/ 与生产状态文件）", () => {
  assert.equal(existsSync(join(TS_ROOT, "runs", "locks", "candidates-state.json.lock")), false, "锁必须已释放");
  rmSync(TMP, { recursive: true, force: true });
  // 生产状态文件不应被本测试创建
  const prod = join(TS_ROOT, "runs", "candidates-state.json");
  if (existsSync(prod)) {
    const s = JSON.parse(readFileSync(prod, "utf8")) as { candidates?: unknown[] };
    assert.ok(Array.isArray(s.candidates), "若生产状态文件存在，至少应是合法状态文档");
  }
});
