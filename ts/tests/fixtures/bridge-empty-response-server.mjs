// 步骤 3 夹具：可控的 OpenAI 兼容替身，用来制造「HTTP 200 + 正文为空」这类不可归因形态。
// MODE=empty ⇒ choices[0].message.content = ""、finish_reason = "length"（模拟被截断/被过滤）
// MODE=text  ⇒ 正常文本（阳性对照）
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const MODE = process.env.MODE === "text" ? "text" : "empty";
const LOG = process.env.HITLOG || "";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    if (LOG) writeFileSync(LOG, `hit\n`, { flag: "a" });
    const payload = MODE === "text"
      ? { choices: [{ message: { content: "滴灌压力是 0.15 MPa。" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7 } }
      : { choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 11, completion_tokens: 0 } };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`READY ${server.address().port}\n`);
});
