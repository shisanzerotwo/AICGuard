/**
 * M3-4c：语料根目录解析的优先级与警告（复核者建议 D4）。
 * 关注点：两个环境变量同时设置时，必须**显式警告 + 写进 detail**，避免"以为走了快照其实读的是显式目录"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDataRoot } from "../src/data-root.ts";

const ROOT = mkdtempSync(join(tmpdir(), "aicguard-dataroot-"));

test("优先级：explicit > snapshot > worktree；两者同设时必须警告且 detail 说清未走快照", () => {
  const dataDir = join(ROOT, "explicit-data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "probes_zh.jsonl"), "{}\n", "utf8");

  // ① 都没有 ⇒ worktree
  let info = resolveDataRoot({ repoRoot: ROOT, env: {} });
  assert.equal(info.source, "worktree");
  assert.equal(info.commitId, undefined);

  // ② 只有 explicit
  info = resolveDataRoot({ repoRoot: ROOT, env: { AICGUARD_DATA_DIR: dataDir } });
  assert.equal(info.source, "explicit");
  assert.equal(info.dir, dataDir);

  // ③ 两者同设 ⇒ explicit 赢，但 detail 必须写明"未走快照"
  info = resolveDataRoot({ repoRoot: ROOT, env: { AICGUARD_DATA_DIR: dataDir, AICGUARD_SNAPSHOT_ROOT: join(ROOT, "snap") } });
  assert.equal(info.source, "explicit");
  assert.match(info.detail, /未走快照/);

  // ④ 快照优先于 worktree：无 current.json 时必须报错（拒绝猜测，避免混读）
  assert.throws(
    () => resolveDataRoot({ repoRoot: ROOT, env: { AICGUARD_SNAPSHOT_ROOT: join(ROOT, "snap") } }),
    /没有 current\.json/,
  );

  // ⑤ 相对路径按 repoRoot 解析（错误信息里也点明这一点）
  assert.throws(
    () => resolveDataRoot({ repoRoot: ROOT, env: { AICGUARD_SNAPSHOT_ROOT: "ts/runs/not-exist" } }),
    /相对路径按\*\*仓库根\*\*解析/,
  );
});

test("清理临时目录（必须放最后）", () => {
  rmSync(ROOT, { recursive: true, force: true });
});
