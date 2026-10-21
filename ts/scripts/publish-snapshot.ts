/**
 * 快照发布/查看 CLI（M3-4，docs/21 §M3-4；契约 docs/15 §3.1 五步）。
 *
 * 它是"发布"这条路径的唯一入口：暂存 → 对**暂存快照**跑回归与评测 → 校验哈希 →
 * 写快照目录 → 写提交记录 → **原子替换指针**。任一步失败都不发布（旧提交继续生效）。
 *
 * 用法（快照根默认 ts/runs/snapshots；语料源默认按 src/data-root.ts 解析）：
 *   node scripts/publish-snapshot.ts --operator human:alice --reason "M3-4 首次发布"
 *   node scripts/publish-snapshot.ts --operator human:alice --reason "..." --with-eval     # 额外对暂存快照跑一次主评测
 *   node scripts/publish-snapshot.ts --log                      # 发布日志（由提交记录生成）
 *   node scripts/publish-snapshot.ts --current                  # 当前有效提交 + 文件清单
 *   node scripts/publish-snapshot.ts --verify [<commitId>]      # 校验快照与记录一致性
 *   node scripts/publish-snapshot.ts --unpublished              # 未发布残留（暂存/孤立快照）
 *   node scripts/publish-snapshot.ts --cleanup --operator human:alice --reason "清理失败发布的残留"
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataRoot } from "../src/data-root.ts";
import {
  cleanupUnpublished,
  listUnpublished,
  openSnapshot,
  publishSnapshot,
  renderReleaseLog,
  resolveCurrentCommit,
  verifySnapshot,
} from "../src/snapshot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const REPO_ROOT = join(TS_ROOT, "..");

const argv = process.argv.slice(2);
const has = (n: string): boolean => argv.includes(n);
const argOf = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

const rootArg = argOf("--root");
const ROOT = rootArg
  ? resolve(isAbsolute(rootArg) ? rootArg : join(process.cwd(), rootArg))
  : join(TS_ROOT, "runs", "snapshots");

const fail = (msg: string): void => { process.stderr.write(msg + "\n"); process.exitCode = 2; };

/** 语料文件白名单：只把这些文件纳入快照（候选池单独纳入，见下） */
const CORPUS_FILES = [
  "probes_zh.jsonl", "probes_mt_zh.jsonl", "probes_agro.jsonl", "probes_garak_mt.jsonl",
  "probes_tool_abuse.jsonl", "probes_workloop.jsonl", "benign_zh.jsonl", "sanity_positive.jsonl",
];

function collectSources(dataDir: string): Array<{ from: string; rel: string }> {
  const sources: Array<{ from: string; rel: string }> = [];
  for (const f of CORPUS_FILES) {
    const from = join(dataDir, f);
    if (existsSync(from)) sources.push({ from, rel: `data/${f}` });
  }
  const candidates = join(dataDir, "probes_candidates.jsonl");
  if (existsSync(candidates)) sources.push({ from: candidates, rel: "data/probes_candidates.jsonl" });
  return sources;
}

/** 对暂存快照跑门禁：把暂存目录当成"语料目录"喂给现有门禁（不读工作区） */
function runGatesOn(stagingDir: string, opts: { withEval: boolean }): { ok: boolean; detail: string } {
  const dataDir = join(stagingDir, "data");
  const details: string[] = [];
  try {
    const gateOut = execFileSync(process.execPath, [join(TS_ROOT, "scripts", "fp-regression.ts")], {
      env: { ...process.env, AICGUARD_DATA_DIR: dataDir },
      cwd: TS_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const summary = gateOut.split(/\r?\n/).filter((l) => /阴性误拦|输入侧拦截/.test(l)).join(" ｜ ");
    details.push(`误报回归通过（${summary || "无摘要"}）`);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, detail: `误报回归失败：${(err.stdout ?? "") + (err.stderr ?? "") || err.message}` };
  }
  try {
    execFileSync(process.execPath, [join(TS_ROOT, "scripts", "harness-sanity.ts")], {
      env: { ...process.env, AICGUARD_DATA_DIR: dataDir },
      cwd: TS_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    details.push("阳性自检通过");
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, detail: `阳性自检失败：${(err.stdout ?? "") + (err.stderr ?? "") || err.message}` };
  }

  if (opts.withEval) {
    const outDir = join(TS_ROOT, "runs", "publish-gate-eval");
    rmSync(outDir, { recursive: true, force: true });
    try {
      execFileSync(process.execPath, [join(TS_ROOT, "src", "run.ts"), "--profile", "full", "--out", outDir], {
        env: { ...process.env, AICGUARD_DATA_DIR: dataDir },
        cwd: TS_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      const m = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8")).metrics as { baseline_asr: number; guarded_asr: number };
      details.push(`主评测跑通（baseline_asr ${m.baseline_asr} / guarded_asr ${m.guarded_asr}）`);
    } catch (e) {
      // run.ts 在有 high findings 时按设计返回 1：报告生成即视为跑通，需区分"没跑起来"与"跑到了失守"
      const err = e as { status?: number; stdout?: string };
      const report = join(outDir, "report.json");
      if (err.status === 1 && existsSync(report)) {
        const m = JSON.parse(readFileSync(report, "utf8")).metrics as { baseline_asr: number; guarded_asr: number };
        details.push(`主评测跑通（含 high findings，run.ts 退出码 1 属设计行为；baseline_asr ${m.baseline_asr} / guarded_asr ${m.guarded_asr}）`);
      } else {
        return { ok: false, detail: `主评测未跑通：${err.stdout ?? ""}` };
      }
    }
  }
  return { ok: true, detail: details.join("；") };
}

function main(): void {
  if (has("--help") || argv.length === 0) {
    process.stdout.write(readFileSync(join(HERE, "publish-snapshot.ts"), "utf8").split("*/")[0] + "*/\n");
    return;
  }

  if (has("--log")) {
    process.stdout.write(renderReleaseLog(ROOT));
    return;
  }
  if (has("--current")) {
    const cur = resolveCurrentCommit(ROOT);
    if (!cur) return void fail(`当前没有有效提交（${ROOT}）`);
    const snap = openSnapshot(ROOT)!;
    console.log(`当前有效提交：${cur.commitId}`);
    console.log(`发布者：${cur.commit.operator} ｜ 父提交：${cur.commit.parentCommitId ?? "（首次）"}`);
    console.log(`corpusHash：${cur.commit.corpusHash}`);
    console.log(`门禁：${cur.commit.gates?.ok ? "通过" : "未通过/未记录"} ｜ ${cur.commit.gates?.detail ?? ""}`);
    console.log(`文件（${snap.listFiles().length}）：`);
    for (const f of snap.listFiles()) console.log(`  - ${f}`);
    return;
  }
  if (has("--verify")) {
    const idArg = argOf("--verify");
    const ids = idArg ? [idArg] : (resolveCurrentCommit(ROOT) ? [resolveCurrentCommit(ROOT)!.commitId] : []);
    if (!ids.length) return void fail("没有可校验的提交");
    let bad = 0;
    for (const id of ids) {
      const v = verifySnapshot(ROOT, id);
      if (!v.ok) bad++;
      console.log(`${v.ok ? "✅" : "❌"} ${id}${v.ok ? " 与提交记录一致" : ` 问题：${v.problems.join("; ")}`}`);
    }
    if (bad) process.exitCode = 1;
    return;
  }
  if (has("--unpublished")) {
    console.log(JSON.stringify(listUnpublished(ROOT), null, 2));
    return;
  }
  if (has("--cleanup")) {
    const operator = argOf("--operator") ?? "";
    const reason = argOf("--reason") ?? "";
    if (!operator.startsWith("human:")) return void fail("--operator 必须是 human:<name>");
    if (!reason) return void fail("--reason 必填（清理要留审计）");
    const r = cleanupUnpublished(ROOT, { operator, reason });
    console.log(`已清理 ${r.removed.length} 项：${r.removed.join(", ") || "（无）"}；审计：${r.audit}`);
    return;
  }

  // ── 发布 ──
  const operator = argOf("--operator") ?? "";
  const reason = argOf("--reason") ?? "";
  if (!operator.startsWith("human:")) return void fail("--operator 必须是 human:<name>（发布是人的决定）");
  if (!reason) return void fail("--reason 必填（发布说明）；带上来源/目的便于事后追溯");

  const dataDirArg = argOf("--data");
  const dataInfo = dataDirArg
    ? { dir: resolve(isAbsolute(dataDirArg) ? dataDirArg : join(process.cwd(), dataDirArg)), source: "explicit" as const, detail: `--data ${dataDirArg}` }
    : resolveDataRoot({ repoRoot: REPO_ROOT });
  const sources = collectSources(dataInfo.dir);
  if (!sources.length) return void fail(`语料目录里没有可发布的文件：${dataInfo.dir}`);

  const withEval = has("--with-eval");
  console.log(`发布快照：`);
  console.log(`  快照根：${ROOT}`);
  console.log(`  语料源：${dataInfo.detail}`);
  console.log(`  文件：${sources.map((s) => basename(s.from)).join(", ")}`);
  console.log(`  发布者：${operator} ｜ 说明：${reason} ｜ 额外跑主评测：${withEval ? "是" : "否"}`);

  const before = resolveCurrentCommit(ROOT);
  const res = publishSnapshot({
    root: ROOT,
    sources,
    reason,
    operator,
    gates: (stagingDir) => runGatesOn(stagingDir, { withEval }),
    audit: [`来源：${dataInfo.detail}`],
    hooks: {},
  });
  if (!res.ok) return void fail(`❌ 未发布：${res.error}`);
  const after = resolveCurrentCommit(ROOT);
  console.log(`✅ 已发布提交 ${res.commitId}${res.reused ? "（同内容复用，未改写任何东西）" : ""}`);
  console.log(`   父提交：${before?.commitId ?? "（首次）"} → 当前：${after?.commitId}`);
  if (after) console.log(`   门禁：${after.commit.gates?.detail}`);
  console.log(`   发布日志：node scripts/publish-snapshot.ts --root ${rootArg ?? "ts/runs/snapshots"} --log`);
}

main();

void readdirSync;
