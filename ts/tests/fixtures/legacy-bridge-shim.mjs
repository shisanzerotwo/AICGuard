// 旧协议桥替身（Codex 复核 F4 的隔离复现件）：**真实发出 HTTP**、用项目 `reserveAttempts` 占额度，
// 只按 LEGACY_MODE 省略/伪造旧协议可能缺的字段 —— 这样"缺字段"不再等于"没发出去"。
//
// LEGACY_MODE：
//   refusal           —— 完全不 fetch：返回 attempts=0 + request.state=refused（阳性对照：确认零）
//   with-usage        —— 转发 text + usage，**不带 attempts / request**（字段全缺）
//   without-usage     —— 转发 text，**不带 usage / attempts / request**
//   attempts1         —— 转发 text + usage + attempts=1
//   attempts1-no-usage—— 转发 text + attempts=1，**没有 usage**
//   attempts2         —— 转发 text + usage + attempts=2（多次尝试只拿到一份用量 ⇒ 下界）
//   submitted         —— 转发 text + usage + request.state=submitted（有送达状态、无 attempts）
//   —— F5：**元信息自相矛盾**（都真实发过 HTTP，却把 attempts/送达状态说成"没发"）——
//   zero-submitted    —— attempts=0 **且** request.state=submitted + usage（0 次与已提交冲突）
//   refused-usage     —— attempts=1 **且** request.state=refused + usage（拒绝与 1 次冲突）
//   dryrun-usage      —— attempts=1 **且** request.state=dry-run + usage（预览与 1 次冲突）
//   zero-submitted-no-usage —— attempts=0 且 submitted、**没有 usage**（冲突但无数字 ⇒ 未知）
//   workloop-conflict —— 只在**命中 2**（WL-01）那条制造 `attempts=1 + refused + usage` 冲突，其余为一致形态
import { readFileSync } from "node:fs";

const { reserveAttempts } = await import(process.env.LEGACY_BUDGET_MODULE);
const req = JSON.parse(readFileSync(0, "utf8"));
const mode = process.env.LEGACY_MODE ?? "with-usage";

if (mode === "refusal") {
  process.stdout.write(JSON.stringify({
    text: "", error: "budget_exhausted", toolCalls: [],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    attempts: 0, budgetExhausted: true, budgetStop: "exhausted", request: { state: "refused" },
  }));
} else {
  reserveAttempts(req.budget.path, 1, "test-legacy", { limit: req.budget.limit, runId: req.budget.runId });
  const res = await fetch(`${req.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: req.model, messages: req.messages }),
  });
  const data = await res.json();
  const out = { text: data.text, error: "", toolCalls: [] };
  const wantsUsage = mode !== "without-usage" && mode !== "attempts1-no-usage" && mode !== "zero-submitted-no-usage";
  if (wantsUsage && data.usage) out.usage = data.usage;
  if (mode === "attempts1" || mode === "attempts1-no-usage") out.attempts = 1;
  if (mode === "attempts2") out.attempts = 2;
  if (mode === "submitted") out.request = { state: "submitted" };
  // ── F5：故意保留**互相矛盾**的元信息（但 HTTP 是真实发出去的）──
  if (mode === "zero-submitted") { out.attempts = 0; out.request = { state: "submitted" }; }
  if (mode === "zero-submitted-no-usage") { out.attempts = 0; out.request = { state: "submitted" }; }
  if (mode === "refused-usage") { out.attempts = 1; out.request = { state: "refused" }; }
  if (mode === "dryrun-usage") { out.attempts = 1; out.request = { state: "dry-run" }; }
  if (mode === "workloop-conflict") { out.attempts = 1; out.request = { state: data.hit === 2 ? "refused" : "submitted" }; }
  process.stdout.write(JSON.stringify(out));
}
