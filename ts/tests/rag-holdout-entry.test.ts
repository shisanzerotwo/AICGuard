/**
 * G-RAG-1（`docs/43`）：跑留出集必须**显式开关 + 非空声明**，且放行后逐文件核对 `MANIFEST` 哈希。
 *
 * 锁四条（都带阴阳对照）：
 *   ① 默认（不给开关）落在 `holdout/` 内 ⇒ **抛错**（不许静默放行）；
 *   ② 只给开关、声明为空 ⇒ **抛错**（M6 的例外是"显式声明"，不是"随手加个开关"）；
 *   ③ 开关 + 声明 ⇒ 放行，并核验冻结字节（篇数 = 5）；
 *   ④ **篡改一字节 ⇒ 抛"哈希不符"**（证明核验不恒真；在临时假 repo 上做，**绝不碰真留出集**）。
 * 另加阴性对照：不在 holdout 内的目录 ⇒ 行为不变且**不产生** `holdout` 字段（等价性纪律）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertDocsNotFromHoldout, loadRagDocs } from "../src/rag-corpus.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const HOLDOUT_DOCS = join(REPO_ROOT, "holdout", "rag", "docs");

test("G-RAG-1① 默认（无开关）：留出集文档目录必须抛错", () => {
  assert.throws(() => loadRagDocs({ repoRoot: REPO_ROOT, docsDir: HOLDOUT_DOCS }),
    /不得来自 holdout/, "默认必须硬拒（阴性对照）");
  assert.throws(() => assertDocsNotFromHoldout(HOLDOUT_DOCS, REPO_ROOT),
    /不得来自 holdout/, "守卫本身也必须拒");
});

test("G-RAG-1② 只给开关不给声明：同样抛错（不许“随手加个开关”）", () => {
  assert.throws(() => loadRagDocs({ repoRoot: REPO_ROOT, docsDir: HOLDOUT_DOCS, holdout: { allowHoldout: true } }),
    /非空声明/, "缺声明必须拒");
  assert.throws(() => loadRagDocs({ repoRoot: REPO_ROOT, docsDir: HOLDOUT_DOCS, holdout: { allowHoldout: true, declaration: "   " } }),
    /非空声明/, "全空白声明视同缺声明");
});

test("G-RAG-1③ 开关 + 声明：放行，且 MANIFEST 逐文件核验通过（真留出集只读）", () => {
  const loaded = loadRagDocs({
    repoRoot: REPO_ROOT, docsDir: HOLDOUT_DOCS,
    holdout: { allowHoldout: true, declaration: "M6 RAG 组：docs/42 期望表第 3 节" },
  });
  assert.equal(loaded.meta.docFiles.length, 5, "留出集 RAG 文档应为 5 篇");
  assert.ok(loaded.chunks.length > 0, "必须真的切出块");
  assert.equal(loaded.holdout?.explicit, true, "必须记录“显式放行”");
  assert.equal(loaded.holdout?.manifestChecked, 5, "必须逐文件核验 5 篇");
  assert.match(loaded.holdout?.declaration ?? "", /docs\/42/, "声明原样落盘（可回溯到期望表）");
});

test("G-RAG-1④ 篡改检测：内容改一字节 / 文件未登记 ⇒ 必须抛错（核验不恒真）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-holdout-verify-"));
  try {
    const repo = join(dir, "repo");
    const docsDir = join(repo, "holdout", "rag", "docs");
    mkdirSync(docsDir, { recursive: true });
    const body = "# 假留出集文档\n\n正常内容。\n";
    writeFileSync(join(docsDir, "a.md"), body, "utf8");
    const manifest = {
      files: [{ path: "rag/docs/a.md", sha256: createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex") }],
    };
    const manifestPath = join(repo, "holdout", "MANIFEST.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const opts = { repoRoot: repo, docsDir, holdout: { allowHoldout: true as const, declaration: "单测：假留出集" } };

    // 阳性对照：未篡改 ⇒ 通过
    assert.equal(loadRagDocs(opts).holdout?.manifestChecked, 1, "未篡改时核验必须通过");

    // 反例①：内容改一字节 ⇒ 哈希不符
    writeFileSync(join(docsDir, "a.md"), body.replace("正常内容", "被改内容"), "utf8");
    assert.throws(() => loadRagDocs(opts), /哈希不符/, "被改动的留出集必须拒跑");

    // 反例②：文件根本不在 MANIFEST 里 ⇒ 拒跑（不许“未登记也能跑”）
    writeFileSync(join(docsDir, "a.md"), body, "utf8");
    writeFileSync(manifestPath, JSON.stringify({ files: [] }, null, 2), "utf8");
    assert.throws(() => loadRagDocs(opts), /不在 MANIFEST\.files/, "未登记文件必须拒跑");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G-RAG-1 阴性对照：非 holdout 目录行为不变，且不产生 holdout 字段", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-rag-plain-"));
  try {
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "a.md"), "# 普通文档\n\n内容。\n", "utf8");
    const loaded = loadRagDocs({ repoRoot: REPO_ROOT, docsDir });
    assert.equal(loaded.meta.docFiles.length, 1);
    assert.equal(loaded.holdout, undefined, "非留出集目录不得出现 holdout 字段（产物逐字节等价）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
