// 本地 transport 替身（P3 返工项 3 验收用）：一个真的 HTTP 服务器，把**实际收到的请求正文**
// 原样落盘，供测试与桥报回的 requestSha256 逐字核对。
//
// 安全：**只记 header 名、不记值**（值里有 Authorization 凭据；凭据与认证头不得落盘），
// 正文本身不含凭据（key 走 header），因此可以原样记录。
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const out = process.argv[2];
const server = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    appendFileSync(out, `${JSON.stringify({
      method: req.method,
      url: req.url,
      // 只记名字（值一律不落盘）
      headerNames: Object.keys(req.headers).sort(),
      hasAuthorization: Boolean(req.headers.authorization),
      body,
    })}\n`, "utf8");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: "替身回复：请按登记说明使用。" } }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    }));
  });
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  process.stdout.write(`READY ${typeof addr === "object" && addr ? addr.port : 0}\n`);
});
