import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("控制台HTTP读取：partial原因、执行覆盖、结论未知与完整对照分别保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-console-partial-"));
  const ids = [`workloop-999999-${process.pid}-partial`, `workloop-999999-${process.pid}-healthy`, `web-999999-${process.pid}-partial`];
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const data = join(dir, "data"); mkdirSync(data);
    for (const [i, id] of ids.entries()) {
      const p = join(root, "runs", id); mkdirSync(p, { recursive: true });
      const partial = i !== 1;
      writeFileSync(join(p, "report.json"), JSON.stringify({ schemaVersion: 2, partial, partialReasons: partial ? ["预算中止：exhausted <test>"] : [],
        complete: !partial, conclusionComplete: !partial, conclusionCoverage: { computed: partial ? 0 : 1, total: 1 },
        budget: { aborted: partial, executed: partial ? 1 : 2, unexecuted: partial ? 1 : 0, totalSlots: 2 },
        baseline: { usable: !partial, meanTokens: partial ? null : 18 }, metrics: {} }));
    }
    const portProbe = createServer();
    await new Promise<void>(ok => portProbe.listen(0, "127.0.0.1", ok));
    const chosenPort = (portProbe.address() as { port: number }).port;
    await new Promise<void>(ok => portProbe.close(() => ok()));
    child = spawn(process.execPath, [join(root, "src/server.ts")], { cwd: root, env: { ...process.env,
      AICGUARD_PORT: String(chosenPort), AICGUARD_DATA_DIR: data, AICGUARD_BASE_URL: "http://127.0.0.1:9/v1", AICGUARD_API_KEY: "offline" }, stdio: ["ignore", "pipe", "pipe"] });
    const port = await new Promise<number>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("console not ready")), 8000);
      child!.on("error", fail);
      child!.stdout!.on("data", (b: Buffer) => { const m = /127\.0\.0\.1:(\d+)/.exec(b.toString()); if (m) { clearTimeout(timer); ok(Number(m[1])); } });
    });
    assert.equal(port, chosenPort, "观察者必须连到已确认的隔离端口");
    const res = await fetch(`http://127.0.0.1:${port}/api/runs`);
    const { runs } = await res.json() as { runs: Array<{ runId: string; partial: boolean; partialReasons: string[]; execution: { unexecuted: number }; conclusionComplete: boolean; baselineMeanTokens: number | null }> };
    for (const [i,id] of ids.entries()) {
      const row = runs.find(r => r.runId === id)!;
      assert.ok(row, id);
      assert.equal(row.partial, i !== 1);
      assert.deepEqual(row.partialReasons, i !== 1 ? ["预算中止：exhausted <test>"] : []);
      assert.equal(row.execution.unexecuted, i !== 1 ? 1 : 0);
      assert.equal(row.conclusionComplete, i === 1);
      if (i < 2) assert.equal(row.baselineMeanTokens, i === 1 ? 18 : null);
    }
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /Work Loop/);
  } finally {
    if (child) { child.kill(); await new Promise<void>(ok => child!.exitCode !== null ? ok() : child!.once("exit", () => ok())); }
    for(const id of ids) rmSync(join(root, "runs", id), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
