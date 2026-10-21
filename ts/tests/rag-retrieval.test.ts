/**
 * RAG 检索核心回归测试（M5-1，`docs/31-M5任务卡（接入RAG）.md` §3）。
 *
 * 契约来源：`docs/15` §4.1「固定首版检索配置」——
 *   本地静态文档；按 **Unicode 字符**切块，每块 **400 字符**、重叠 **50 字符**；
 *   对**查询与片段做一致规范化**，以**字符二元组重合数**排序；仅保留**正分**片段，`topK=3`；
 *   同分按**文档 ID、片段序号**排序；上下文正文上限 **1000 字符**，按排序依次填充，**记录截断位置**。
 *
 * 测试**不联网、不调模型、不读语料**：只锁"配置与排序规则"本身（对等的最小离线入口）。
 * 反例优先：空文档 / 恰好 400 / 接缝重叠 / 代理对不被劈开 / 同分排序与输入顺序无关 / 截断位置可复算。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RAG_CONFIG, bigramOverlap, buildContext, chunkDocument, normalizeMatch, retrieve,
  type RagChunk,
} from "../src/rag.ts";

/** 构造一段可预测的中文文本：'甲' 起头的连续汉字（第 i 个字 = 码点 0x4e00+i） */
const han = (n: number): string => String.fromCodePoint(...Array.from({ length: n }, (_, i) => 0x4e00 + (i % 1000)));

test("配置按契约冻结：400/50、topK=3、上下文 1000 字符", () => {
  assert.equal(RAG_CONFIG.chunkChars, 400);
  assert.equal(RAG_CONFIG.overlapChars, 50);
  assert.equal(RAG_CONFIG.topK, 3);
  assert.equal(RAG_CONFIG.contextChars, 1000);
  assert.equal(RAG_CONFIG.stride, 350, "步进 = 块长 − 重叠 = 350（由前两项派生，不得另配一个值）");
});

test("切块：按 Unicode 字符切，起点可复算（0/350/700…），末块可短", () => {
  const text = han(1000);
  const chunks = chunkDocument("docA", text);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.start), [0, 350, 700]);
  assert.deepEqual(chunks.map((c) => Array.from(c.text).length), [400, 400, 300]);
  assert.deepEqual(chunks.map((c) => c.index), [0, 1, 2]);
  assert.ok(chunks.every((c) => c.docId === "docA"));
});

test("切块边界：空文档 ⇒ 0 块；恰好 400 ⇒ 1 块；401 ⇒ 2 块（第 2 块 51 字符）", () => {
  assert.equal(chunkDocument("e", "").length, 0);
  assert.equal(chunkDocument("e", "   \n  ").length, 0, "全空白视为空文档（不得产出空块）");
  assert.equal(chunkDocument("d", han(400)).length, 1);
  const two = chunkDocument("d", han(401));
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((c) => Array.from(c.text).length), [400, 51], "第 2 块 = 401 − 350 = 51 字符（重叠 50）");
});

test("接缝：相邻块逐字重叠 50 个字符（可复算，不靠感觉）", () => {
  const text = han(1000);
  const [a, b] = chunkDocument("d", text);
  const tail50 = Array.from(a.text).slice(-50).join("");
  const head50 = Array.from(b.text).slice(0, 50).join("");
  assert.equal(tail50, head50, "上一块的末 50 字 == 下一块的头 50 字");
});

test("Unicode：代理对（emoji）不被劈开 —— 每块都是合法字符序列", () => {
  const text = "🙂".repeat(500); // 500 个 emoji = 500 个码点（1000 个 UTF-16 码元）
  const chunks = chunkDocument("emoji", text);
  assert.equal(chunks.length, 2, "500 码点 → 起点 0 与 350 ⇒ 2 块（400 + 150）");
  for (const c of chunks) {
    assert.equal(Array.from(c.text).length, c.text.length / 2, "每个 UTF-16 码元都成对（无孤立代理）");
    assert.ok(!/\uFFFD/.test(c.text));
  }
  assert.equal(Array.from(chunks[0].text).length, 400, "按**码点**计 400，不是按码元 400");
  assert.equal(Array.from(chunks[1].text).length, 150);
});

test("规范化：查询与片段走同一个函数（大小写/空白/标点差异不产生分差）", () => {
  assert.equal(normalizeMatch("甲　乙，丙。"), normalizeMatch("甲乙丙"));
  assert.equal(normalizeMatch("ABC-d ef!"), "abcdef", "英文大小写与分隔符同样被抹平");
  assert.equal(normalizeMatch("A B C-d ef!"), normalizeMatch("abc def"), "空白与标点都不参与比对");
  assert.notEqual(normalizeMatch("abcdeф"), normalizeMatch("abcdеф"), "不同字母表不得被当同一字符（防我上次混用西里尔/拉丁的错）");
});

test("计分：字符二元组**重合数**（多重集交集，不是布尔集）", () => {
  assert.equal(bigramOverlap("甲乙丙丁", "甲乙丙丁"), 3, "4 字 → 3 个二元组，全重合");
  assert.equal(bigramOverlap("甲乙丙丁", "甲乙"), 1, "『甲乙』两字 → 1 个二元组");
  assert.equal(bigramOverlap("甲乙丙丁", "丙丁甲乙"), 2, "重排会改变分数（只共享「甲乙」「丙丁」两个二元组）——口径副作用，如实锁住");
  assert.equal(bigramOverlap("甲乙丙丁", "戊己庚辛"), 0);
  assert.equal(bigramOverlap("甲", "甲乙"), 0, "不足两字 ⇒ 无二元组（不得退化成单字匹配）");
});

test("检索：只保留正分、按分数降序、topK=3", () => {
  // 查询『甲乙丙』⇒ 二元组 {甲乙, 乙丙}（共 2 个）
  const chunks: RagChunk[] = [
    { docId: "d1", index: 0, start: 0, text: "甲乙丙" },    // 2 分（最高，与 d3#0 同分）
    { docId: "d1", index: 1, start: 350, text: "甲乙丁" },  // 1 分
    { docId: "d2", index: 0, start: 0, text: "乙丙丁" },    // 1 分
    { docId: "d2", index: 1, start: 350, text: "戊己庚辛" },// 0 分（必须被丢掉）
    { docId: "d3", index: 0, start: 0, text: "甲乙丙丁" },  // 2 分
  ];
  const hit = retrieve("甲乙丙", chunks);
  assert.deepEqual(hit.map((c) => `${c.docId}#${c.index}:${c.score}`), ["d1#0:2", "d3#0:2", "d1#1:1"],
    "降序 → 同分（2 分）按 docId → 再按 index；topK=3 把 d2#0 的同分项挤掉");
  assert.deepEqual(retrieve("毫不相干", chunks), [], "全无重合 ⇒ 空数组（不是返回 0 分片段）");
});

test("检索同分对照：三条『灌溉排水*』并列 3 分 ⇒ 按（docId, index）给出，与输入顺序无关", () => {
  const chunks: RagChunk[] = [
    { docId: "d1", index: 0, start: 0, text: "灌溉排水管理" },
    { docId: "d2", index: 0, start: 0, text: "灌溉排水与育苗" },
    { docId: "d3", index: 0, start: 0, text: "灌溉排水管理细则" },
    { docId: "d2", index: 1, start: 350, text: "完全无关的内容" },
  ];
  // 『灌溉排水』的 3 个二元组在三条里都齐 ⇒ 并列 3 分（**更长不会加分**，这点常被想当然）
  assert.deepEqual(chunks.slice(0, 3).map((c) => bigramOverlap("灌溉排水", c.text)), [3, 3, 3]);
  const a = retrieve("灌溉排水", chunks).map((c) => `${c.docId}#${c.index}`);
  const b = retrieve("灌溉排水", [...chunks].reverse()).map((c) => `${c.docId}#${c.index}`);
  assert.deepEqual(a, ["d1#0", "d2#0", "d3#0"]);
  assert.deepEqual(a, b, "与输入顺序无关（确定性）");
});

test("确定性：同分按（文档 ID，片段序号）排序，与输入顺序无关", () => {
  const mk = (docId: string, index: number): RagChunk => ({ docId, index, start: index * 350, text: "甲乙丙丁" });
  const asc = [mk("b", 1), mk("a", 1), mk("a", 0), mk("b", 0)];
  const desc = [...asc].reverse();
  const a = retrieve("甲乙丙丁", asc).map((c) => `${c.docId}#${c.index}`);
  const b = retrieve("甲乙丙丁", desc).map((c) => `${c.docId}#${c.index}`);
  assert.deepEqual(a, b, "同分时结果与输入顺序无关");
  assert.deepEqual(a, ["a#0", "a#1", "b#0"], "同分按 docId 再按 index");
});

test("上下文装配：≤1000 字符、按排序依次填充、**截断位置可复算**", () => {
  const mk = (docId: string, index: number, n: number): RagChunk => ({ docId, index, start: 0, text: han(n) });
  const ctx = buildContext([mk("d1", 0, 400), mk("d1", 1, 400), mk("d1", 2, 400)]);
  assert.equal(Array.from(ctx.text).length, 1000, "总量恰好顶到上限");
  assert.deepEqual(
    ctx.entries.map((e) => [e.docId, e.index, e.keptChars, e.totalChars, e.truncated]),
    [["d1", 0, 400, 400, false], ["d1", 1, 400, 400, false], ["d1", 2, 200, 400, true]],
    "逐块记录保留/原始字符数与是否被截断",
  );
  assert.equal(ctx.truncatedAt, 1000, "记录截断位置（= 上限处）");
});

test("上下文装配反例：块全放得下 ⇒ 不截断、位置为 null、顺序保持", () => {
  const mk = (docId: string, index: number, n: number): RagChunk => ({ docId, index, start: 0, text: han(n) });
  const ctx = buildContext([mk("z", 0, 10), mk("a", 0, 10)]);
  assert.equal(ctx.truncatedAt, null);
  assert.ok(ctx.entries.every((e) => !e.truncated));
  assert.deepEqual(ctx.entries.map((e) => e.docId), ["z", "a"], "装配顺序 = 传入顺序（调用方负责先按检索排序）");
});
