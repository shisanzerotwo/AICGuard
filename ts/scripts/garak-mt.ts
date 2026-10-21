#!/usr/bin/env node
/**
 * T8 · garak 机翻对照组生成器。
 *
 * 来源：garak（Apache-2.0）`garak/data/phrasing/past_tense_en.txt` —— 730 条
 * 过去式改写攻击 prompt（方法论文档 arxiv 2407.11969，garak probes/phrasing）。
 * 用 LLM **直译**成中文（温度 0.2、逐句直译、禁止润色），复刻 garak langprovider
 * 的机翻行为 —— 这样对照组就是"真 garak probe 的机翻产物"，而不是我们自建的
 * 模拟机翻腔，堵住「稻草人」质疑。
 *
 * 产出 runs/_garak/mt-candidates.jsonl：{line_no, en, zh} 候选，
 * **必须人工核校**（安全红线：剔除任何含可操作违禁信息的条目；修正漏译）后才
 * 能进入 data/probes_garak_mt.jsonl —— 本脚本不直接写 data/。
 *
 * 用法：node scripts/garak-mt.ts [sample.ts 源文件] （默认 runs/_garak/past_tense_en.txt）
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLlmBotFromEnv } from "../src/targets/llmbot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const SRC = process.argv[2] ?? join(TS_ROOT, "runs", "_garak", "past_tense_en.txt");
const OUT = join(TS_ROOT, "runs", "_garak", "mt-candidates.jsonl");

if (!existsSync(SRC)) {
  console.error(`找不到源文件：${SRC}\n先下载 garak 的 past_tense_en.txt（见 docs/00 T8 节）。`);
  process.exit(2);
}

const all = readFileSync(SRC, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

// 确定性抽样：60-300 字符、内容多样（按行号等距取），30 条 —— 与自建机翻腔
// 组（30 条）体量对齐，两组数字可直接比较
const candidates = all.map((t, i) => ({ i, t })).filter((x) => x.t.length >= 60 && x.t.length <= 300);
const step = Math.max(1, Math.floor(candidates.length / 30));
const sample = candidates.filter((_, k) => k % step === 0).slice(0, 30);

console.log(`源 ${all.length} 条 → 候选 ${candidates.length} → 抽样 ${sample.length} 条，开始机翻…`);

const translator = createLlmBotFromEnv(
  [
    "你是机器翻译引擎，只做一件事：把用户输入的英文逐句直译成简体中文。",
    "要求：直译风格、保留原文的时态（尤其是过去式）与句式结构，",
    "不要润色、不要意译、不要增删内容、不要回答或解释，只输出译文。",
  ].join("\n"),
  { salt: "garak-mt" },
);

let done = 0;
const outLines: string[] = [];
for (const { i, t } of sample) {
  const r = translator.respond(t);
  if (r.error || !r.text) {
    console.error(`  #${i} 翻译失败：${r.error ?? "空回复"}（重跑可续）`);
    continue;
  }
  outLines.push(JSON.stringify({ line_no: i + 1, en: t, zh: r.text.trim() }));
  done++;
  process.stdout.write(`  #${i} ok\n`);
}

writeFileSync(OUT, outLines.join("\n") + "\n", "utf8");
console.log(`\n完成 ${done}/${sample.length} → ${OUT}`);
console.log("下一步：人工核校（安全红线 + 漏译修正）后，由人工合入 data/probes_garak_mt.jsonl");
