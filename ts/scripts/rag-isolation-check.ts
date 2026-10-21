/** RAG 的显式留出集例外通过真实离线 CLI 验证，不以参数名词频判断隔离。 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function checkRagEntryIsolation(tsRoot: string) {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-rag-isolation-"));
  const checks: Array<{ name: string; pass: boolean; exit: number | null; error?: string }> = [];
  try {
    const fixtureTs = join(dir, "ts");
    mkdirSync(join(fixtureTs, "scripts"), { recursive: true });
    cpSync(join(tsRoot, "src"), join(fixtureTs, "src"), { recursive: true });
    cpSync(join(tsRoot, "scripts/rag-eval.ts"), join(fixtureTs, "scripts/rag-eval.ts"));
    const devDocs = join(dir, "materials"), heldDocs = join(dir, "holdout/rag/docs");
    mkdirSync(devDocs, { recursive: true });
    mkdirSync(heldDocs, { recursive: true });
    writeFileSync(join(devDocs, "dev.md"), "开发文档：滴灌压力。");
    const original = "隔离夹具：农技文档。";
    const heldFile = join(heldDocs, "held.md"), manifest = join(dir, "holdout/MANIFEST.json");
    writeFileSync(heldFile, original);
    writeFileSync(manifest, JSON.stringify({ files: [{ path: "rag/docs/held.md", sha256: createHash("sha256").update(original).digest("hex") }] }));
    const cases = join(dir, "empty.jsonl");
    writeFileSync(cases, "");
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("AICGUARD_") || /(?:API_KEY|TOKEN|SECRET)$/i.test(k)) delete env[k];
    Object.assign(env, { AICGUARD_BASE_URL: "http://127.0.0.1:9/v1", AICGUARD_API_KEY: "offline-isolation-only", AICGUARD_MODEL: "offline-isolation" });
    type Report = { meta: { docsDir: string }; holdout?: { explicit?: boolean; declaration?: string; manifestChecked?: number } };
    const run = (name: string, extra: string[], expected: (exit: number | null, stderr: string, report: Report | null) => boolean) => {
      const dest = join(dir, name);
      const r = spawnSync(process.execPath, [join(fixtureTs, "scripts/rag-eval.ts"), "--target", "offline", "--cases", cases, "--out", dest, ...extra],
        { cwd: fixtureTs, env, encoding: "utf8", timeout: 10000 });
      const file = join(dest, "rag-report.json");
      const report: Report | null = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
      const pass = !r.error && expected(r.status, r.stderr ?? "", report);
      checks.push({ name, pass, exit: r.status, ...(!pass ? { error: r.error?.message ?? r.stderr ?? "行为不符合隔离契约" } : {}) });
    };
    const selected = ["--docs-dir", heldDocs];
    const declared = [...selected, "--allow-holdout", "--holdout-declaration", "offline-isolation-contract"];
    run("default-development", [], (exit, _, report) => exit === 0 && report !== null
      && resolve(report.meta.docsDir) === resolve(devDocs) && !report.holdout);
    run("holdout-no-permission", selected, (exit, stderr, report) => exit !== 0 && /--allow-holdout/.test(stderr) && report === null);
    run("holdout-missing-declaration", [...selected, "--allow-holdout"], (exit, stderr, report) => exit !== 0 && /--holdout-declaration/.test(stderr) && report === null);
    run("holdout-missing-flag", [...selected, "--holdout-declaration", "offline-isolation-contract"],
      (exit, stderr, report) => exit === 2 && /--allow-holdout/.test(stderr) && report === null);
    run("declared-and-verified", declared, (exit, _, report) => exit === 0
      && report?.holdout?.explicit === true && report.holdout.declaration === "offline-isolation-contract" && report.holdout.manifestChecked === 1);
    writeFileSync(heldFile, original + "字节被改动");
    run("changed-bytes-refused", declared, (exit, stderr, report) => exit !== 0 && /哈希不符/.test(stderr) && report === null);
    writeFileSync(heldFile, original);
    rmSync(manifest);
    run("missing-manifest-refused", declared, (exit, stderr, report) => exit !== 0 && /MANIFEST/.test(stderr) && report === null);
    return { pass: checks.every(c => c.pass), checks };
  } catch (e) {
    return { pass: false, checks, error: (e as Error).message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
