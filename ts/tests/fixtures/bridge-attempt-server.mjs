// 传输替身（Codex 复核 R1/D1 反例用）：按 MODE 复现**响应侧**的各种形态，并把**实际收到的请求数**落盘。
//
// 为什么需要它：R1 的缺陷是"HTTP 已经响应、但响应解析失败"时，桥把**已经定案的送达事实**
// （submitted）改写成了 not-connecting；D1 的缺陷是 429/5xx 的状态错误**不归属到该次 attempt**
// （只写 lastErr），于是"500 → 非法 JSON → 预算拒绝"整条错误链里第一错凭空消失。
// 要证明修好了，必须有一个**独立于桥的**计数源（本文件落盘的行数）来核对
// "一次真实 HTTP 尝试 ⇔ 一条带正文的逐次记录"。
//
// MODE（SEQ 是**按请求序号**的响应表；超出表长后一律返回健康响应）：
//   healthy                    —— 200 + 合法 JSON（阴性对照：证明检查不是"永远报解析错"）
//   invalid-json               —— 每次 200 + 非法 JSON（连接成功、解析失败）
//   broken-body                —— 每次 400 但声明 Content-Length:100、只发 10 字节后断开（响应体读取失败）
//   http500-then-invalid-json   —— 500 → 200非法JSON → 健康（配 limit=2 ⇒ 第三次发送前被预算拒绝）
//   429-then-invalid-json       —— 429 → 200非法JSON → 健康（同形，验证限流也留痕）
//   recover-500                —— 500 → 健康（**恢复成功**：历史错误不得变成调用级失败）
//   recover-parse              —— 200非法JSON → 健康（同上）
//   malformed-tool-calls       —— JSON 合法但 `message.tool_calls` 是对象（E1：解析半途失败不得泄出残留文本）
//   malformed-tool-calls-array —— 数组里第 1 项合法、第 2 项畸形（E1：**防半数组泄漏**）
//   usage-no-report-500        —— 健康(usage 7/11) → HTTP500（**响应体没有 usage**）——E2 的"已提交后用量未知"
//   usage-partial-then-500     —— 健康(7/11) → 工具调用轮(7/11) → HTTP500（无 usage）——E2 的"下界"
//   usage-zero                 —— 每次 200 健康但**供应商明确报告 usage 0**（确认零 ≠ 未知）
//   usage-empty / -array / -prompt-only / -string / -negative
//                              —— 200 健康但用量**不完整/非法**（F1：不得当完整成本，也不得把答复变失败）
//   usage-empty-2nd            —— 健康(7/11) → 健康但 `usage:{}`（F1 的 Work Loop 场景）
//   usage-500-then-ok           —— 健康(7/11) → HTTP500(无 usage) → 健康(7/11)（F3：同一桥内恢复，成本只是下界）//
// 安全：只记 mode 一行，不记 header/正文（凭据走 Authorization 头，本替身一律不落盘）。
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const out = process.argv[2];
const mode = process.argv[3] ?? "healthy";
const SEQ = {
  healthy: ["ok"],
  "invalid-json": ["invalid"],
  "broken-body": ["broken"],
  "http500-then-invalid-json": ["http500", "invalid"],
  "429-then-invalid-json": ["429", "invalid"],
  "recover-500": ["http500"],
  "recover-parse": ["invalid"],
  "malformed-tool-calls": ["malformed-calls"],
  "malformed-tool-calls-array": ["malformed-calls-array"],
  "usage-no-report-500": ["ok7-11", "http500"],
  "usage-partial-then-500": ["ok7-11", "tool", "http500"],
  "usage-zero": ["ok0"],
  "usage-empty": ["usage-empty"],
  "usage-array": ["usage-array"],
  "usage-prompt-only": ["usage-prompt-only"],
  "usage-string": ["usage-string"],
  "usage-negative": ["usage-negative"],
  "usage-empty-2nd": ["ok7-11", "usage-empty"],
  "usage-500-then-ok": ["ok7-11", "http500", "ok7-11"],
  "http500-then-ok7-11": ["http500", "ok7-11"],
};
const table = SEQ[mode] ?? ["ok"];
// 这几个 mode 是**恒定形态**（每次请求都同样回应，不随序号变化）——否则"HTTP 200 非法 JSON"
// 会在第 2 次请求变成健康响应，把"解析失败"的反例悄悄变成"恢复成功"。
const REPEAT = { "invalid-json": "invalid", "broken-body": "broken", "usage-zero": "ok0", "usage-prompt-only": "usage-prompt-only" };
const healthy = (usage) => JSON.stringify({
  choices: [{ message: { content: "替身回复" } }],
  usage: usage ?? { prompt_tokens: 3, completion_tokens: 5 },
});
/** 工具调用轮：AgentBot 本地执行后还会再发一轮 */
const toolCallBody = JSON.stringify({
  choices: [{ message: { content: "", tool_calls: [{ type: "function", function: { name: "search_knowledge", arguments: '{"keyword":"滴灌"}' } }] } }],
  usage: { prompt_tokens: 7, completion_tokens: 11 },
});
/** E1：JSON 合法但 tool_calls 不是数组 ⇒ 解析必须**半途失败且不泄出残留文本** */
const malformedCallsBody = JSON.stringify({
  choices: [{ message: { content: "partial-parse-text", tool_calls: { unexpected: "object" } } }],
  usage: { prompt_tokens: 7, completion_tokens: 11 },
});
/** E1：数组第 1 项合法、第 2 项畸形 ⇒ 第一项**也不得**被提交（防半数组泄漏） */
const malformedCallsArrayBody = JSON.stringify({
  choices: [{ message: { content: "partial-array-text", tool_calls: [
    { type: "function", function: { name: "search_knowledge", arguments: "{}" } },
    { type: "function", function: null },
  ] } }],
  usage: { prompt_tokens: 7, completion_tokens: 11 },
});

let hits = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    hits++;
    // ★ 独立计数源：每次**真实 HTTP 请求**记一行（桥报回的数字要与它对账）
    appendFileSync(out, `${mode}\n`, "utf8");
    // 恒定形态优先；否则依次序表回应，超出表长一律健康响应
    const step = REPEAT[mode] ?? (hits <= table.length ? table[hits - 1] : "ok");
    if (step === "invalid") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"choices": [ 这不是 JSON');
      return;
    }
    if (step === "http500" || step === "429") {
      res.writeHead(step === "http500" ? 500 : 429, { "Content-Type": "application/json" });
      res.end('{"error":"synthetic"}');
      return;
    }
    if (step === "broken") {
      res.writeHead(400, { "Content-Type": "application/json", "Content-Length": "100" });
      res.flushHeaders();
      res.write('{"error":');
      setImmediate(() => res.socket?.destroy());
      return;
    }
    if (step === "malformed-calls") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(malformedCallsBody);
      return;
    }
    if (step === "malformed-calls-array") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(malformedCallsArrayBody);
      return;
    }
    if (step === "tool") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(toolCallBody);
      return;
    }
    if (step === "usage-empty" || step === "usage-array" || step === "usage-prompt-only"
      || step === "usage-string" || step === "usage-negative") {
      // F1：这些都是"HTTP 200 + 健康回答，但用量不完整/非法"——回答仍应成功，成本不得算完整
      const bad = step === "usage-empty" ? {}
        : step === "usage-array" ? []
        : step === "usage-prompt-only" ? { prompt_tokens: 7 }
        : step === "usage-string" ? { prompt_tokens: "7", completion_tokens: 11 }
        : { prompt_tokens: -7, completion_tokens: 11 };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "替身回复" } }], usage: bad }));
      return;
    }
    if (step === "ok0") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(healthy({ prompt_tokens: 0, completion_tokens: 0 }));
      return;
    }
    if (step === "ok7-11") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(healthy({ prompt_tokens: 7, completion_tokens: 11 }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(healthy());
  });
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  process.stdout.write(`READY ${typeof addr === "object" && addr ? addr.port : 0}\n`);
});
