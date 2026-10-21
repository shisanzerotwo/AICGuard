// 测试替身桥（Codex 复核 D2）：模拟「**同一任务内先成功后中止/报错**」，检验已发生的原始用量是否被保留。
//
// MODE 决定调用序列（COUNTER 文件记调用序号）：
//   attack    ：1 良性正常 → 2 良性正常 → 3 攻击 WL-01 第 1 轮**工具调用**（usage 7 入 / 11 出）
//               4 WL-01 第 2 轮**预算耗尽** → 之后不再被调用（批次中止）
//   benign    ：1 良性 BN-01 第 1 轮**工具调用**（7/11）→ 2 BN-01 第 2 轮预算耗尽 → 停
//   api-error ：1 良性正常 → 2 良性正常 → 3 攻击 WL-01 第 1 轮工具调用（7/11）
//               4 WL-01 第 2 轮**接口报错**（call_error）→ 5 WL-02 预算耗尽 → 停
//   healthy   ：每次都返回完整健康回复（对照：跑完、有有效样本、倍率可算）
//
// 工具调用用真实工具名 `search_knowledge`（AgentBot 会本地执行后进入第 2 轮）。
import { appendFileSync, readFileSync } from "node:fs";

JSON.parse(readFileSync(0, "utf8"));
const counter = process.env.COUNTER;
if (counter) appendFileSync(counter, "call\n");
const n = counter ? readFileSync(counter, "utf8").split("\n").filter((l) => l.trim()).length : 1;
const mode = process.env.MODE ?? "attack";

const SENT = { state: "submitted", sha256: "d".repeat(64), bytes: 180, attemptId: `stub-${n}-dddd`, decodedText: "stub-decoded" };
/** 健康回复（模型直接答，不再调工具） */
const healthy = (usage) => ({
  text: "替身回复：请按登记说明使用。", error: "", usage, toolCalls: [],
  attempts: 1, budgetExhausted: false, budgetStop: null, request: SENT,
});
/** 工具调用轮（模型调一次本地工具 ⇒ AgentBot 会再发第 2 轮） */
const toolCall = (usage) => ({
  text: "", error: "", usage, attempts: 1, budgetExhausted: false, budgetStop: null, request: SENT,
  toolCalls: [{ name: "search_knowledge", arguments: { keyword: "滴灌" } }],
});
const exhausted = {
  text: "", error: "budget_exhausted: 额度不足（发送前拦下）", usage: { prompt_tokens: 0, completion_tokens: 0 },
  toolCalls: [], attempts: 0, budgetExhausted: true, budgetStop: "exhausted",
  request: { state: "refused", sha256: "", bytes: 0, attemptId: "", decodedText: "" },
};
const apiError = {
  text: "", error: "HTTP 500: 上游网关错误（替身）", usage: { prompt_tokens: 0, completion_tokens: 0 },
  toolCalls: [], attempts: 1, budgetExhausted: false, budgetStop: null, request: SENT,
};

let out;
if (mode === "healthy") {
  out = healthy({ prompt_tokens: 2, completion_tokens: 4 });
} else if (mode === "benign") {
  out = n === 1 ? toolCall({ prompt_tokens: 7, completion_tokens: 11 }) : exhausted;
} else if (mode === "api-error") {
  if (n <= 2) out = healthy({ prompt_tokens: 2, completion_tokens: 4 });
  else if (n === 3) out = toolCall({ prompt_tokens: 7, completion_tokens: 11 });
  else if (n === 4) out = apiError;
  else out = exhausted;
} else {
  // attack
  if (n <= 2) out = healthy({ prompt_tokens: 2, completion_tokens: 4 });
  else if (n === 3) out = toolCall({ prompt_tokens: 7, completion_tokens: 11 });
  else out = exhausted;
}
process.stdout.write(JSON.stringify(out));
