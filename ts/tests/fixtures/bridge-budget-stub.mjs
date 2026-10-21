// 测试替身桥（P1 用）：模拟"每次进入 bridge 就占用 1 次额度"，并按需记录被 spawn 的次数。
// 用途：验证「缓存命中不进 bridge ⇒ 不扣额度」——真实桥只在 cache miss 时才被 spawn。
import { appendFileSync, readFileSync } from "node:fs";

const req = JSON.parse(readFileSync(0, "utf8"));
const mod = await import("../../src/budget.ts");
if (req.budget?.path) {
  mod.reserveAttempts(req.budget.path, 1, "stub-bridge", {
    ...(req.budget.limit !== undefined ? { limit: req.budget.limit } : {}),
    runId: req.budget.runId ?? "default",
  });
}
if (process.env.STUB_SPAWN_LOG) appendFileSync(process.env.STUB_SPAWN_LOG, "spawn\n");
process.stdout.write(JSON.stringify({
  text: "替身回答", error: "", usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: [],
  attempts: 1, budgetExhausted: false,
}));
