/**
 * 自研引擎的「同子集基线」：在 promptfoo 测试集完全相同的 126 条攻击用例
 * （probes_zh + probes_mt_zh + probes_agro 原始用例，不含 expand 变体）上
 * 跑三档位，得到与 compare.ts 同口径的 ASR，供交叉验证对照表使用。
 *
 * 为什么需要它：主评测基线（node src/run.ts）的 366 条里包含 expandProbes
 * 生成的变体，分母不同，直接拿 86.9%/39.6%/4.4% 与 promptfoo 的 126 条
 * 比对是不公平的。
 *
 * 用法：node subset-baseline.ts
 * 判定走自研 judge（与 promptfoo 断言互不依赖），unclear 不计入分母
 * （主评测口径）；逐条明细差异的解读见本目录 README「已知差异」。
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { loadJsonl } from "../src/attacks.ts";
import { AGRO_SYSTEM_PROMPT, CANARY } from "../src/config.ts";
import { buildProfile, PROFILES, type ProfileName } from "../src/guards.ts";
import { runEvaluation } from "../src/evaluate.ts";
import { AgroBot } from "../src/targets/agrobot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const DATA_DIR = join(REPO_ROOT, "data");

// 与 gen-tests.ts 完全一致的用例来源（三个语料文件全量、零过滤）
const seeds = [
  ...loadJsonl(join(DATA_DIR, "probes_zh.jsonl")),
  ...loadJsonl(join(DATA_DIR, "probes_mt_zh.jsonl")),
  ...loadJsonl(join(DATA_DIR, "probes_agro.jsonl")),
];

const target = new AgroBot(CANARY, AGRO_SYSTEM_PROMPT);

console.log(`同子集基线（自研引擎，${seeds.length} 条攻击用例，阈值 0.70，unclear 不计分母）：`);
console.log("");
console.log("档位         攻破数   unclear   ASR");
for (const name of Object.keys(PROFILES) as ProfileName[]) {
  const guarded = buildProfile(name, CANARY, 0.70);
  const { results, metrics } = runEvaluation(seeds, [], target, guarded, CANARY);
  const guardedOnly = results.filter((r) => r.mode === "guarded");
  const breach = guardedOnly.filter((r) => r.breach).length;
  const unclear = metrics.unclearGuarded;
  const asr = (breach / (seeds.length - unclear) * 100).toFixed(1);
  console.log(
    `${name.padEnd(12)} ${String(breach).padStart(3)}/${seeds.length}`.padEnd(21)
    + ` ${String(unclear).padStart(4)}    ${asr}%`,
  );
}
