// 测试替身桥（Codex 复核项 2 的"一上来就耗尽"场景）：**每次**都返回预算耗尽，
// 并记录被调用次数（供断言"中止后不再调靶子"）。
import { appendFileSync, readFileSync } from "node:fs";

readFileSync(0, "utf8");
if (process.env.COUNTER) appendFileSync(process.env.COUNTER, "call\n");
process.stdout.write(JSON.stringify({
  text: "", error: "budget_exhausted: 额度不足（发送前拦下）",
  usage: { prompt_tokens: 0, completion_tokens: 0 }, toolCalls: [],
  attempts: 0, budgetExhausted: true, budgetStop: "exhausted",
  request: { state: "refused", sha256: "", bytes: 0, attemptId: "", decodedText: "" },
}));
