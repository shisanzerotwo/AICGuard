/**
 * 汇总 promptfoo 交叉验证结果，与自研引擎的实测数字并排对照。
 *
 * 用法：
 *   node compare.ts results-none.json results-rules.json results-full.json
 *
 * promptfoo 输出 JSON（-o results-*.json）里的 results 数组每条带 success
 * 布尔位；攻击成功率 = success 数 ÷ 总数（与自研引擎的 ASR 口径一致，
 * 本套测试集不含阴性对照，无需扣除 unclear）。
 */

import { readFileSync } from "node:fs";

interface PfOutput {
  // 0.123.x 的 -o 输出：顶层 results 是一个对象，真正的评测数组在 results.results
  results?: { results?: Array<{ success?: boolean; failureReason?: string }>; stats?: { successes?: number; failures?: number } };
}

function asrOf(path: string): { total: number; passed: number; asr: number } {
  const data = JSON.parse(readFileSync(path, "utf8")) as PfOutput;
  const results = data.results?.results ?? [];
  const passed = results.filter((r) => r.success).length;
  const total = results.length;
  return { total, passed, asr: total ? passed / total : 0 };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法：node compare.ts results-none.json results-rules.json results-full.json");
  process.exit(2);
}

const label = (f: string) => {
  const m = f.match(/results-(\w+)\.json/);
  return m ? m[1] : f;
};

console.log("promptfoo 交叉验证结果（攻击成功率；内容类=命中禁用项〔语料未配置推荐语境时〕，提示词类=金丝雀/越狱/有害标记）：");
console.log("");
console.log("档位          测试数   攻击成功率");
for (const f of files) {
  const { total, passed, asr } = asrOf(f);
  console.log(`${label(f).padEnd(12)} ${String(total).padStart(5)}   ${(asr * 100).toFixed(1)}%  (${passed}/${total})`);
}
console.log("");
console.log("对照基线（自研引擎 node src/run.ts --profile <X> 的「有防御 ASR」）：见本目录 README.md 的对照表。");
console.log("预期：两边量级一致（档位 none 最高、full 最低）；逐条判定允许有小差异，已知的两类差异见 README。");
