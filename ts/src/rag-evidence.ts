/**
 * RAG 控制台证据页（M5-7）—— 自包含单文件 HTML（无外部资源、无脚本依赖）。
 *
 * 为什么由**评测脚本侧**渲染，而不是由服务器拼：`ts/src/server.ts` 的既有纪律是
 * 「只做编排与只读转述」——证据必须来自**评测产物**本身，不能由控制台二次加工，
 * 否则「页面显示的证据」和「落盘的证据」会变成两份东西。
 *
 * 五类证据（`docs/31` §3 M5-7 / `docs/15` §4.1）：
 *   ① 检索排名 ② 选中片段（装配后顺序）③ 阻断 ④ 送达 ⑤ 判定
 * 每一类都只呈现**可复算的原字段**（分值、保留字符数、截断位置、请求哈希、无效原因），
 * 不在这里做任何新的计算或解释性结论。
 */
import type { RagCaseEvidence, RagReportPayload } from "./rag-report.ts";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pct = (v: number | null): string => (v === null ? "不可计算" : `${(v * 100).toFixed(2)}%`);
const yn = (b: boolean): string => (b ? "是" : "否");

const CSS = `body{font:14px/1.6 system-ui,"Segoe UI",sans-serif;max-width:1180px;margin:24px auto;padding:0 16px;color:#1a1a1a}
h1{font-size:21px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 8px;border-bottom:1px solid #e3e3e3;padding-bottom:4px}
h3{font-size:14px;margin:14px 0 6px}table{border-collapse:collapse;width:100%;margin:8px 0}
th,td{border:1px solid #ddd;padding:5px 7px;text-align:left;font-size:12.5px;vertical-align:top}
th{background:#f6f8fa;font-weight:600}code,pre{font-family:ui-monospace,Consolas,monospace;font-size:12px}
pre{background:#f6f8fa;padding:8px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:6px 0}
.ok{color:#0a7a2f;font-weight:600}.bad{color:#b3261e;font-weight:600}.warn{color:#9a6700;font-weight:600}
.meta{color:#555;font-size:12px}.case{border:1px solid #e3e3e3;border-radius:6px;padding:10px 12px;margin:12px 0}
.case h3{margin-top:0}details{margin:4px 0}summary{cursor:pointer;font-size:12.5px;color:#0b5cad}
.tag{display:inline-block;border:1px solid #ccc;border-radius:3px;padding:0 5px;font-size:11.5px;margin-right:5px}
.ev{border-left:3px solid #d0d7de;padding-left:9px;margin:9px 0}`;

function fiveEvidence(e: RagCaseEvidence): string {
  // ① 检索排名
  const ranked = e.ranked.length
    ? `<table><tr><th>#</th><th>文档</th><th>块序</th><th>分值</th></tr>${e.ranked
        .map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.docId)}</td><td>${r.index}</td><td>${r.score}</td></tr>`).join("")}</table>`
    : `<p class="meta">（无正分块 ⇒ 自然检索未命中）</p>`;
  // ② 选中片段（装配后顺序）
  const selected = e.selected.length
    ? `<table><tr><th>序</th><th>文档</th><th>块序</th><th>分值</th><th>来源</th><th>护栏改写</th><th>保留字符</th><th>截断</th><th>被拦</th></tr>${e.selected
        .map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.docId)}</td><td>${s.index}</td><td>${s.score}</td>`
          + `<td>${s.score === 0 ? "<strong>装配（非检索得分）</strong>" : "检索"}</td>`
          + `<td>${yn(s.rewritten)}</td><td>${s.keptChars ?? "-"}</td>`
          + `<td>${s.truncated === null ? "-" : s.truncated ? "<span class=warn>截断</span>" : "完整"}</td>`
          + `<td>${s.blocked ? `<span class=bad>${esc(s.blockedBy)}</span>` : "-"}</td></tr>`).join("")}</table>`
    : `<p class="meta">（无选中片段）</p>`;
  // ③ 阻断
  const blocked = `<p>查询护栏：<code>${esc(e.queryGuard.verdicts.join("，") || "-")}</code>`
    + `${e.queryGuard.blocked ? ` ⇒ <span class=bad>查询被拦（${esc(e.queryGuard.blockedBy)}）</span>` : ""}</p>`
    + `<p>任务阻断：${e.blockedStage ? `<span class=bad>阶段 <code>${esc(e.blockedStage)}</code>，组件 <code>${esc(e.blockedBy)}</code></span>`
      : `<span class=ok>未被阻断</span>`}</p>`;
  // ④ 送达
  const retention = e.delivered ? "1（完整送达）" : e.retentionRatio === null ? "未保留" : String(e.retentionRatio);
  const delivery = `<p>送达：<span class="${e.delivered ? "ok" : "bad"}">${yn(e.delivered)}</span>`
    + `｜保留比 ${retention}｜送出字符 ${e.sentChars}｜上下文 ${e.contextChars} 字符`
    + `｜截断位置 ${e.truncatedAt ?? "无"}</p>`
    + `<p class="meta">请求正文 sha256：<code>${e.requestSha256}</code></p>`
    + (e.notes.length ? `<ul>${e.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "");
  // ⑤ 判定
  const forced = e.condition === "forced"
    ? `<p>强制送达：装配 ${e.forcedAssembled ? "成功" : "<span class=bad>未成功（退回自然检索）</span>"}`
      + `｜固定位置 ${e.forcedPosition ?? "-"}｜按约定送达 ${e.forcedMet === null ? "n/a（被拦）" : e.forcedMet ? "是" : "<span class=bad>否</span>"}</p>`
    : "";
  // 判定 = 三级优先（与外层 Markdown 的「判定为」列**同一套口径**，Codex 复核 R6）：
  // 未执行 > 夹具无效 > 执行状态非 ok；只有执行过且 ok 且无无效原因才是有效测试。
  // ⚠️ 离线行（status=ok + invalidReason=null）渲染结果与修前**逐字节一致**（保留「无（有效测试）」），
  //    新分支只覆盖真实通道才可能出现的两种状态（未执行 / 执行了但没跑成）。
  const judged = e.unexecuted === true ? "<span class=bad>未执行（预算中止）</span>"
    : e.invalidReason ? `<span class=bad><code>${e.invalidReason}</code></span>`
    : e.status !== "ok" ? `<span class=bad>未判定（<code>${e.status}</code>）</span>`
    : "无（有效测试）";
  const judge = `<p>执行状态 <code>${e.status}</code>｜攻击判定 <code>${e.verdict}</code>｜无效原因 ${judged}</p>`
    + forced;

  return `<div class="ev"><h3>① 检索排名</h3>${ranked}</div>
<div class="ev"><h3>② 选中片段（装配后顺序）</h3>${selected}</div>
<div class="ev"><h3>③ 阻断</h3>${blocked}</div>
<div class="ev"><h3>④ 送达</h3>${delivery}</div>
<div class="ev"><h3>⑤ 判定</h3>${judge}</div>
<details><summary>低权限引用正文（送入靶子的上下文，${e.contextChars} 字符）</summary><pre>${esc(e.contextText) || "（空）"}</pre></details>`;
}

export function renderRagEvidenceHtml(p: RagReportPayload): string {
  const c = p.metrics.coverage;
  const e2e = p.metrics.endToEnd;
  const d = p.metrics.deliveredOnly;
  const caseCards = p.cases.length
    ? p.cases.map((e) => `<div class="case">
<h3>${esc(e.id)} <span class="tag">${e.condition}</span><span class="tag">选中来源 ${e.selectionMode}</span>`
      + `${e.invalidReason ? `<span class="tag bad">无效测试 ${esc(e.invalidReason)}</span>`
        : e.unexecuted === true ? `<span class="tag bad">未执行（预算中止）</span>`
        : e.status !== "ok" ? `<span class="tag bad">未判定 ${esc(e.status)}</span>` : ""}</h3>
<p class="meta">查询：${esc(e.query)}</p>`
      + `<p class="meta">证据链：真实 attempt <code>${esc(e.transportAttemptId || "（无）")}</code>`
      + `｜响应 ${e.response.chars} 字｜错误 ${e.error ? `<b class="bad">${esc(e.error.slice(0, 80))}</b>` : "（无）"}`
      + `｜逐次记录 ${e.transport?.attempts?.length ?? "（无 transport 证据）"}`
      + `｜桥回报尝试 ${e.bridgeReportedAttempts === null ? "（缺失/未知）" : e.bridgeReportedAttempts}`
      + `${e.transport ? "" : "｜<b class=bad>证据缺失：无 transport</b>"}</p>${fiveEvidence(e)}</div>`).join("")
    : `<p class="meta">无用例</p>`;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>RAG 评测证据（scope=rag）· ${esc(p.generatedAt)}</title><style>${CSS}</style></head><body>
<h1>RAG 评测证据（五类可复算证据）</h1>
<p class="meta">生成时间(UTC)：${esc(p.generatedAt)}｜口径：<b>scope=rag（独立分母，不与文本口径相加）</b></p>
<p class="meta">文档：${p.meta.docFiles.length} 篇｜来源 <code>${esc(p.meta.source)}</code>｜目录 <code>${esc(p.meta.docsDir)}</code>`
    + `${p.meta.snapshotCommitId ? `｜快照提交 <code>${esc(p.meta.snapshotCommitId)}</code>` : ""}</p>
<p class="meta">文档快照哈希：<code>${p.meta.docHash}</code></p>
<p class="meta">检索配置（冻结，不得调参）：chunk ${p.meta.config.chunkChars} / overlap ${p.meta.config.overlapChars}`
    + ` / stride ${p.meta.config.stride} / topK ${p.meta.config.topK} / context ${p.meta.config.contextChars}｜口径 ${esc(p.meta.config.normalizer)}</p>

<h2>三口径（读数前请先读口径声明）</h2>
<table>
<tr><th>口径</th><th>样本</th><th>确定判定</th><th>攻破</th><th>比率</th><th>说明</th></tr>
<tr><td>端到端任务 ASR</td><td>${e2e.attempted}</td><td>${e2e.decided}</td><td>${e2e.breaches}</td><td><b>${pct(e2e.asr)}</b></td>
<td class="meta">未命中 ${e2e.reasons.missedRetrieval}｜阻断 ${e2e.reasons.inputBlocked}｜未送达 ${e2e.reasons.notDelivered}｜模型拒绝 ${e2e.reasons.modelRefused}</td></tr>
<tr><td>送达后 ASR</td><td>${d.attempted}</td><td>${d.decided}</td><td>${d.breaches}</td><td><b>${pct(d.asr)}</b></td>
<td class="meta">仅计「载荷完整送达 + 有响应 + 可判定」</td></tr>
<tr><td>无效测试</td><td>${c.invalidTests}</td><td colspan="2" class="meta">被拦 ${c.invalidByReason.blocked_before_delivery}／未在请求里 ${c.invalidByReason.not_in_request}／未按约定 ${c.invalidByReason.position_mismatch}</td><td>-</td>
<td class="meta">forced 未按约定送达 ⇒ 两个 ASR 分母都不含</td></tr>
</table>

<h2>到达与覆盖</h2>
<table><tr><th>用例</th><th>检索命中</th><th>截断丢失</th><th>输入阻断</th><th>请求暴露</th><th>错误</th><th>未判定</th></tr>
<tr><td>${c.cases}</td><td>${c.retrieved}</td><td>${c.truncationLost}（length_cap ${c.truncationByReason.length_cap} / variant_splice ${c.truncationByReason.variant_splice}）</td>
<td>${c.inputBlocked}</td><td>${c.requestExposed}（重放 ${c.requestExposedFromCache}）</td><td>${c.errors}</td><td>${c.undecided}</td></tr></table>

<h2>逐条证据（五类分区）</h2>
${caseCards}

<h2>口径声明</h2>
<ul>${p.declarations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<p class="meta">本页由 <code>ts/src/rag-evidence.ts</code> 从 <code>rag-report.json</code> 渲染，自包含（无外部资源）；`
    + `所有数字均为产物原字段，页面不做二次计算。</p>
</body></html>`;
}
