/**
 * RAG 检索核心（M5-1）—— `docs/15` §4.1「固定首版检索配置」的最小实现。
 *
 * 配置（**冻结，不得调参**：调参会让留出集按 §3.2 退役，见 `docs/31` §2 D1）：
 *   · 按 **Unicode 字符**（码点）切块，每块 **400 字符**、重叠 **50 字符** ⇒ 步进 **350**；
 *   · 查询与片段过**同一**规范化，以**字符二元组重合数**（多重集交集）排序；
 *   · 仅保留**正分**片段，`topK=3`；同分按（文档 ID，片段序号）；
 *   · 上下文正文上限 **1000 字符**，按排序依次填充，**记录截断位置**。
 *
 * 本模块**纯确定性**：不联网、不调模型、不读文件。文档装载与 source/口径记录属上层（M5-2/M5-6）。
 * 首版**只验证"检索文档注入"**，不宣称验证向量检索质量（§4.1）。
 */
export interface RagChunk {
  docId: string;
  /** 片段序号（同一文档内从 0 起） */
  index: number;
  /** 该片段在文档中的**码点**起点 */
  start: number;
  text: string;
}

export interface RagConfig {
  chunkChars: number;
  overlapChars: number;
  /** 派生值：步进 = chunkChars − overlapChars（**不单独配置**，避免两处不一致） */
  stride: number;
  topK: number;
  contextChars: number;
}

export const RAG_CONFIG: RagConfig = {
  chunkChars: 400,
  overlapChars: 50,
  stride: 400 - 50,
  topK: 3,
  contextChars: 1000,
};

/**
 * 一致规范化：只留**字母与数字**（抹掉空白与全部标点，含中文标点），再小写。
 * 查询与片段必须走同一个函数，否则"看起来一样"的两段文本会算出不同分数。
 */
export function normalizeMatch(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/** 字符二元组多重集（不足两字 ⇒ 空集，**不退化成单字匹配**） */
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = normalizeMatch(s);
  for (let i = 0; i + 1 < t.length; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/**
 * 字符二元组**重合数**：多重集交集大小 `Σ_g min(countA[g], countB[g])`。
 * 为什么用多重集而不是布尔集：重复片段（如"灌溉灌溉"）确实与查询更贴，布尔集会把这种差异抹平。
 * 注意口径副作用：**重排会改变分数**（『甲乙丙丁』与『丙丁甲乙』共享 2 个二元组，不是 3），已由测试锁住。
 */
export function bigramOverlap(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  let n = 0;
  for (const [g, c] of A) n += Math.min(c, B.get(g) ?? 0);
  return n;
}

/** 按码点切块；全空白视为空文档（不产出空块） */
export function chunkDocument(docId: string, text: string, cfg: RagConfig = RAG_CONFIG): RagChunk[] {
  if (text.trim() === "") return [];
  const cps = Array.from(text); // 按码点，避免劈开代理对
  const out: RagChunk[] = [];
  let index = 0;
  for (let i = 0; i < cps.length; i += cfg.stride) {
    out.push({ docId, index: index++, start: i, text: cps.slice(i, i + cfg.chunkChars).join("") });
    if (i + cfg.chunkChars >= cps.length) break; // 末块已含剩余全部
  }
  return out;
}

export interface ScoredChunk extends RagChunk {
  /** 与该次查询的字符二元组重合数（> 0 才会被返回） */
  score: number;
}

/**
 * 检索：算分 → 只留正分 → 降序 → **同分按（docId, index）** → `topK`。
 * 同分规则是**确定性**的关键：否则同一份文档换一次装载顺序就会得到不同上下文，报告不可复算。
 */
export function retrieve(query: string, chunks: readonly RagChunk[], cfg: RagConfig = RAG_CONFIG): ScoredChunk[] {
  const scored: ScoredChunk[] = [];
  for (const c of chunks) {
    const score = bigramOverlap(query, c.text);
    if (score > 0) scored.push({ ...c, score });
  }
  scored.sort((x, y) =>
    y.score - x.score
    || (x.docId < y.docId ? -1 : x.docId > y.docId ? 1 : 0)
    || x.index - y.index);
  return scored.slice(0, cfg.topK);
}

export interface ContextEntry {
  docId: string;
  index: number;
  /** 实际写入上下文的字符数 */
  keptChars: number;
  /** 该片段的原始字符数 */
  totalChars: number;
  truncated: boolean;
}

export interface RagContext {
  text: string;
  entries: ContextEntry[];
  /** 发生截断时记录**截断位置**（= 上限处，码点计数）；未截断为 null */
  truncatedAt: number | null;
}

/**
 * 上下文装配：按**传入顺序**依次填充（调用方负责先按检索排序），总量 ≤ `contextChars`，
 * 遇到放不下的片段**就地截断并停止**（不跳过后面的片段——那会造成"看起来送达了其实不是"）。
 * 逐块记录保留/原始字符数与是否被截断；这些数字是后续"截断丢失"口径（§4.2）的唯一出处。
 */
export function buildContext(chunks: readonly RagChunk[], cfg: RagConfig = RAG_CONFIG): RagContext {
  const entries: ContextEntry[] = [];
  const parts: string[] = [];
  let used = 0;
  let truncatedAt: number | null = null;
  for (const c of chunks) {
    const cps = Array.from(c.text);
    const room = cfg.contextChars - used;
    if (room <= 0) { truncatedAt = cfg.contextChars; break; }
    const keep = Math.min(cps.length, room);
    const truncated = keep < cps.length;
    if (truncated && truncatedAt === null) truncatedAt = cfg.contextChars;
    parts.push(cps.slice(0, keep).join(""));
    entries.push({ docId: c.docId, index: c.index, keptChars: keep, totalChars: cps.length, truncated });
    used += keep;
  }
  return { text: parts.join(""), entries, truncatedAt };
}
