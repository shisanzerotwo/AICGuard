import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("留出门禁验证RAG显式例外，同时抓住默认发现留出集的回归", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-isolation-gate-"));
  const fixtureTs = join(dir, "ts");
  mkdirSync(join(fixtureTs, "scripts"), { recursive: true });
  cpSync(join(tsRoot, "src"), join(fixtureTs, "src"), { recursive: true });
  for (const f of ["holdout-lint.ts", "rag-eval.ts", "rag-isolation-check.ts"]) cpSync(join(tsRoot, "scripts", f), join(fixtureTs, "scripts", f));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("AICGUARD_") || /(?:API_KEY|TOKEN|SECRET)$/i.test(k)) delete env[k];
  const run = (label: string) => {
    const stem = join(dir, label);
    const r = spawnSync(process.execPath, [join(fixtureTs, "scripts/holdout-lint.ts"), "--require-holdout",
      "--dev", join(tsRoot, "../data"), "--holdout", join(tsRoot, "../holdout"), "--out", stem],
    { cwd: fixtureTs, env, encoding: "utf8", timeout: 30000 });
    assert.equal(r.error, undefined, r.error?.message);
    return { exit: r.status, report: JSON.parse(readFileSync(stem + ".json", "utf8")) };
  };
  try {
    const healthy = run("healthy");
    assert.equal(healthy.exit, 0, JSON.stringify(healthy.report.violations));
    assert.equal(healthy.report.checks.isolation.ragEntry.pass, true);
    assert.equal(healthy.report.checks.gate.manifestCheck.files, 16);
    const entry = join(fixtureTs, "scripts/rag-eval.ts");
    const original = readFileSync(entry, "utf8");
    const mutated = original.replace('defaultDocsDir: join(REPO_ROOT, "materials")', 'defaultDocsDir: join(REPO_ROOT, "holdout", "rag", "docs")');
    assert.notEqual(mutated, original, "阳性故障注入必须真的改变默认目录");
    writeFileSync(entry, mutated);
    const regression = run("default-regression");
    assert.equal(regression.exit, 1, "默认发现留出集必须被门禁拦下");
    assert.equal(regression.report.checks.isolation.ragEntry.pass, false);
    assert.ok(regression.report.violations.some((s: string) => s.includes("RAG") && s.includes("隔离")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
