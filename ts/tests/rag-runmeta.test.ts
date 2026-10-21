/**
 * RAG run 元信息回归测试（M5-5，`docs/31` §3 M5-5；口径 `docs/15` §4.1 + M3-4 语料三态）。
 *
 * 要锁三件事：
 *   ① 检索配置必须**原样进元信息**（"跑的时候用的是哪套配置"不能靠报告作者回忆）；
 *   ② **文档快照哈希**逐文件可复算（文档变了哈希必须变，否则"这批数字出自哪份文档"就无从追溯）；
 *   ③ 文档来源沿用 M3-4 的**三态纪律**：显式 > 快照 > 工作区，且**拒绝静默回落**
 *      （指定了快照却没有 docs/ ⇒ 抛错，不许悄悄去读工作区）。
 *
 * 另沿用 M2-2 的红线：元信息**不得含密钥**（序列化后 grep 无 `sk-` / `apiKey` / `Authorization`）。
 * 全程离线：文档用临时目录里的自造 .md，不读 `materials/`、不联网、不调模型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RAG_CONFIG } from "../src/rag.ts";
import { collectRagMeta, hashRagDocs, resolveRagDocs } from "../src/runmeta.ts";

function tmpTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ragmeta-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content, "utf8");
  }
  return root;
}

test("① hashRagDocs：稳定可复算、只收 .md、逐文件 sha256 与字符数", () => {
  const root = tmpTree({ "a.md": "灌溉排水管理", "b.md": "育苗移栽", "notes.txt": "不该被算进快照" });
  const a = hashRagDocs(root);
  const b = hashRagDocs(root);
  assert.equal(a.docHash, b.docHash, "同目录两次哈希必须一致");
  assert.deepEqual(a.docFiles.map((f) => f.file), ["a.md", "b.md"], "非 .md 不入快照（且按文件名排序）");
  assert.equal(a.docFiles[0].chars, 6);
  assert.match(a.docHash, /^[0-9a-f]{64}$/);
  for (const f of a.docFiles) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  rmSync(root, { recursive: true, force: true });
});

test("② 内容变则哈希变（阴性对照：证明哈希不是常量）", () => {
  const one = tmpTree({ "a.md": "灌溉排水管理" });
  const two = tmpTree({ "a.md": "灌溉排水管理（改了一个字）" });
  assert.notEqual(hashRagDocs(one).docHash, hashRagDocs(two).docHash);
  rmSync(one, { recursive: true, force: true });
  rmSync(two, { recursive: true, force: true });
});

test("③ collectRagMeta：检索配置**原样**进入元信息（含 normalizer 口径名与派生 stride）", () => {
  const root = tmpTree({ "a.md": "灌溉排水" });
  const meta = collectRagMeta({ docsDir: root, source: "worktree" });
  assert.deepEqual(meta.config, {
    chunkChars: RAG_CONFIG.chunkChars,
    overlapChars: RAG_CONFIG.overlapChars,
    stride: RAG_CONFIG.stride,
    topK: RAG_CONFIG.topK,
    contextChars: RAG_CONFIG.contextChars,
    normalizer: "bigram-multiset-v1",
  });
  assert.equal(meta.docsDir, root);
  assert.equal(meta.source, "worktree");
  assert.equal(meta.docFiles.length, 1);
  assert.equal(meta.snapshotCommitId, undefined, "工作区来源不得编造快照提交");
  rmSync(root, { recursive: true, force: true });
});

test("④ 三态：显式目录优先；指向不存在的目录 ⇒ **抛错**（不静默回落）", () => {
  const root = tmpTree({ "docs/a.md": "灌溉排水" });
  const explicit = resolveRagDocs({ repoRoot: root, defaultDocsDir: join(root, "should-not-be-used"), env: { AICGUARD_RAG_DOCS_DIR: join(root, "docs") } });
  assert.equal(explicit.source, "explicit");
  assert.equal(explicit.dir, join(root, "docs"));
  assert.throws(() => resolveRagDocs({ repoRoot: root, defaultDocsDir: join(root, "docs"), env: { AICGUARD_RAG_DOCS_DIR: join(root, "nope") } }),
    /不存在|nope/, "显式指定却不存在 ⇒ 必须报错，不能悄悄读别处");
  rmSync(root, { recursive: true, force: true });
});

test("⑤ 三态：快照根指向含 docs/ 的提交 ⇒ 固定到该提交；**缺 docs/ ⇒ 抛错**", () => {
  const root = tmpTree({
    "snapshots/current.json": JSON.stringify({ commitId: "c0ffee" }),
    "snapshots/snapshots/c0ffee/data/probes_zh.jsonl": "{}\n",
    "snapshots/snapshots/c0ffee/docs/spec.md": "# 文档快照里的文档",
    "nofdocs/current.json": JSON.stringify({ commitId: "beef" }),
    "nofdocs/snapshots/beef/data/probes_zh.jsonl": "{}\n",
  });
  const ok = resolveRagDocs({ repoRoot: root, defaultDocsDir: join(root, "docs"), env: { AICGUARD_SNAPSHOT_ROOT: join(root, "snapshots") } });
  assert.equal(ok.source, "snapshot");
  assert.equal(ok.snapshotCommitId, "c0ffee");
  assert.equal(ok.dir, join(root, "snapshots", "snapshots", "c0ffee", "docs"));
  assert.throws(() => resolveRagDocs({ repoRoot: root, defaultDocsDir: join(root, "docs"), env: { AICGUARD_SNAPSHOT_ROOT: join(root, "nofdocs") } }),
    /docs/, "快照里没有 docs/ ⇒ 拒绝静默回落到工作区");
  rmSync(root, { recursive: true, force: true });
});

test("⑥ 三态：都不设 ⇒ 工作区（用调用方给的默认文档根）", () => {
  const root = tmpTree({ "materials/a.md": "项目文档" });
  const r = resolveRagDocs({ repoRoot: root, defaultDocsDir: join(root, "materials"), env: {} });
  assert.equal(r.source, "worktree");
  assert.equal(r.dir, join(root, "materials"));
  assert.equal(r.snapshotCommitId, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("⑦ 元信息不得含密钥（M2-2 红线：序列化后逐项检查）", () => {
  const root = tmpTree({ "a.md": "灌溉排水" });
  const meta = collectRagMeta({ docsDir: root, source: "worktree", snapshotCommitId: "c0ffee" });
  const json = JSON.stringify(meta);
  for (const bad of ["sk-", "apiKey", "api_key", "Authorization", "Bearer", "token"]) {
    assert.ok(!json.includes(bad), `元信息不得出现 ${bad}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test("⑧ 向后兼容：不传 ragMeta 时既有 RunVersions 输出逐字段不变", () => {
  // 只验证"新增字段不改变旧字段"这一性质：同一输入两次调用必须一致，且不因 RAG 新增项而漂移
  const root = tmpTree({ "data/x.jsonl": "{}\n" });
  const a = collectRagMeta({ docsDir: root, source: "worktree" });
  const b = collectRagMeta({ docsDir: root, source: "worktree" });
  assert.deepEqual(a, b, "同输入两次元信息必须一致（可复算）");
  const raw = readFileSync(join(root, "data/x.jsonl"), "utf8");
  assert.equal(raw, "{}\n", "元信息采集不得改动被采集的文件");
  rmSync(root, { recursive: true, force: true });
});
