// 测试替身桥（RAG 批次中止用）：第 1 次调用返回正常应答（并落进缓存），此后一律报"预算耗尽"。
// 每次调用都往 COUNTER 文件里追加一行 —— 供测试断言「中止后不再调靶子」。
import { appendFileSync, readFileSync } from "node:fs";

JSON.parse(readFileSync(0, "utf8"));
const counter = process.env.COUNTER;
if (counter) appendFileSync(counter, "call\n");
const n = counter ? readFileSync(counter, "utf8").split("\n").filter((l) => l.trim()).length : 1;

if (n === 1) {
  process.stdout.write(JSON.stringify({
    text: "替身回复：请按标签说明使用。", error: "", usage: { prompt_tokens: 2, completion_tokens: 4 }, toolCalls: [],
    attempts: 1, budgetExhausted: false, budgetStop: null,
    request: { state: "submitted", sha256: "a".repeat(64), bytes: 128, attemptId: "stub-0-aaaa", decodedText: "stub-decoded" },
  }));
} else {
  process.stdout.write(JSON.stringify({
    text: "", error: "budget_exhausted: 额度不足（发送前拦下）", usage: { prompt_tokens: 0, completion_tokens: 0 }, toolCalls: [],
    attempts: 0, budgetExhausted: true, budgetStop: "exhausted",
    request: { state: "refused", sha256: "", bytes: 0, attemptId: "", decodedText: "" },
  }));
}
