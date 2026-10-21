/**
 * G1（`docs/40`）：`node src/run.ts --salt <串>` 必须真的进入缓存键。
 *
 * 为什么这是 M6 的硬前置：文本组的矩阵是「8 条攻击 × none/full × **2 次采样**」。
 * 缓存键含 salt ⇒ 只给同一批参数、**不给盐**跑两轮，第二轮只会命中缓存：
 * 看起来"省了额度"，实际**第 2 个独立样本根本没采到**。所以断言必须成对：
 *   ① 阳性：不同盐 ⇒ 真的又打了一次桥（新样本）；
 *   ② 阴性对照：同一个盐再跑 ⇒ **一次都不再打桥**（命中缓存）——
 *      没有 ②，"每轮都新请求"就分不清是"盐生效"还是"缓存整个失效"。
 *   ③ 缺省不变：不给 `--salt` ⇒ 与"空盐"同行为（第二轮命中缓存），旧调用者不受影响。
 *
 * 全程离线：`AICGUARD_BRIDGE` 指向计数据数的替身桥（不发网络）；
 * `AICGUARD_BASE_URL` 指向 127.0.0.1 的死端口，即使替身桥失效也不会碰外网；
 * 模型名带随机后缀 ⇒ 缓存目录与其它测试/运行隔离，跑完删除。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const RUN_TS = resolve(TS_ROOT, "src", "run.ts");

/** 替身桥：每被调用一次就追加一行（唯一计数源），并回一个健康响应 */
const STUB_BRIDGE = `
import { appendFileSync, readFileSync } from "node:fs";
readFileSync(0, "utf8");
appendFileSync(process.env.COUNTER_FILE, "1\\n");
process.stdout.write(JSON.stringify({ text: "替身回复", usage: { prompt_tokens: 3, completion_tokens: 2 }, toolCalls: [] }));
`;

interface Harness {
  dir: string;
  calls: () => number;
  run: (salt?: string) => { status: number | null; stdout: string; stderr: string };
  /** 用**同一套环境**跑任意参数（供可见性/缺值等额外反例复用，避免另建一套模型环境造成残留） */
  runRaw: (extra: string[]) => { status: number | null; stdout: string; stderr: string };
  cleanup: () => void;
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-run-salt-"));
  writeFileSync(join(dir, "stub-bridge.mjs"), STUB_BRIDGE, "utf8");
  // 模型名带随机后缀：createLlmBotFromEnv 把缓存目录定为 runs/llm-cache/<model>
  const model = `m6-salt-${process.pid}-${Date.now().toString(36)}`;
  const cacheDir = join(TS_ROOT, "runs", "llm-cache", model);
  const counter = join(dir, "calls.log");
  const env = {
    ...process.env,
    AICGUARD_BRIDGE: join(dir, "stub-bridge.mjs"),
    COUNTER_FILE: counter,
    AICGUARD_BASE_URL: "http://127.0.0.1:9/v1",   // 死端口：任何真实 HTTP 都只会失败，不会外泄
    AICGUARD_API_KEY: "sk-test-not-real",
    AICGUARD_MODEL: model,
    AICGUARD_BUDGET: join(dir, "budget.json"),
    AICGUARD_BUDGET_LIMIT: "20",
    AICGUARD_CACHE_MODE: "fresh",
  };
  let n = 0;
  const runRaw = (extra: string[]) => {
    n++;
    const args = [RUN_TS, "--target", "llm", "--profile", "none", "--expand", "0",
      "--limit", "1", "--benign-limit", "0",
      "--out", join(dir, `out-${n}`), ...extra];
    const r = spawnSync(process.execPath, args, { cwd: TS_ROOT, env, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const run = (salt?: string) => runRaw(["--quiet", ...(salt === undefined ? [] : ["--salt", salt])]);
  return {
    dir,
    calls: () => (existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter((l) => l.trim()).length : 0),
    run,
    runRaw,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    },
  };
}

test("G1-① 阳性：换盐 ⇒ 真的又打一次桥（第 2 个独立样本没被缓存吞掉）", () => {
  const h = setup();
  try {
    const first = h.run("m6-s1");
    assert.equal(first.status, 0, `run.ts 必须正常退出：${first.stderr}`);
    const afterFirst = h.calls();
    assert.ok(afterFirst >= 1, `第 1 轮必须真的调桥（实际 ${afterFirst}）`);

    const second = h.run("m6-s2");
    assert.equal(second.status, 0, `run.ts 必须正常退出：${second.stderr}`);
    const afterSecond = h.calls();
    assert.ok(afterSecond > afterFirst,
      `换盐必须产生新请求：换盐前 ${afterFirst} 次，换盐后 ${afterSecond} 次`
      + "（若相等 ⇒ 盐没进缓存键，两次采样实际是同一个样本）");
  } finally {
    h.cleanup();
  }
});

test("G1-② 阴性对照：同一个盐再跑 ⇒ 命中缓存，一次桥都不再调", () => {
  const h = setup();
  try {
    assert.equal(h.run("m6-same").status, 0);
    const base = h.calls();
    assert.ok(base >= 1, `首次必须真的调桥（实际 ${base}）`);
    assert.equal(h.run("m6-same").status, 0);
    assert.equal(h.calls(), base,
      "同盐同参数必须命中缓存 ⇒ 调用次数不变（证明 ① 的增量来自盐，而不是缓存失效）");
  } finally {
    h.cleanup();
  }
});

test("G1-③ 缺省不变：不给 --salt ⇒ 与空盐同行为（第二轮命中缓存）", () => {
  const h = setup();
  try {
    assert.equal(h.run().status, 0);
    const base = h.calls();
    assert.ok(base >= 1, `首次必须真的调桥（实际 ${base}）`);
    assert.equal(h.run().status, 0);
    assert.equal(h.calls(), base,
      "不给 --salt 时行为必须与加该参数前一致（不允许静默变更默认缓存身份）");
  } finally {
    h.cleanup();
  }
});

test("G1 可见性：--salt 必须在运行信息里打印出来（两轮采样对账靠它）", () => {
  const h = setup();   // 复用同一套隔离环境（模型名唯一、cleanup 会连缓存目录一起删）+ 已固定 AICGUARD_CACHE_MODE=fresh
  try {
    const r = h.runRaw(["--salt", "m6-visible"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /采样盐\s*:\s*m6-visible/, `运行信息必须打印采样盐：\n${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test("G1 反例：--salt 缺值（末尾裸写 / 后跟另一个 flag）⇒ 退出码 2，不得静默当成未指定", () => {
  const h = setup();
  try {
    for (const extra of [["--salt"], ["--salt", "--profile", "none"]]) {
      const r = h.runRaw(extra);
      assert.equal(r.status, 2, `${JSON.stringify(extra)} 必须在执行前失败（实际 ${r.status}）`);
      assert.match(r.stderr, /--salt 缺少取值/, `stderr 要点明缺取值：${r.stderr}`);
    }
    assert.equal(h.calls(), 0, "缺值路径不得发出任何请求（0 次桥调用）");
  } finally {
    h.cleanup();
  }
});
