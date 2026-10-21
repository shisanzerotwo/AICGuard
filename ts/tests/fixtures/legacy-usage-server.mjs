// 本机替身服务器（F4 反例用）：返回 `{text, usage}`，并**独立记录**实际收到的请求数。
// `NO_USAGE_HITS`（逗号分隔的命中序号）用于模拟"某几次调用供应商没有报用量"。
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const out = process.argv[2];
const noUsage = new Set((process.argv[3] ?? "").split(",").filter((s) => s !== "").map(Number));
let hits = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    hits++;
    appendFileSync(out, `${hits}\n`, "utf8");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      text: "legacy healthy answer",
      hit: hits,
      ...(noUsage.has(hits) ? {} : { usage: { prompt_tokens: 7, completion_tokens: 11 } }),
    }));
  });
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  process.stdout.write(`READY ${typeof addr === "object" && addr ? addr.port : 0}\n`);
});
