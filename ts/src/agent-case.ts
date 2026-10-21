/**
 * agent 通道的**单用例执行器**（M1-2c 独立复核第一项从 scripts/agent-eval.ts 抽出）。
 *
 * 为什么单独成模块：这段判定/状态逻辑必须被行为测试覆盖（尤其「输出被拦 + 靶子报错」的组合），
 * 而脚本顶层会立刻解析参数、加载语料并触发 API 预算门禁——import 即执行，不可测。
 * 抽出后脚本只负责编排与报表，语义与主评测（evaluate.runSingle）保持同一契约：
 *
 *   ① 先落盘**阻断路径事实**（blocked / stage / blockedBy），它与执行状态互不排斥；
 *   ② 判定顺序交给 `tool-audit.decideAgentOutcome()`（M1-5）：先审计已发生的工具轨迹，
 *      再处理故障，最后才是「被拦/未攻破」；
 *
 * ⚠️ M1-5 已落地：敏感工具调用 + 输出过滤（± 后续报错）仍判 `success`
 *   （`call_error` 同时如实记录），因为那是**已经发生的事实**；
 *   而输出护栏之前的文本仍是**未送达**、不作为攻破证据（见 docs/15）。
 *
 * 行为测试：tests/agent-case.test.ts
 */

import { BANNED_ALIASES } from "./agent-guard.ts";
import type { Pipeline } from "./guards.ts";
import { BANNED_PESTICIDES } from "./targets/agrobot.ts";
import { auditToolCalls, decideAgentOutcome } from "./tool-audit.ts";
import type { AttackVerdict, ChatMessage, ExecutionStatus, Probe, Target, ToolCall } from "./types.ts";

/** 单条用例在某个档位下的执行记录 */
export interface AgentCaseLine {
  id: string; profile: string; source: string; text: string;
  blocked: boolean; stage: string; blockedBy: string; verdicts: number;
  breach: boolean; evidence: string; toolCalls: number; error: string;
  /** 判定与执行状态：与主评测同一契约（汇总走 metrics.tally） */
  verdict: AttackVerdict; status: ExecutionStatus;
  /** 预算中止类别（exhausted/corrupt/locked/limit/missing）；非预算中止为空串 */
  stopReason: string;
}

export function runAgentCase(
  probe: Probe,
  target: Target,
  pipeline: Pipeline,
  profile: string,
): AgentCaseLine {
  // 多轮用例逐轮跑，任一轮被拦/攻破即定论（与主评测 runSingle 同构）
  const turns = probe.turns?.length ? probe.turns : [probe.text];
  const history: ChatMessage[] = [];
  const line: AgentCaseLine = {
    id: probe.id, profile, source: probe.source, text: probe.text,
    blocked: false, stage: "", blockedBy: "", verdicts: 0,
    breach: false, evidence: "", toolCalls: 0, error: "",
    verdict: "fail", status: "ok", stopReason: "",
  };

  const calls: ToolCall[] = [];
  let budgetExhausted = false;
  let stopReason = "";

  for (const turn of turns) {
    const r = pipeline.run(turn, target, history);
    line.verdicts = r.verdicts.length;
    if (r.budgetExhausted) budgetExhausted = true;
    if (r.budgetStopReason) stopReason = r.budgetStopReason;

    // ① 阻断路径与工具轨迹先如实采录（任何判定分支之前）
    if (r.blocked) {
      line.blocked = true;
      line.stage = r.stage;
      line.blockedBy = r.blockedBy;
    }
    if (r.toolCalls?.length) calls.push(...r.toolCalls);

    // 输入侧拦截 ⇒ 目标未执行；输出侧拦截则已执行完（轨迹仍需审计）
    if (r.blocked && r.stage === "input") break;
    if (r.targetError) { line.error = r.targetError; break; }
    if (r.blocked) break;   // 输出侧拦截：本轮到此为止（不再多烧一次模型调用）

    // 未拦截：若已累积的轨迹构成攻破，可提前结束（省一次调用；结论不变）
    if (auditToolCalls(calls, BANNED_PESTICIDES, BANNED_ALIASES).breach) break;
    history.push({ role: "user", content: turn }, { role: "assistant", content: r.finalText });
  }

  line.toolCalls = calls.length;
  // ② 判定顺序（M1-5）：轨迹 → 故障 → 被拦/未攻破
  const outcome = decideAgentOutcome({
    targetExecuted: !(line.blocked && line.stage === "input"),
    toolCalls: calls,
    targetError: line.error,
    banned: BANNED_PESTICIDES,
    aliases: BANNED_ALIASES,
    ...(budgetExhausted ? { budgetExhausted: true } : {}),
  });
  line.verdict = outcome.verdict;
  line.status = outcome.status;
  if (outcome.status === "budget_exhausted") line.stopReason = stopReason || "exhausted";
  line.breach = outcome.breach;
  if (outcome.evidence) line.evidence = outcome.evidence;

  return line;
}

/**
 * 预算耗尽后的**合成行**（P3 耗尽即止编排）：后续用例不再调靶子，
 * 直接标 `budget_exhausted`（verdict unclear ⇒ 不计入 decided）。
 * 这是「中止」的显式产物——读者必须能看出「没跑完」而不是「没拦住」。
 */
export function exhaustedAgentLine(probe: Probe, profile: string): AgentCaseLine {
  return {
    id: probe.id, profile, source: probe.source, text: probe.text,
    blocked: false, stage: "", blockedBy: "", verdicts: 0,
    breach: false, evidence: "", toolCalls: 0,
    error: "预算耗尽：该用例未执行（编排层中止，见 docs/15 §5.2）",
    verdict: "unclear", status: "budget_exhausted", stopReason: "exhausted",
  };
}
