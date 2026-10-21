// 测试夹具：跨进程并发占用额度用。argv[2] = 账本路径；stdout 输出 OK / REJECTED。
import { reserveAttempts } from "../../src/budget.ts";

try {
  reserveAttempts(process.argv[2], 1, "child-process");
  process.stdout.write("OK");
} catch {
  process.stdout.write("REJECTED");
}
