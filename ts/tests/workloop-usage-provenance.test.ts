/**
 * Work Loop 的**用量来源**必须分得清（Codex 复核 E2）——等价于 D2 的剩余边界。
 *
 * 修前实测（复核者 `schema-usage-results.json` mode=fail-after-benign）：服务器先给良性一个健康响应
 * （用量 7/11），**再回 HTTP500 且响应体里没有 usage**；桥/靶子错误路径会构造默认 `{0,0}`，而
 * `rawUsageOf` 只判断"usage 对象存在" ⇒ 报告落 `usage={0,0}/totalTokens=0`，Markdown 还写"无消耗"。
 * 那是**默认占位值**，不是供应商报告的用量 —— 只能证明"未取得"，不能证明"零消耗"。
 *
 * 本测试用**真实桥** + 本机替身服务器，覆盖四种必须区分的情形：
 *   ① 已提交/已尝试但**没拿到用量** ⇒ `usageSource=unknown`，数值保持 **null**（不得写 0）；
 *   ② 部分轮次有报告（工具调用 7/11）后又遇到无 usage 的失败 ⇒ `partial`：18 是**下界**，仍保留；
 *   ③ 供应商**明确报告 usage 0**（健康响应）⇒ `reported`（确认零 ≠ 未知）；
 *   ④ 发送前耗尽、**根本没发出请求** ⇒ `none`（确认零，且与③④以外的"未知"不同）。
 * 另加 ⑤ 正常有 usage 的完整任务对照，证明上面的口径不是"永远不可计算"。
 *
 * 全程离线：127.0.0.1 替身服务器 + 真实桥（本地子进程），**外部模型请求 0**。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureLedger, reserveAttempts } from "../src/budget.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const SCRIPT = join(TS_ROOT, "scripts", "workloop-eval.ts");
const SERVER = join(HERE, "fixtures", "bridge-attempt-server.mjs");

interface RoundRow {
  round: number; status: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  totalTokens: number | null;
  usageSource: string; usageComplete: boolean; multiplier: number | null;
}
interface CaseRow {
  id: string; rounds: RoundRow[]; okRounds: number[]; unexecutedRounds: number;
  partialUsageTokens: number; partialUsageRounds: number; unknownUsageRounds: number;
  meanTokens: number | null; meanMultiplier: number | null; maxMultiplier: number | null; flagged: boolean | null;
}
interface Report {
  partial?: boolean; complete?: boolean; aborted?: boolean; partialReasons?: string[];
  executed?: number; unexecuted?: number; totalSlots?: number;
  baseline?: { usable: boolean; meanTokens: number | null; okSamples: number; unknownUsageRounds: number;
    samples: Array<{ round: number; id: string; status: string; usage: RoundRow["usage"]; totalTokens: number | null; usageSource: string; usageComplete: boolean }> };
  cases?: CaseRow[];
  partialUsage?: { tokens: number; rounds: number; benignTokens: number; benignRounds: number; unknownRounds: number; lowerBoundRounds: number };
}

async function startServer(dir: string, mode: string): Promise<{ port: number; hits: () => number; stop: () => void }> {
  const file = join(dir, `hits-${mode}.log`);
  const child = spawn(process.execPath, [SERVER, file, mode], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((ready, fail) => {
    let buf = "";
    const t = setTimeout(() => fail(new Error("替身服务器未在 10s 内就绪")), 10_000);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /READY (\d+)/.exec(buf);
      if (m) { clearTimeout(t); ready(Number(m[1])); }
    });
    child.on("error", fail);
  });
  return {
    port,
    hits: () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length : 0),
    stop: () => child.kill(),
  };
}

/** 跑 workloop 入口：**真实桥**（AICGUARD_BRIDGE 置空）+ 本机替身服务器 + 隔离缓存目录 */
function runWorkloop(dir: string, port: number, opts: { mode: string; limit: number; benignLimit?: number; preused?: boolean }): {
  code: number; out: string; rep: Report; md: string;
} {
  const outDir = join(dir, `out-${opts.mode}-${opts.limit}${opts.preused ? "-preused" : ""}`);
  const budgetPath = join(dir, `budget-${opts.mode}-${opts.limit}.json`);
  if (opts.preused) {
    ensureLedger(budgetPath, { runId: "wl-e2", limit: opts.limit });
    reserveAttempts(budgetPath, opts.limit, "test-preconsume");
  }
  const r = spawnSync(process.execPath, [
    SCRIPT, "--samples", "1", "--benign-limit", String(opts.benignLimit ?? 1), "--out", outDir,
    "--budget", budgetPath, "--budget-limit", String(opts.limit),
  ], {
    cwd: TS_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AICGUARD_BRIDGE: "",                       // ★ 空串 ⇒ 用**真实桥**（llm-bridge.mjs）
      AICGUARD_BASE_URL: `http://127.0.0.1:${port}/v1`,
      AICGUARD_API_KEY: "sk-test-not-real",
      AICGUARD_MODEL: `m-wl-e2-${process.pid}`,
    },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const repPath = join(outDir, "report.json");
  return {
    code: r.status ?? -1, out,
    rep: existsSync(repPath) ? JSON.parse(readFileSync(repPath, "utf8")) as Report : (null as unknown as Report),
    md: existsSync(join(outDir, "report.md")) ? readFileSync(join(outDir, "report.md"), "utf8") : "",
  };
}

const caseOf = (rep: Report, id: string): CaseRow => {
  const c = (rep.cases ?? []).find((x) => x.id === id);
  assert.ok(c, `报告必须含用例 ${id}`);
  return c!;
};

test("E2-① 已提交但未取得用量（HTTP500 无 usage）⇒ usageSource=unknown、数值保持 null，不得写 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-e2-unknown-"));
  const srv = await startServer(dir, "usage-no-report-500");
  try {
    // 序列：良性 BN-01 → 健康(usage 7/11)；WL-01 → HTTP500（响应体无 usage）→ 重试被预算拦下
    const { code, out, rep, md } = runWorkloop(dir, srv.port, { mode: "usage-no-report-500", limit: 2 });
    assert.equal(code, 2, `中止批退出 2。输出：${out.slice(0, 600)}`);
    assert.equal(srv.hits(), 2, "独立计数：良性 1 次 + WL-01 的 500 1 次（重试被拦在发送前）");
    assert.equal(rep.partial, true);
    // 基线侧：良性真的拿到了供应商用量 ⇒ 是有效完整样本
    const b0 = rep.baseline?.samples[0];
    assert.equal(b0?.usageSource, "reported", "健康响应报了 usage ⇒ reported");
    assert.equal(b0?.usageComplete, true);
    assert.equal(b0?.totalTokens, 18);
    assert.equal(rep.baseline?.meanTokens, 18, "基线均值只由有效完整样本算出");
    // ★ 核心：WL-01 的这一轮**没有**供应商用量 ⇒ 不得落 0
    const wl01 = caseOf(rep, "WL-01");
    const r0 = wl01.rounds[0];
    assert.equal(r0.status, "budget_exhausted", "如实记预算中止（已提交后耗尽）");
    assert.equal(r0.usage, null, "★ 用量未取得 ⇒ usage 必须是 null（修前是 {0,0}）");
    assert.equal(r0.totalTokens, null, "★ 不得写 0 token");
    assert.equal(r0.usageSource, "unknown", "★ 来源必须显式标 unknown");
    assert.equal(r0.usageComplete, false);
    assert.equal(r0.multiplier, null);
    assert.equal(wl01.unknownUsageRounds, 1, "用例级要能数出\"未取得\"的轮次");
    assert.equal(wl01.partialUsageTokens, 0, "未取得 ≠ 已知部分用量（后者才有可信数字）");
    assert.equal(rep.partialUsage?.unknownRounds, 1);
    assert.equal(rep.baseline?.unknownUsageRounds, 0);
    // 人读的 Markdown：必须写"用量未取得"，不得写"无消耗"、也不得出现假的 0 token 行
    assert.match(md, /用量未取得/, `Markdown 要显式写\"用量未取得\"：${md.slice(0, 400)}`);
    assert.ok(!/入 0\/出 0=0 token/.test(md), "★ 不得出现\"入 0/出 0=0 token\"这类假原始零值");
    assert.ok(!/0 token（无消耗）/.test(md), "不得把未取得写成无消耗");
    assert.ok(!/未达\s*5×\s*阈值/.test(md), "中止批不得给整体结论");
  } finally {
    srv.stop();
  }
});

test("E2-② 工具轮有报告(7/11) + 后续轮无 usage ⇒ 18 作为**下界**保留，标清 partial，不进均值/倍率", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-e2-lowerbound-"));
  const srv = await startServer(dir, "usage-partial-then-500");
  try {
    // 序列：良性 ok7-11；WL-01 轮1 工具调用(7/11)；轮2 HTTP500（无 usage）→ 重试被拦（limit=3）
    const { code, rep, md } = runWorkloop(dir, srv.port, { mode: "usage-partial-then-500", limit: 3 });
    assert.equal(code, 2);
    assert.equal(srv.hits(), 3, "良性 1 + 工具轮 1 + 500 1");
    const wl01 = caseOf(rep, "WL-01");
    const r0 = wl01.rounds[0];
    assert.equal(r0.status, "budget_exhausted");
    assert.deepEqual(r0.usage, { promptTokens: 7, completionTokens: 11 }, "已知的部分用量要保留");
    assert.equal(r0.totalTokens, 18, "18 作为下界保留");
    assert.equal(r0.usageSource, "partial", "★ 部分轮次有报告 ⇒ partial（总消耗只是下界）");
    assert.equal(r0.usageComplete, false, "★ 下界不得当完整成本样本");
    assert.equal(r0.multiplier, null);
    assert.equal(wl01.partialUsageTokens, 18);
    assert.equal(wl01.partialUsageRounds, 1);
    assert.equal(wl01.unknownUsageRounds, 0, "本例有可信数字（下界），不算\"未取得\"");
    assert.equal(wl01.meanTokens, null, "★ 下界不进有效均值");
    assert.equal(wl01.meanMultiplier, null);
    assert.equal(wl01.flagged, null);
    assert.equal(rep.partialUsage?.lowerBoundRounds, 1, "汇总里要能看出\"总消耗是下界\"");
    assert.match(md, /已知部分用量（下界）/, "Markdown 要标出这是下界");
    assert.ok(!/未取得 0 轮/.test(md), "计数不得自相矛盾");
  } finally {
    srv.stop();
  }
});

test("E2-③ 供应商**明确报告 usage 0**（健康响应）⇒ reported，与\"未知\"必须可分", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-e2-zero-"));
  const srv = await startServer(dir, "usage-zero");
  try {
    const { code, rep } = runWorkloop(dir, srv.port, { mode: "usage-zero", limit: 20 });
    assert.equal(code, 2, "基线均值为 0 ⇒ 按既有防线判\"基线不成立\"（partial，退出 2）");
    const b0 = rep.baseline?.samples[0];
    assert.equal(b0?.usageSource, "reported", "★ 健康响应里的 0 是**供应商报告的**，不是默认占位");
    assert.equal(b0?.usageComplete, true, "报告的 0 是有效完整样本（0 也是可信数字）");
    assert.equal(b0?.totalTokens, 0);
    assert.equal(rep.partialUsage?.unknownRounds, 0, "★ 确认零 ≠ 未知：这里不应出现\"未取得\"");
    assert.equal(rep.baseline?.unknownUsageRounds, 0);
    assert.ok((rep.partialReasons ?? []).some((x) => /良性基线不成立/.test(x)), "基线不可用要说清原因");
  } finally {
    srv.stop();
  }
});

test("E2-④ 发送前耗尽（根本没发出请求）⇒ usageSource=none（确认零），与 unknown 区分", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-e2-none-"));
  const srv = await startServer(dir, "healthy");
  try {
    // 账本预先用满 ⇒ 第一次尝试就在**发送前**被拦（服务器 0 命中）
    const { code, rep, md } = runWorkloop(dir, srv.port, { mode: "healthy", limit: 1, preused: true });
    assert.equal(code, 2);
    assert.equal(srv.hits(), 0, "★ 独立计数：一个字节都没发出去");
    const b0 = rep.baseline?.samples[0];
    assert.equal(b0?.usageSource, "none", "★ 没发出 ⇒ 确认零（none），不是 unknown");
    assert.equal(b0?.totalTokens, 0, "确认零可以如实写 0（与\"未取得\"不同）");
    assert.equal(b0?.usageComplete, false, "但它不是有效完整样本（本槽位没跑成）");
    assert.equal(rep.partialUsage?.unknownRounds, 0, "确认零不计入\"未取得\"");
    assert.match(md, /确认零消耗/, "Markdown 要能看出这是\"未发出请求\"");
  } finally {
    srv.stop();
  }
});

test("E2-⑤ 正常有 usage 的完整任务对照：reported + 完整样本 + 倍率可算（非恒不可计算）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-e2-healthy-"));
  const srv = await startServer(dir, "healthy");
  try {
    const { code, rep, md } = runWorkloop(dir, srv.port, { mode: "healthy", limit: 20 });
    assert.equal(code, 0, "跑完且无达阈用例");
    assert.equal(rep.partial, false);
    assert.equal(rep.complete, true);
    assert.equal(srv.hits(), 7, "1 条良性 + 6 条攻击，各 1 次调用");
    const b0 = rep.baseline?.samples[0];
    assert.equal(b0?.usageSource, "reported");
    assert.equal(b0?.usageComplete, true);
    assert.equal(rep.baseline?.meanTokens, 8, "健康响应报 3 入/5 出 = 8 token");
    const wl01 = caseOf(rep, "WL-01");
    assert.equal(wl01.rounds[0].usageSource, "reported");
    assert.equal(wl01.rounds[0].usageComplete, true);
    assert.equal(wl01.meanMultiplier, 1, "8/8 ⇒ 1.0×");
    assert.equal(wl01.flagged, false);
    assert.equal(rep.partialUsage?.tokens, 0);
    assert.equal(rep.partialUsage?.unknownRounds, 0);
    assert.ok(!md.includes("部分结果：未跑完"));
  } finally {
    srv.stop();
  }
});

/**
 * Codex 复核 F1/F3 的入口级反例：**不完整/未知用量（或同一桥内的未知重试）不得进入有效均值**。
 * 两条都要求：良性基线明确 18；WL-01 没有完整成本轮 ⇒ `usageComplete=false` 且
 * `meanTokens/meanMultiplier/flagged` 全为 null；**不得**输出"6/6 条未达阈值"这类整体负结论。
 */
test("F1-③ 入口级：WL-01 用量为 `{}` ⇒ 只剩 unknown，均值/倍率/达阈全 null，且不给整体结论", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-f1-empty-"));
  const srv = await startServer(dir, "usage-empty-2nd");   // hit1 良性 7/11；hit2 WL-01 → 200 + usage:{}
  try {
    const { code, out, rep, md } = runWorkloop(dir, srv.port, { mode: "usage-empty-2nd", limit: 30 });
    assert.equal(srv.hits(), 7, "独立计数：1 条良性 + 6 条攻击各 1 次（额度足够 ⇒ 不中止，才测得到\"跑完但无完整成本样本\"）");
    assert.equal(rep.baseline?.meanTokens, 18, "良性基线明确 18");
    const wl01 = caseOf(rep, "WL-01");
    const r0 = wl01.rounds[0];
    assert.equal(r0.status, "ok", "健康回答仍然成功（不得因缺用量把正常回答变成失败）");
    assert.equal(r0.usageSource, "unknown", "★ `usage:{}` 不是完整成本 ⇒ unknown");
    assert.equal(r0.usage, null, "★ 用量数字保持 null（不得补 0）");
    assert.equal(r0.totalTokens, null);
    assert.equal(r0.usageComplete, false, "★ 不完整成本绝不能算完整样本");
    assert.equal(wl01.meanTokens, null, "★ 无完整轮 ⇒ 均值不可计算");
    assert.equal(wl01.meanMultiplier, null);
    assert.equal(wl01.flagged, null);
    assert.equal(wl01.unknownUsageRounds, 1);
    assert.equal(rep.partialUsage?.unknownRounds, 1);
    assert.equal(rep.partialUsage?.tokens, 0, "未知不得计入已知部分用量");
    // ★ 不得出现整体负结论
    assert.ok(!/6\/6\s*条未达/.test(md), `不得写\"6/6 条未达阈值\"：${md.split("\n").filter((l) => l.includes("未达")).join("｜")}`);
    assert.match(md, /但\*\*只覆盖 5\/6 条\*\*/, "结论必须写明只覆盖哪一部分用例");
    assert.match(md, /本批不构成完整的负结论/, "要明确写出本批不构成整体结论");
    assert.ok(!/未达\s*5×\s*阈值/.test(md), "不得写\"未达 5× 阈值\"这类整体结论措辞");
    assert.match(md, /用量未取得/);
    assert.equal(rep.partial, false, "本批跑完了（额度足够）⇒ 不是 partial：正是 F1 说的\"跑完但没有完整成本\"场景");
    assert.equal(code, 0, "退出码沿用既有语义（0=无达阈用例；结论由报告写清）");
    void out;
  } finally {
    srv.stop();
  }
});

test("F3-② 入口级：同一桥内先 500 后恢复 7/11 ⇒ 成本只是下界，均值/倍率/达阈全 null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aicguard-wl-f3-retry-"));
  const srv = await startServer(dir, "usage-500-then-ok");   // hit1 良性 7/11；hit2 WL-01 的 500；hit3 WL-01 重试成功 7/11
  try {
    const { code, rep, md } = runWorkloop(dir, srv.port, { mode: "usage-500-then-ok", limit: 30 });
    assert.equal(srv.hits(), 8, "独立计数：良性 1 + WL-01 的 500 与重试成功 2 + 其余 5 条攻击 5");
    assert.equal(rep.baseline?.meanTokens, 18, "良性基线明确 18");
    const wl01 = caseOf(rep, "WL-01");
    const r0 = wl01.rounds[0];
    assert.equal(r0.status, "ok", "恢复成功 ⇒ 回答正常、状态 ok");
    assert.equal(r0.usageSource, "partial", "★ 有尝试没用量 ⇒ 整次调用只能算 partial（下界）");
    assert.deepEqual(r0.usage, { promptTokens: 7, completionTokens: 11 }, "已得的 18 作为下界保留");
    assert.equal(r0.totalTokens, 18, "下界数字仍在产物里");
    assert.equal(r0.usageComplete, false, "★ 下界不得当完整样本");
    assert.equal(wl01.meanTokens, null, "★ 无完整轮 ⇒ 均值不可计算");
    assert.equal(wl01.meanMultiplier, null);
    assert.equal(wl01.flagged, null);
    assert.equal(wl01.partialUsageTokens, 18);
    assert.equal(rep.partialUsage?.lowerBoundRounds, 1, "汇总里要能看出\"这是下界\"");
    assert.match(md, /已知部分用量（下界）/, "Markdown 要标出下界");
    assert.ok(!/6\/6\s*条未达/.test(md), "不得给出整体负结论");
    assert.ok(!/未达\s*5×\s*阈值/.test(md), "不得写\"未达 5× 阈值\"");
    assert.match(md, /但\*\*只覆盖 5\/6 条\*\*/, "结论要写明只覆盖有效样本那部分");
    assert.match(md, /本批不构成完整的负结论/);
    assert.equal(code, 0);
  } finally {
    srv.stop();
  }
});
