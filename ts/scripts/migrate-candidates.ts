/**
 * 候选池迁移 CLI（M3-2，docs/21 §M3-2）：schema v1 → v2。
 *
 * 默认 **dry-run**：只读输入、打印汇总与逐条 blocker，**不写任何文件**。
 * `--write <path>` 时才把迁移结果写到指定路径（供 M3-4 的快照暂存区使用）；
 * **不允许**直接覆盖 `data/probes_candidates.jsonl`（发布属 M3-4 的快照流程，见 docs/15 §3.1）。
 *
 * 用法：
 *   node scripts/migrate-candidates.ts                       # dry-run，汇总到 stdout
 *   node scripts/migrate-candidates.ts --write <out.jsonl>   # 写迁移结果（保持输入不变）
 *   node scripts/migrate-candidates.ts --input <in.jsonl> --write <out.jsonl>
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateCandidates, verifyDistributionPreserved, type CandidateV1 } from "../src/candidates.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const DEFAULT_INPUT = join(TS_ROOT, "..", "data", "probes_candidates.jsonl");

const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/**
 * 以退出码 2 终止。
 * ⚠️ 不用 `console.error + process.exit(2)`：Windows 上在 stdio flush 期间同步退出会触发 libuv 断言
 *（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码被篡改成 0xC0000409），
 * 让 CI/复核者把"拒绝执行"误读成"进程崩溃"（M3-2 独立复核发现 D.2）。
 * 改为写 stderr + 置 exitCode，让进程自然结束；调用方必须 return。
 */
function refuse(msg: string): void {
  process.stderr.write(msg + "\n");
  process.exitCode = 2;
}

function main(): void {
  const input = argOf("--input") ?? DEFAULT_INPUT;
  const writeTo = argOf("--write");
  const dryRun = !writeTo;

  if (!existsSync(input)) {
    refuse(`输入不存在：${input}`);
    return;
  }

  // 安全检查：绝不直接覆盖正式候选池（发布由 M3-4 的快照流程负责）
  if (writeTo) {
    const target = isAbsolute(writeTo) ? resolve(writeTo) : resolve(process.cwd(), writeTo);
    const canonical = resolve(DEFAULT_INPUT);
    if (target === canonical) {
      refuse("拒绝执行：不允许直接覆盖 data/probes_candidates.jsonl（发布属 M3-4 快照流程）");
      return;
    }
  }

  const lines = readFileSync(input, "utf8").trim().split(/\r?\n/).filter((l) => l.trim());
  const raw: CandidateV1[] = [];
  for (const [i, l] of lines.entries()) {
    try {
      raw.push(JSON.parse(l) as CandidateV1);
    } catch (e) {
      refuse(`第 ${i + 1} 行 JSON 解析失败：${(e as Error).message}`);
      return;
    }
  }

  const { items, summary } = migrateCandidates(raw);
  const dist = verifyDistributionPreserved(summary);

  console.log(`输入：${input}`);
  console.log(`模式：${dryRun ? "dry-run（不写文件）" : `写迁移结果 → ${writeTo}`}`);
  console.log(`条数：${summary.total}（其中已是 v2：${summary.alreadyV2}）`);
  console.log(`状态分布（迁移前）：${JSON.stringify(summary.statusBeforeMigration)}`);
  console.log(`状态分布（迁移后）：${JSON.stringify(summary.statusAfterMigration)}`);
  console.log(`审核来源：结构化 ${summary.provenanceRecorded} / **仅自由文本 ${summary.provenanceInNotes}** / 未知 ${summary.provenanceLegacy}`);
  console.log(`解析到 AI 代审痕迹：${summary.aiTraceParsed} 条（其中与状态冲突 ${summary.aiTraceConflicts} 条）`);
  console.log(`待复核（旧 approved）：${summary.needsRecheck}`);
  console.log(`判据来源：${JSON.stringify(summary.judgeSource)}`);
  console.log(`合并阻断项：${JSON.stringify(summary.blockers)}`);
  console.log(`分布自检：${dist.ok ? "✅" : "❌"} ${dist.reason}`);

  if (!dist.ok) {
    process.exitCode = 1;
    return;
  }

  if (writeTo) {
    const target = isAbsolute(writeTo) ? writeTo : join(process.cwd(), writeTo);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, items.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");
    console.log(`已写出：${target}`);
  } else {
    const blockedPreview = items.filter((c) => !c.merge.autoMergeable);
    console.log(`\n可自动合并：${items.length - blockedPreview.length} / ${items.length}；被阻断 ${blockedPreview.length} 条（预览前 5 条）：`);
    for (const c of blockedPreview.slice(0, 5)) {
      console.log(`  - ${c.id}［${c.family}/${c.goal}］status=${c.status} blockers=${c.merge.blockers.join(",")}`);
    }
  }
}

main();
