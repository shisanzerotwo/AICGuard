/**
 * G2（`docs/40`）：`node scripts/agent-eval.ts --profiles none,full` 的入口级测试。
 *
 * 断言口径（不看"脚本自己说跑了什么"，看**产物**）：
 *   ① 子集生效 ⇒ 报告 `report.json` 的 `perSample[].profiles[].profile` 只有名单里的档位；
 *   ② 缺省不变 ⇒ 不写 `--profiles` 时仍是全部 4 档（覆盖面不得被悄悄减少）；
 *   ③ 未知档位名 ⇒ 退出码 2 且 stderr 说明（不得静默忽略、不得当成跑过）；
 *   ④ 空名单 ⇒ 退出码 2（不得静默回退成全档）。
 *
 * 全程离线：走 mock 模式（无 `--real`），不 spawn 桥、不联网、不碰额度账本。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const AGENT_EVAL = resolve(TS_ROOT, "scripts", "agent-eval.ts");

interface ReportShape {
  perSample: Array<{ sample: number; profiles: Array<{ profile: string }> }>;
}

/** 跑一次 mock 评测（最小规模），返回退出码、stdout/stderr、报告档位名单与 Markdown 报告全文 */
function runAgentEval(extra: string[]): { status: number | null; stdout: string; stderr: string; profiles: string[] | null; md: string } {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-agent-profiles-"));
  try {
    const r = spawnSync(process.execPath, [AGENT_EVAL, "--expand", "0", "--benign-limit", "0",
      "--samples", "1", "--out", dir, ...extra], { cwd: TS_ROOT, encoding: "utf8" });
    let profiles: string[] | null = null;
    let md = "";
    try {
      const rep = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as ReportShape;
      profiles = rep.perSample[0]?.profiles.map((p) => p.profile) ?? null;
    } catch { /* 出错路径可能没产出报告：保持 null */ }
    try { md = readFileSync(join(dir, "report.md"), "utf8"); } catch { /* 同上 */ }
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", profiles, md };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("G2-③ 子集生效：--profiles none,full ⇒ 报告里只有这两档", () => {
  const r = runAgentEval(["--profiles", "none,full"]);
  // mock 模式跑完可能是 0（无达阈）或 1（有达阈/攻破，agent 评测的正常语义）；2 才是入口错误
  assert.ok(r.status === 0 || r.status === 1, `必须跑完（0/1），实际 ${r.status}：${r.stderr}`);
  assert.deepEqual(r.profiles, ["none", "full"], `报告档位名单必须与名单一致：${JSON.stringify(r.profiles)}`);
  assert.match(r.stdout, /档位 none\/full/, `运行信息要写清实际档位：\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /full\+agent|rules\+norm/, "未被选中的档位不得出现在档位信息里");
});

test("G2-④ 缺省不变：不给 --profiles ⇒ 仍是原 4 档（覆盖面不许被悄悄减少）", () => {
  const r = runAgentEval([]);
  assert.ok(r.status === 0 || r.status === 1, `必须跑完（0/1），实际 ${r.status}：${r.stderr}`);
  assert.deepEqual(r.profiles, ["none", "rules+norm", "full", "full+agent"],
    `缺省必须跑全部 4 档：${JSON.stringify(r.profiles)}`);
});

test("G2-① 反例：未知档位名 ⇒ 退出码 2 + 明确报错，且不产出报告", () => {
  const r = runAgentEval(["--profiles", "none,bogus"]);
  assert.equal(r.status, 2, `未知档位必须失败退出（实际 ${r.status}）`);
  assert.match(r.stderr, /未知档位：bogus/, `stderr 要点名未知档位：${r.stderr}`);
  assert.equal(r.profiles, null, "报错路径不得留下报告（避免被当成跑过的产物）");
});

test("G2-② 反例：空名单 / 只有逗号 ⇒ 退出码 2，不得静默回退成全档", () => {
  for (const spec of ["", ",", " , "]) {
    const r = runAgentEval(["--profiles", spec]);
    assert.equal(r.status, 2, `空名单 ${JSON.stringify(spec)} 必须失败退出（实际 ${r.status}）`);
    assert.match(r.stderr, /--profiles 为空/, `stderr 要说明是空名单：${r.stderr}`);
  }
});

// ============================================================ G2-R1 回归（Codex 定向返工）
// 合法名单**不含 full** 时：修前在 agent-eval.ts:308 硬取 s.byProfile.get("full")!
// ⇒ TypeError: Cannot read properties of undefined (reading 'lines')，且**零产物**（报告根本没写）。
// 契约：合法子集必须跑完、必须落 report.json + report.md，分攻击族表应明确「本表不适用」，
// 不得拿其它档位冒充 full，也不得因缺 full 就丢掉整份报告。
test("G2-R1 反例：合法子集不含 full（none / full+agent / none,full+agent）⇒ 不得崩溃、必须有完整报告", () => {
  for (const spec of ["none", "full+agent", "none,full+agent"]) {
    const r = runAgentEval(["--profiles", spec]);
    assert.ok(r.status === 0 || r.status === 1,
      `不含 full 的合法子集 ${spec} 必须跑完（0/1），不得因缺 full 崩溃；实际 ${r.status}\n${r.stderr}`);
    assert.deepEqual(r.profiles, spec.split(","),
      `报告必须保留全部所选档位：${spec} ⇒ ${JSON.stringify(r.profiles)}`);
    assert.match(r.md, /本表不适用/, `分攻击族表必须显式标注不适用（整份报告不得丢）：${spec}`);
    assert.equal(r.md.split("| 攻击族 | 用例 | 攻破 | 拦截 |").length - 1, 1,
      "分族表头只应出现一次，不能在不适用分支重复");
    assert.doesNotMatch(r.stderr, /TypeError/, `不得出现 TypeError：${r.stderr}`);
  }
});

test("G2-R1 阳性对照：选中含 full 时，分攻击族表必须真的出表（证明上面的「不适用」不是恒真）", () => {
  const r = runAgentEval(["--profiles", "none,full"]);
  assert.deepEqual(r.profiles, ["none", "full"], "阳性对照必须真实执行指定两档");
  assert.ok(r.status === 0 || r.status === 1, `必须跑完：${r.stderr}`);
  assert.doesNotMatch(r.md, /本表不适用/, "含 full 时不得标「不适用」");
  assert.match(r.md, /## 四、分攻击族表现/, "含 full 时必须出分攻击族表");
});

// ============================================================ G2-R2 回归（Codex 定向返工）
// 修前：末尾裸写 --profiles 被赋成 undefined ⇒ selectProfiles 当成「未提供」⇒ 实际 exit0 **跑满四档**
// 并写出报告（把收窄意图反转成放大）。契约：区分「未提供 flag」与「提供了但缺值」。
test("G2-R2 反例：--profiles 缺值（末尾裸写 / 后跟另一个 flag）⇒ 执行前 exit2、零档位执行、不留报告", () => {
  for (const extra of [["--profiles"], ["--profiles", "--samples", "1"]]) {
    const r = runAgentEval(extra);
    assert.equal(r.status, 2, `${JSON.stringify(extra)} 必须在执行前失败（实际 ${r.status}）`);
    assert.match(r.stderr, /--profiles 缺少名单/, `stderr 要点明缺名单：${r.stderr}`);
    assert.equal(r.profiles, null, "缺值路径不得留下评测报告");
    assert.doesNotMatch(r.stdout, /档位 /, `不得执行任何档位：${r.stdout}`);
  }
});

test("G2-R2 对照：不传 --profiles 仍按默认四档跑完并出报告（缺值报错不得误伤缺省面）", () => {
  const r = runAgentEval([]);
  assert.ok(r.status === 0 || r.status === 1, `必须跑完：${r.stderr}`);
  assert.deepEqual(r.profiles, ["none", "rules+norm", "full", "full+agent"]);
  assert.match(r.md, /## 四、分攻击族表现/, "默认四档含 full ⇒ 分攻击族表必须存在");
});
