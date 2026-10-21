// 传输替身（Codex 复核项 5 的反例）：第 1 次请求返回 **500**，之后一律**直接断开连接**。
// 用途：逼出"先 submitted、后 not-connecting"的混合结果，检验桥报出的
// transportState / attemptId / requestSha256 **是否来自同一次尝试**。
import { createServer } from "node:http";

let n = 0;
const server = createServer((req, res) => {
  n++;
  req.resume();
  if (n === 1) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end('{"error":"synthetic 500"}');
    return;
  }
  // 后续：不发任何响应，直接断连（客户端 fetch 会抛错 ⇒ not-connecting）
  req.socket.destroy();
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  process.stdout.write(`READY ${typeof addr === "object" && addr ? addr.port : 0}\n`);
});
