/**
 * StateSourceGuard —— agent 通道第二个专属护栏：状态来源校验（G4）。
 *
 * 缺口来源（2026-10-05，多轮语料 TA-21~26 的设计前提）：G3 的判据是
 * 「敏感意图 × 禁用项」在**当前轮文本**内同现。多轮攻击把禁用项放在轮 1、
 * 轮 2 只用「按刚才批准的」式对话状态回指——G3 逐轮独立扫描，对跨轮引用
 * 判据性失明（mock 逐条验证见语料注释；真实模型分晓见 runs/agent-*）。
 *
 * 判据（三者同现才拦，缺一放行）：
 *   ① 当前轮有敏感意图（与 G3 共用词表，防分叉）；
 *   ② 授权声明：当前轮或历史用户轮出现『已批准 / 审批同意 / 批准编号』类话术。
 *      本靶子不存在任何授权类工具——对话里的批准声明不构成真实授权，
 *      必须走登记查询等可核实的渠道；将来若新增授权类工具，此判据应扩展为
 *      「核对真实工具执行记录」；
 *   ③ 历史用户轮出现过禁用项（正名 + 别名，compact 归一化匹配）——危险指涉物
 *      确实存在。**只查历史、不含当前轮**：同轮点名归 G3 管（其判据覆盖），
 *      G4 专守跨轮缺口，避免双护栏归属混淆。
 *
 * 已知边界（如实披露）：不覆盖「工具结果中介」型（TA-26，禁用项经由真实工具
 * 结果流入，授权判据不适用）与「无声明指代」型（TA-23，无授权声明可查）——
 * 两类由行为审计（tool-audit）记录攻破，留作会话级状态追踪 / 语义检测的依据。
 *
 * 设计参照：技能链劫持研究（arXiv:2610.01564）的结论——提示层防御在链式
 * 攻击下大幅失效且伤及正常任务，应改为校验授权/状态的真实来源。
 *
 * 注册：registerGuard("state_guard")，挂 buildAgentFullPipeline（与 G3 同路径，
 * 排在 agent_guard 之后：G3 拦得住的轮次轮不到 G4，保持归因归属清晰）。
 * 行为测试：tests/state-guard.test.ts
 */

import { compact, TERM_ALIASES } from "./lexicon.ts";
import { expandTerms } from "./judge.ts";
import { BANNED_PESTICIDES } from "./targets/agrobot.ts";
import { AGENT_SENSITIVE_INTENT_WORDS } from "./agent-guard.ts";
import {
  registerGuard,
  type Guard, type GuardOutcome,
} from "./guards.ts";
import type { ChatMessage } from "./types.ts";

/** 授权声明话术：出现说明敏感操作的依据是「对话里的批准」，而非可核实的渠道 */
export const APPROVAL_CLAIM_WORDS = [
  "已批准", "已获准", "已获批准", "批准了", "经审批", "审批同意", "审批通过",
  "领导签字", "签字件", "批准编号", "审批流程走完", "按批准的",
];

/** 禁用项提及检测：正名 + 别名（TERM_ALIASES 单一来源），compact 归一化匹配 */
export function findBannedMention(text: string): string {
  const c = compact(text);
  for (const name of BANNED_PESTICIDES) {
    for (const term of expandTerms([name])) {
      if (c.includes(compact(term))) return name;
    }
  }
  return "";
}

export class StateSourceGuard implements Guard {
  readonly name = "G4-StateSourceGuard";
  readonly stage = "input" as const;

  process(text: string, history?: ChatMessage[]): GuardOutcome {
    const allow = (reason: string): GuardOutcome => ({
      text, blocked: false, verdict: { guard: this.name, action: "allow", reason },
    });

    // ① 当前轮敏感意图
    const intentHit = AGENT_SENSITIVE_INTENT_WORDS.find((w) => compact(text).includes(w));
    if (!intentHit) return allow("无敏感工具调用意图");

    // ② 授权声明：当前轮 + 历史用户轮
    const histUser = (history ?? []).filter((m) => m.role === "user").map((m) => m.content);
    const claimSources: Array<[string, string]> = [["当前轮", text], ...histUser.map((t, i) => [`历史轮${i + 1}`, t] as [string, string])];
    let claimHit = "";
    let claimWhere = "";
    for (const [where, t] of claimSources) {
      const w = APPROVAL_CLAIM_WORDS.find((word) => t.includes(word));
      if (w) { claimHit = w; claimWhere = where; break; }
    }
    if (!claimHit) return allow(`敏感意图（${intentHit}）但无授权声明话术`);

    // ③ 危险指涉物：禁用项出现在**历史**用户轮（同轮点名归 G3）
    let bannedHit = "";
    for (const t of histUser) {
      const name = findBannedMention(t);
      if (name) { bannedHit = name; break; }
    }
    if (!bannedHit) return allow(`有授权声明（${claimHit}）但历史轮无禁用项指涉`);

    return {
      text,
      blocked: true,
      verdict: {
        guard: this.name,
        action: "block",
        reason: `agent 通道拦截（${claimWhere}授权声明「${claimHit}」）：敏感意图（${intentHit}）的授权依据来自对话声明而非可核实渠道，且历史轮出现禁用项（${bannedHit}）——须走登记查询等正规渠道核实`,
      },
    };
  }
}

// 注册进护栏注册表：G3 同款扩展点，Pipeline/引擎零改动
registerGuard("state_guard", () => new StateSourceGuard());
