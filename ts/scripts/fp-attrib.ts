/**
 * P0-2 误报治理 · 词级归因分析（调参证据，一次性脚本）。
 *
 * 输出两部分：
 *   1. 阴性样本误拦明细：被拦样本命中了哪个规则组的哪个词
 *   2. leave-one-out：把「误伤嫌疑词」逐个从词表移除，看攻击输入侧拦截数掉多少
 *      —— 掉得少 = 误伤面大且攻击覆盖贡献小 = 可安全放宽。
 *
 * 用法：node scripts/fp-attrib.ts
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveDataRoot } from "../src/data-root.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
// M3-4：语料根目录走唯一解析入口
const DATA_DIR = resolveDataRoot({ repoRoot: join(TS_ROOT, "..") }).dir;

import { expandProbes, loadJsonl } from "../src/attacks.ts";
import { Normalizer, NATIVE_RULES, MT_RULES } from "../src/guards.ts";
import { NATIVE_GROUPS, MT_GROUPS } from "../src/lexicon.ts";
import { AGRO_SYSTEM_PROMPT, CANARY } from "../src/config.ts";
import { AgroBot } from "../src/targets/agrobot.ts";
import type { Probe } from "../src/types.ts";

// 复制 InputRuleGuard 逻辑但支持词表覆盖
function guardWith(overrides: Record<string, string[]>): {
  judge: (text: string) => [boolean, string[], number];
} {
  const groups = { ...NATIVE_GROUPS, ...MT_GROUPS };
  const rules = [...NATIVE_RULES, ...MT_RULES];
  return {
    judge: (text: string): [boolean, string[], number] => {
      const hits: string[] = [];
      let score = 0;
      for (const rule of rules) {
        const phrases = rule.group in overrides ? overrides[rule.group] : (groups[rule.group] ?? []);
        const h = phrases.find((p) => text.toLowerCase().includes(p.toLowerCase()));
        if (h) {
          hits.push(`${rule.group}:"${h}"`);
          score = Math.max(score, rule.weight);
        }
      }
      return [score >= 0.70, hits, score];
    },
  };
}

/** 与 pipeline 行为一致：多轮用例逐轮归一化+检测，任一轮拦截即算拦 */
function probeBlocked(p: Probe, judge: (t: string) => [boolean, ...unknown[]]): boolean {
  const turns = p.turns?.length ? p.turns : [p.text];
  for (const t of turns) {
    const normOut = norm2.process(t).text;
    if (judge(normOut)[0]) return true;
  }
  return false;
}
const norm2 = new Normalizer();

function main() {
  const nativeSeeds = loadJsonl(join(DATA_DIR, "probes_zh.jsonl"));
  const mtSeeds = loadJsonl(join(DATA_DIR, "probes_mt_zh.jsonl"));
  const agroSeeds = loadJsonl(join(DATA_DIR, "probes_agro.jsonl"));
  const benign = loadJsonl(join(DATA_DIR, "benign_zh.jsonl"));

  const baseSeeds = nativeSeeds.filter((p) => p.family !== "encoding_obfuscation");
  const variants = expandProbes(baseSeeds, 240);
  const probes: Probe[] = [...nativeSeeds, ...variants, ...mtSeeds, ...agroSeeds];
  const target = new AgroBot(CANARY, AGRO_SYSTEM_PROMPT);
  const norm = new Normalizer();

  // ---------- 1. 阴性误拦明细 ----------
  const g = guardWith({});
  const blockedIf = (p: Probe) => probeBlocked(p, g.judge);
  console.log("==== 1. 阴性样本误拦明细 ====");
  const suspectWords = new Map<string, number>(); // word -> 误拦次数
  let fpCount = 0;
  for (const b of benign) {
    const normOut = norm.process(b.text).text;
    const [blocked, hits] = g.judge(normOut);
    if (blocked) {
      fpCount++;
      console.log(`  ${b.id} 被拦: ${hits.join(" | ")}  ← ${b.text.slice(0, 30)}`);
      for (const h of hits) {
        const w = h.match(/:"(.+)"/)?.[1] ?? "";
        if (w) suspectWords.set(w, (suspectWords.get(w) ?? 0) + 1);
      }
    }
  }
  console.log(`误拦 ${fpCount}/${benign.length}\n`);

  // ---------- 2. leave-one-out ----------
  console.log("==== 2. 全词表 leave-one-out（种子级贡献） ====");
  const baseline = (() => {
    let n = 0;
    for (const p of probes) if (blockedIf(p)) n++;
    return n;
  })();
  console.log(`  基线输入侧拦截: ${baseline}/${probes.length}\n`);

  const allGroups: Record<string, string[]> = { ...NATIVE_GROUPS, ...MT_GROUPS };
  const baseId = (id: string) => id.replace(/-E\d+$/, "");

  // 每个词：种子级贡献 = 移除后失去拦截的种子数；并列出种子原文
  interface WordStat { word: string; group: string; seedLoss: number; seeds: string[] }
  const stats: WordStat[] = [];
  for (const [grp, phrases] of Object.entries(allGroups)) {
    for (const word of phrases) {
      const gg = guardWith({ [grp]: phrases.filter((p) => p !== word) });
      const blockedIfG = (p: Probe) => probeBlocked(p, gg.judge);
      let blocked = 0;
      const lostSeeds = new Map<string, string>();
      for (const p of probes) {
        if (blockedIfG(p)) blocked++;
        else if (blockedIf(p)) {
          const bid = baseId(p.id);
          if (!lostSeeds.has(bid)) lostSeeds.set(bid, p.text.slice(0, 36));
        }
      }
      stats.push({ word, group: grp, seedLoss: lostSeeds.size, seeds: [...lostSeeds.values()] });
    }
  }

  stats.sort((a, b) => a.seedLoss - b.seedLoss);
  for (const s of stats) {
    const tag = s.seedLoss === 0 ? "无贡献" : `${s.seedLoss} 种子`;
    console.log(`  [${s.group}] "${s.word}" — ${tag}`);
    if (s.seedLoss > 0 && s.seedLoss <= 3) {
      for (const t of s.seeds) console.log(`      ${t}`);
    }
  }
}

main();
