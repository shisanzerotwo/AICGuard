// 测试替身桥（Codex 复核 R3 反例）：一条**刻意构造的混合序列**——
//   第 1、2 次调用（两条良性基线）⇒ 调用失败（如 402 余额耗尽）
//   第 3 次调用（第 1 条攻击）      ⇒ **成功**，usage = 7 入 + 11 出 = 18 token
//   第 4 次起                      ⇒ 报"预算耗尽"（发送前拦下 ⇒ 整批中止）
//
// 它锁的场景是**基线不成立 + 中止**：报告必须显式 partial，**倍率保持 null（不得强造）**，
// 但已经拿到的 18-token 那条原始结果**必须留在产物里**（修前 writePartial 不带 cases ⇒ 记录丢失）。
import { appendFileSync, readFileSync } from "node:fs";

JSON.parse(readFileSync(0, "utf8"));
const counter = process.env.COUNTER;
if (counter) appendFileSync(counter, "call\n");
const n = counter ? readFileSync(counter, "utf8").split("\n").filter((l) => l.trim()).length : 1;

const SENT = { state: "submitted", sha256: "c".repeat(64), bytes: 256, attemptId: `stub-${n}-cccc`, decodedText: "stub-decoded" };

if (n <= 2) {
  // 良性基线：靶子调用失败（**不是**预算中止）⇒ 基线永远不成立
  process.stdout.write(JSON.stringify({
    text: "", error: "HTTP 402: 余额耗尽（替身）", usage: { prompt_tokens: 0, completion_tokens: 0 },
    toolCalls: [], attempts: 1, budgetExhausted: false, budgetStop: null, request: SENT,
  }));
} else if (n === 3) {
  // 第 1 条攻击：成功拿到 18 token —— 这条**必须**出现在部分报告里
  process.stdout.write(JSON.stringify({
    text: "offline attack answer", error: "", usage: { prompt_tokens: 7, completion_tokens: 11 },
    toolCalls: [], attempts: 1, budgetExhausted: false, budgetStop: null, request: SENT,
  }));
} else {
  process.stdout.write(JSON.stringify({
    text: "", error: "budget_exhausted: 额度不足（发送前拦下）", usage: { prompt_tokens: 0, completion_tokens: 0 },
    toolCalls: [], attempts: 0, budgetExhausted: true, budgetStop: "exhausted",
    request: { state: "refused", sha256: "", bytes: 0, attemptId: "", decodedText: "" },
  }));
}
