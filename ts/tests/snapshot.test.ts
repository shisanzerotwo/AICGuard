/**
 * M3-4a 验收测试：不可变快照与单一提交记录（docs/21 §M3-4；契约 docs/15 §3.1 五步）。
 *
 * 覆盖的硬性验收：
 *   1. 快照**不可变**：同一提交重复读取逐字节相同；旧提交在新发布后仍逐字节不变；
 *      "同内容重复发布"幂等（同一 commitId，不重写）；"不同内容覆盖同名提交"被拒；
 *   2. **单一提交记录 + 指针**：读者通过 current.json → 提交记录 → 快照目录读取，禁止混读
 *      （跨提交/越界读取被 `openSnapshotAt` 的清单守卫拒绝）；
 *   3. **四类故障注入**：
 *      ① 门禁失败 ⇒ 不发布、旧提交继续生效；
 *      ② 写文件失败（暂存/记录阶段抛错）⇒ 不发布、暂存清理、旧提交继续生效；
 *      ③ **发布前中断**（换指针之前抛错）⇒ 旧提交继续生效，未发布残留可查可清；
 *      ④ **发布后中断**（换指针之后抛错）⇒ 新提交完整可用（记录先于指针写入）；
 *   4. **Windows 文件占用**：指针文件被占 ⇒ 拒绝发布并保持旧提交；
 *   5. 发布日志**由提交记录生成**（不是独立事务）；
 *   6. 发布必须由 `human:*` 发起。
 *
 * 全部离线；临时目录在系统 temp，**不触碰 data/ 与仓库 snapshots/**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupUnpublished,
  computeCommitId,
  listUnpublished,
  openSnapshot,
  openSnapshotAt,
  publishSnapshot,
  renderReleaseLog,
  resolveCurrentCommit,
  verifySnapshot,
  type SnapshotEntry,
} from "../src/snapshot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "aicguard-m34-"));
const ROOT = join(TMP, "snapshots-root");
const WORK = join(TMP, "work");

/** 造一份"工作区"：两个语料文件 + 候选池 */
function makeWorkspace(marker: string): { sources: Array<{ from: string; rel: string }>; dir: string } {
  const dir = join(WORK, marker);
  const files: Record<string, string> = {
    "data/probes_zh.jsonl": `{"id":"P-01","text":"${marker} 一号"}\n{"id":"P-02","text":"${marker} 二号"}\n`,
    "data/benign_zh.jsonl": `{"id":"B-01","text":"${marker} 正常请求"}\n`,
    "data/probes_candidates.jsonl": `{"schemaVersion":2,"id":"EV-01","version":1,"status":"approved","review":{"mode":"manual_confirm","by":"human:alice"}}\n`,
  };
  const sources: Array<{ from: string; rel: string }> = [];
  for (const [rel, content] of Object.entries(files)) {
    const from = join(dir, rel);
    mkdirSync(dirname(from), { recursive: true });
    writeFileSync(from, content, "utf8");
    sources.push({ from, rel });
  }
  return { sources, dir };
}

const okGates = (): { ok: boolean; detail: string } => ({ ok: true, detail: "门禁通过（stub）" });
const failGates = (): { ok: boolean; detail: string } => ({ ok: false, detail: "阴性误拦 12/105（stub 故意失败）" });

test("发布 → 打开：读者固定同一提交，且内容与提交记录一致", () => {
  const ws = makeWorkspace("v1");
  const r = publishSnapshot({ root: ROOT, sources: ws.sources, reason: "首次发布", operator: "human:alice", gates: okGates });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.commitId, "发布成功必须给出 commitId");
  const published = r.commitId!;
  const cur = resolveCurrentCommit(ROOT);
  assert.equal(cur?.commitId, published);
  assert.equal(cur?.commit.parentCommitId, null);
  assert.equal(cur?.commit.operator, "human:alice");
  assert.equal(cur?.commit.gates?.ok, true);

  const snap = openSnapshot(ROOT)!;
  assert.equal(snap.commitId, published);
  assert.match(snap.read("data/probes_zh.jsonl"), /v1 一号/);
  assert.deepEqual(snap.readJsonl<{ id: string }>("data/probes_zh.jsonl").map((x) => x.id), ["P-01", "P-02"]);
  assert.equal(snap.readCandidates()[0]!.id, "EV-01");
  assert.ok(snap.listFiles().includes("data/benign_zh.jsonl"));
  assert.equal(verifySnapshot(ROOT, published).ok, true);
});

test("不可变：新发布不改变旧提交（逐字节）；重复读取同一提交逐字节相同", () => {
  const ws1 = makeWorkspace("v1");
  const r1 = publishSnapshot({ root: ROOT, sources: ws1.sources, reason: "第一次", operator: "human:alice", gates: okGates });
  const old = openSnapshotAt(ROOT, r1.commitId!)!;
  const oldBytes = old.read("data/probes_zh.jsonl");

  const ws2 = makeWorkspace("v2");
  const r2 = publishSnapshot({ root: ROOT, sources: ws2.sources, reason: "第二次", operator: "human:bob", gates: okGates });
  assert.equal(r2.ok, true, r2.error);
  assert.notEqual(r2.commitId, r1.commitId, "内容变了 ⇒ 提交 id 必须变");
  assert.equal(resolveCurrentCommit(ROOT)?.commit.commitId, r2.commitId);
  assert.equal(resolveCurrentCommit(ROOT)?.commit.parentCommitId, r1.commitId, "新提交要记录父提交");

  // 旧提交仍然可按 id 打开，且逐字节未变
  const oldAgain = openSnapshotAt(ROOT, r1.commitId!)!;
  assert.equal(oldAgain.read("data/probes_zh.jsonl"), oldBytes, "旧快照必须逐字节不变");
  assert.equal(verifySnapshot(ROOT, r1.commitId!).ok, true);
  // 新提交内容是新内容
  assert.match(openSnapshot(ROOT)!.read("data/probes_zh.jsonl"), /v2 一号/);

  // 幂等：同内容再发布 ⇒ 同一 id、复用、不重写
  const ws2b = makeWorkspace("v2");
  const r2b = publishSnapshot({ root: ROOT, sources: ws2b.sources, reason: "同内容再发布", operator: "human:bob", gates: okGates });
  assert.equal(r2b.ok, true);
  assert.equal(r2b.commitId, r2.commitId);
  assert.equal(r2b.reused, true);
});

test("带 audit 的重复发布仍幂等（审计含时间戳，不得参与内容寻址）", () => {
  const ws = makeWorkspace("v-audit");
  const r1 = publishSnapshot({
    root: ROOT, sources: ws.sources, reason: "带审计发布", operator: "human:alice", gates: okGates,
    audit: ["候选 EV-01 由 approved 转为 pending（示例）"],
  });
  assert.equal(r1.ok, true, r1.error);
  const ws2 = makeWorkspace("v-audit");
  const r2 = publishSnapshot({
    root: ROOT, sources: ws2.sources, reason: "同内容再次发布（audit 不同时间戳）", operator: "human:alice", gates: okGates,
    audit: ["另一条审计说明（时间戳必然不同）"],
  });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.commitId, r1.commitId, "审计记录含时间戳，绝不能让它改变提交身份");
  assert.equal(r2.reused, true);
  // 审计信息要留在提交记录里（可追溯），而不是当一个会变的文件
  const cur = resolveCurrentCommit(ROOT)!;
  assert.ok(cur.commit.audit.some((a) => a.includes("候选 EV-01")));
  assert.equal(existsSync(join(ROOT, "snapshots", r1.commitId!, "audit.jsonl")), false, "审计不应落成快照内文件");
});

test("禁止混读：越界/跨提交读取被拒", () => {
  const ws = makeWorkspace("v1");
  const r = publishSnapshot({ root: ROOT, sources: ws.sources, reason: "混读守卫", operator: "human:alice", gates: okGates });
  const snap = openSnapshotAt(ROOT, r.commitId!)!;
  assert.throws(() => snap.read("data/not-in-commit.jsonl"), /不在提交 .* 的清单里/);
  assert.throws(() => snap.read("../outside.txt"), /不在提交 .* 的清单里/);
});

test("故障注入①门禁失败 ⇒ 不发布、旧提交继续生效", () => {
  const ws1 = makeWorkspace("v1");
  const r1 = publishSnapshot({ root: ROOT, sources: ws1.sources, reason: "稳定版", operator: "human:alice", gates: okGates });
  const ws2 = makeWorkspace("v2-bad");
  const bad = publishSnapshot({ root: ROOT, sources: ws2.sources, reason: "门禁会失败", operator: "human:alice", gates: failGates });
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /门禁未通过/);
  assert.equal(resolveCurrentCommit(ROOT)?.commitId, r1.commitId, "旧提交必须继续生效");
  assert.equal(openSnapshot(ROOT)!.read("data/probes_zh.jsonl").includes("v2-bad"), false);
  assert.deepEqual(listUnpublished(ROOT).staging, [], "门禁失败后暂存必须清理");
});

test("故障注入②写文件失败（记录写入抛错）⇒ 不发布、旧提交继续生效", () => {
  const ws1 = makeWorkspace("v1");
  const r1 = publishSnapshot({ root: ROOT, sources: ws1.sources, reason: "稳定版", operator: "human:alice", gates: okGates });
  const ws2 = makeWorkspace("v2-broken");
  const r2 = publishSnapshot({
    root: ROOT, sources: ws2.sources, reason: "记录写入失败", operator: "human:alice", gates: okGates,
    hooks: { beforeCommitRecord: () => { throw new Error("模拟磁盘写失败"); } },
  });
  assert.equal(r2.ok, false);
  assert.match(String(r2.error), /发布中断/);
  assert.equal(resolveCurrentCommit(ROOT)?.commitId, r1.commitId);
  const unpub = listUnpublished(ROOT);
  assert.deepEqual(unpub.orphanSnapshots, [], "未发布的快照目录必须被清理（或至少不被指针引用）");
  assert.equal(verifySnapshot(ROOT, r1.commitId!).ok, true, "旧提交必须仍然完整");
});

test("故障注入③发布前中断（换指针前抛错）⇒ 旧提交继续生效，残留可查可清", () => {
  const ws1 = makeWorkspace("v1");
  const r1 = publishSnapshot({ root: ROOT, sources: ws1.sources, reason: "稳定版", operator: "human:alice", gates: okGates });
  const ws2 = makeWorkspace("v2-pre-interrupt");
  const r2 = publishSnapshot({
    root: ROOT, sources: ws2.sources, reason: "发布前中断", operator: "human:alice", gates: okGates,
    hooks: { beforePointerSwap: () => { throw new Error("模拟发布前中断"); } },
  });
  assert.equal(r2.ok, false);
  assert.match(String(r2.error), /指针替换失败|发布中断/);
  assert.equal(resolveCurrentCommit(ROOT)?.commitId, r1.commitId, "指针未动 ⇒ 旧提交继续生效");
  assert.equal(openSnapshot(ROOT)!.read("data/probes_zh.jsonl").includes("v2-pre-interrupt"), false);

  const unpub = listUnpublished(ROOT);
  const leftovers = unpub.orphanSnapshots.length + unpub.staging.length;
  assert.ok(leftovers >= 0);
  const cleaned = cleanupUnpublished(ROOT, { operator: "human:alice", reason: "清理发布前中断残留" });
  assert.equal(existsSync(cleaned.audit), true, "清理必须留审计");
  assert.deepEqual(listUnpublished(ROOT).orphanSnapshots, []);
  assert.equal(resolveCurrentCommit(ROOT)?.commitId, r1.commitId, "清理不得影响已发布提交");
  assert.equal(verifySnapshot(ROOT, r1.commitId!).ok, true);
});

test("故障注入④发布后中断（换指针后抛错）⇒ 新提交完整可用（记录先于指针）", () => {
  const ws1 = makeWorkspace("v1");
  const r1 = publishSnapshot({ root: ROOT, sources: ws1.sources, reason: "稳定版", operator: "human:alice", gates: okGates });
  const ws2 = makeWorkspace("v2-post-interrupt");
  const r2 = publishSnapshot({
    root: ROOT, sources: ws2.sources, reason: "发布后中断", operator: "human:alice", gates: okGates,
    hooks: { afterPointerSwap: () => { throw new Error("模拟发布后中断（换指针之后）"); } },
  });
  // 换指针已成功 ⇒ 虽然后续抛错，但新提交必须完整（记录先写、指针后换）
  assert.equal(r2.ok, false, "调用方会看到异常，但状态必须是完整的新提交");
  const cur = resolveCurrentCommit(ROOT);
  assert.notEqual(cur?.commitId, r1.commitId, "指针已换 ⇒ 当前是新提交");
  assert.equal(verifySnapshot(ROOT, cur!.commitId).ok, true, "新提交必须完整（不存在半成品）");
  const snap = openSnapshot(ROOT)!;
  assert.match(snap.read("data/probes_zh.jsonl"), /v2-post-interrupt/);
  assert.equal(snap.readJsonl("data/probes_zh.jsonl").length, 2);
  assert.equal(verifySnapshot(ROOT, r1.commitId!).ok, true, "旧提交也仍然完整");
});

test("Windows 文件占用：指针被占 ⇒ 拒绝发布并保持旧提交", async () => {
  const ws1 = makeWorkspace("v1");
  const r1 = publishSnapshot({ root: ROOT, sources: ws1.sources, reason: "稳定版", operator: "human:alice", gates: okGates });
  const currentFile = join(ROOT, "current.json");

  const holder = join(TMP, "hold.mjs");
  writeFileSync(holder, `import { openSync } from "node:fs";\nopenSync(${JSON.stringify(currentFile)}, "r");\nprocess.stdout.write("HELD\\n");\nsetTimeout(()=>{}, 8000);\n`, "utf8");
  const child = spawn(process.execPath, [holder], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((r) => child.stdout.once("data", () => r()));

  const ws2 = makeWorkspace("v2-locked");
  const r2 = publishSnapshot({ root: ROOT, sources: ws2.sources, reason: "指针被占用", operator: "human:alice", gates: okGates });
  child.kill();

  assert.equal(r2.ok, false, "指针被占用时必须拒绝发布");
  assert.match(String(r2.error), /指针替换失败|原子写失败|EPERM|EACCES|EBUSY/);
  assert.equal(resolveCurrentCommit(ROOT)?.commitId, r1.commitId, "旧提交必须继续生效");
  assert.equal(openSnapshot(ROOT)!.read("data/probes_zh.jsonl").includes("v2-locked"), false);
  assert.equal(verifySnapshot(ROOT, r1.commitId!).ok, true);
});

test("发布必须由 human:* 发起；日志由提交记录生成", () => {
  const ws = makeWorkspace("v1");
  const denied = publishSnapshot({ root: ROOT, sources: ws.sources, reason: "AI 想发布", operator: "ai:jev", gates: okGates });
  assert.equal(denied.ok, false);
  assert.match(String(denied.error), /必须由人工发起/);

  const log = renderReleaseLog(ROOT);
  assert.match(log, /发布日志（由提交记录生成）/);
  assert.match(log, /当前有效提交/);
  assert.match(log, /human:/);
  // 日志是派生物：不写盘、不构成独立事务
  assert.equal(existsSync(join(ROOT, "release-log.md")), false);
});

test("同内容 ⇒ 同 commitId（与父提交无关）；父提交只记在提交记录里", () => {
  const entries: SnapshotEntry[] = [{ rel: "data/x.jsonl", sha256: "a".repeat(64), bytes: 1 }];
  assert.equal(computeCommitId(entries), computeCommitId(entries), "同输入必须同输出");
  const other: SnapshotEntry[] = [{ rel: "data/x.jsonl", sha256: "b".repeat(64), bytes: 1 }];
  assert.notEqual(computeCommitId(entries), computeCommitId(other), "内容变 ⇒ id 必须变");
  // 父提交不参与身份（否则“同内容再发布”会拿到新 id、幂等失效）
  assert.match(computeCommitId(entries), /^[0-9a-f]{16}$/);
});

test("篡改检测：清单外多出的文件必须被抓出（_verify 双向核对，M3-4c）", () => {
  const ws = makeWorkspace("v-extra");
  const r = publishSnapshot({ root: ROOT, sources: ws.sources, reason: "双向核对", operator: "human:alice", gates: okGates });
  assert.equal(r.ok, true, r.error);
  const id = r.commitId!;
  assert.equal(verifySnapshot(ROOT, id).ok, true, "未篡改时必须通过");
  // ① 改内容字节
  const target = join(ROOT, "snapshots", id, "data", "probes_zh.jsonl");
  writeFileSync(target, readFileSync(target, "utf8") + '{"id":"INJECTED"}\n', "utf8");
  let v = verifySnapshot(ROOT, id);
  assert.equal(v.ok, false, "内容被改必须被检出");
  assert.ok(v.problems.some((x) => x.includes("哈希不符")), v.problems.join("; "));
  // ② 塞一个清单外的额外文件（早期实现漏检）
  // 注意：必须换一份**不同内容**再发布（v-extra2）——用相同内容会被不可变性护栏拒绝（上面那次篡改已让同名提交内容不一致）
  const ws2 = makeWorkspace("v-extra2");
  const r2 = publishSnapshot({ root: ROOT, sources: ws2.sources, reason: "双向核对-2", operator: "human:alice", gates: okGates });
  assert.equal(r2.ok, true, r2.error);
  const id2 = r2.commitId!;
  writeFileSync(join(ROOT, "snapshots", id2, "data", "sneaked-in.jsonl"), '{"id":"SNEAK"}\n', "utf8");
  v = verifySnapshot(ROOT, id2);
  assert.equal(v.ok, false, "清单外的额外文件必须被检出（不可变快照不应多出文件）");
  assert.ok(v.problems.some((x) => x.includes("清单外的文件")), v.problems.join("; "));
  // 删除该文件后应恢复通过（证明不是恒假）
  rmSync(join(ROOT, "snapshots", id2, "data", "sneaked-in.jsonl"), { force: true });
  assert.equal(verifySnapshot(ROOT, id2).ok, true, "移除额外文件后应恢复通过");
  // MANIFEST.json 是发布时写的自校验清单，必须被放过（否则所有快照都会误报）
  assert.equal(verifySnapshot(ROOT, id2).problems.some((x) => x.includes("MANIFEST")), false);
});

test("清理临时目录（必须放最后）", () => {
  rmSync(TMP, { recursive: true, force: true });
  assert.equal(existsSync(TMP), false);
  void openSync; void readdirSync; void readFileSync;
});
