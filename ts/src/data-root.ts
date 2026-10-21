/**
 * 语料根目录的**唯一解析入口**（M3-4，docs/21 §M3-4；契约 docs/15 §3.1「既有语料读取入口统一接入快照解析」）。
 *
 * 为什么必须统一：语料在 5 处各自 `join(TS_ROOT, "..", "data")`（run.ts / server.ts / agent-eval.ts /
 * fp-attrib.ts / evolve-probes.ts）。各自解析的结果是"读的是工作区当前内容"，一旦有了不可变快照，
 * 就会出现"评测读一个版本、报表读另一个版本"的**混读**。
 *
 * 优先级（显式 > 快照 > 工作区）：
 *   1. `AICGUARD_DATA_DIR`   —— 显式指定目录（对暂存快照跑回归/评测时用这个）；
 *   2. `AICGUARD_SNAPSHOT_ROOT` —— 指定快照根，**固定到 current.json 指向的那个提交**
 *      （`<root>/snapshots/<commitId>`），读取期间不再重新解析 ⇒ 禁止混读；
 *   3. 工作区 `data/`        —— 兼容旧路径（并在返回信息里标 source="worktree"，便于报告如实记录）。
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type DataRootSource = "explicit" | "snapshot" | "worktree";

export interface DataRootInfo {
  /** 实际用于读取的目录（语料所在的 data 目录） */
  dir: string;
  source: DataRootSource;
  /** source="snapshot" 时为固定的提交 id（报告/日志要如实记录"用的哪份语料"） */
  commitId?: string;
  /** 人类可读的一句话说明（写进报告/日志） */
  detail: string;
}

/**
 * 解析语料根目录。**一次解析、全程固定**：调用方拿到 `{dir, commitId}` 后就按它读取，
 * 不要在读取过程中再次调用本函数（那才会造成混读）。
 */
export function resolveDataRoot(opts: { repoRoot: string; env?: NodeJS.ProcessEnv }): DataRootInfo {
  const env = opts.env ?? process.env;

  // ① 显式目录（暂存快照 / 测试）
  const explicit = env.AICGUARD_DATA_DIR;
  if (explicit) {
    const dir = isAbsolute(explicit) ? explicit : resolve(opts.repoRoot, explicit);
    if (!existsSync(dir)) {
      throw new Error(`AICGUARD_DATA_DIR 指向的目录不存在：${dir}`);
    }
    // M3-4c（复核者建议）：两个变量同时设置时，explicit 静默赢 ⇒ 容易让人误以为"走了快照"。
    // 这里显式警告，并把它写进 detail（报告/日志可追溯）。
    if (env.AICGUARD_SNAPSHOT_ROOT) {
      process.stderr.write(
        "[data-root] 警告：AICGUARD_DATA_DIR 优先于 AICGUARD_SNAPSHOT_ROOT，本次读取【未】走快照；"
        + "若想读快照请取消 AICGUARD_DATA_DIR。\n",
      );
    }
    return {
      dir, source: "explicit",
      detail: `显式指定语料目录（AICGUARD_DATA_DIR）：${dir}`
        + (env.AICGUARD_SNAPSHOT_ROOT ? "；⚠️ 已设置 AICGUARD_SNAPSHOT_ROOT 但被 explicit 优先级掩盖，本次未走快照" : ""),
    };
  }

  // ② 快照：固定到 current.json 指向的提交
  const root = env.AICGUARD_SNAPSHOT_ROOT;
  if (root) {
    const snapRoot = isAbsolute(root) ? root : resolve(opts.repoRoot, root);
    const currentFile = join(snapRoot, "current.json");
    if (!existsSync(currentFile)) {
      throw new Error(
        `AICGUARD_SNAPSHOT_ROOT 下没有 current.json（尚无有效提交）：${snapRoot}\n`
        + `（相对路径按**仓库根**解析：repoRoot=${opts.repoRoot}；若路径在 ts/ 下请写成 "ts/runs/..." 或直接用绝对路径，\n`
        + `  本机实测过的写法：--root ts\\runs\\snapshots / AICGUARD_SNAPSHOT_ROOT=ts\\runs\\snapshots）`,
      );
    }
    let commitId = "";
    try {
      commitId = (JSON.parse(readFileSync(currentFile, "utf8")) as { commitId?: string }).commitId ?? "";
    } catch (e) {
      throw new Error(`快照指针不可解析（拒绝猜测，避免混读）：${currentFile}：${(e as Error).message}`);
    }
    if (!commitId) throw new Error(`快照指针里没有 commitId：${currentFile}`);
    const dir = join(snapRoot, "snapshots", commitId, "data");
    if (!existsSync(dir)) throw new Error(`提交 ${commitId} 的快照里没有 data/ 目录：${dir}`);
    return {
      dir, source: "snapshot", commitId,
      detail: `不可变快照提交 ${commitId}（AICGUARD_SNAPSHOT_ROOT=${snapRoot}）`,
    };
  }

  // ③ 工作区默认路径（兼容旧行为；如实标注来源）
  return {
    dir: join(opts.repoRoot, "data"), source: "worktree",
    detail: "工作区 data/（未启用快照；数字对应的是当前工作区内容）",
  };
}

/** 给报告/日志用的一行说明 */
export function dataRootSummary(info: DataRootInfo): string {
  return info.source === "snapshot"
    ? `语料来源：快照提交 ${info.commitId}（${info.dir}）`
    : `语料来源：${info.source}（${info.dir}）`;
}

/**
 * 写入前的守卫（**不抛错的版本**，供 HTTP 端点返回 4xx 用）：快照/显式目录都是"不该被就地改写"的
 * （写入必须走暂存 + 发布）。
 * 背景（M3-5 复核者拓出的边界）：最初只有 `evolve-probes --merge` 调了守卫，
 * 而 `/api/evolve/review`（v1 候选池写）与 `evolve-probes --generate/--autoreview` 没有 ⇒
 * 若环境变量没设或指向正式 data/，这些路径会写**正式候选池**（有锁串行化，但没有"拒写快照/显式目录"的硬保护）。
 */
export function writableDataRootCheck(info: DataRootInfo): { ok: boolean; reason?: string } {
  if (info.source === "snapshot") {
    return { ok: false, reason: `拒绝写入不可变快照（提交 ${info.commitId}）：合并/进化必须先写暂存目录，再用 scripts/publish-snapshot.ts 发布` };
  }
  if (info.source === "explicit") {
    return { ok: false, reason: `拒绝就地写入显式指定目录（${info.dir}）：请写暂存目录后走发布流程` };
  }
  return { ok: true };
}

/** 写入前的守卫：快照/显式目录都是"不该被就地改写"的（写入必须走暂存 + 发布） */
export function assertWritableDataRoot(info: DataRootInfo): void {
  const v = writableDataRootCheck(info);
  if (!v.ok) throw new Error(v.reason!);
}
