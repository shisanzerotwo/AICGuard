#!/usr/bin/env node
/**
 * LLM 请求桥：独立子进程，负责一次 /chat/completions 调用（含退避重试）。
 *
 * 为什么存在：评测引擎与防御流水线全部是同步签名（Target.respond 返回值直接
 * 参与判定），而真实模型调用天然异步。Node 没有同步 fetch，用 spawnSync 隔离
 * 异步世界是零依赖下最简单的做法——父进程阻塞等待，子进程内部用 await 任意重试。
 * 每次调用多 ~50ms 进程开销，相对 1-3s 的 API 延迟可忽略。
 *
 * 协议：stdin 收 JSON {baseUrl, apiKey, model, system, messages, maxTokens,
 * timeoutMs, tools?, budget?}；stdout 出 JSON {text, error?, usage?, toolCalls?, attempts, budgetExhausted?}。
 * 退出码 0 = 有结论（含业务失败）。
 *
 * 预算（P1，`docs/15` §5.2 / `docs/37`）：`budget = {path, runId, limit?, source?}` 时，
 * **每次 attempt 之前**先原子占用 1 次额度（`reserveAttempts`）；拿不到就不发请求，
 * 并把 `budgetExhausted: true` 带出去。为什么只能在这里做：引擎按 spawn 次数估算会**低估 3 倍**
 * （本文件一次 spawn 最多 3 次 HTTP）。`attempts` 是**真实 HTTP 尝试次数**，供账本口径对账。
 *
 * tools 协议（A2 agent 化）：请求带 tools（OpenAI function 格式）时透传给
 * 网关，并把响应里的 message.tool_calls 解析成 [{name, arguments}] 放进
 * toolCalls。不带 tools 的旧请求路径与之前逐字节一致（T7 榜单可复现）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * token 计数必须是**有限非负整数**才算"供应商报告的用量"（Codex 复核 F1）。
 * 为什么要这么严：`usage` 的默认占位是 `{0,0}`，而 `{}` / `[]` / 缺字段 / 字符串 / 负数
 * 都会被"只判断是不是对象"的实现整批放行，缺的字段再被 `?? 0` 补成 0 ⇒
 * **不完整的成本被当成完整零成本**（实测：`usage:{}` 让整个 Work Loop 出了"6/6 未达阈值"的负结论）。
 */
const isTokenCount = (v) => typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
/** 完整合法用量；任何一项不合格一律返回 null（不补 0、不当完整成本） */
function parseUsage(u) {
  if (!u || typeof u !== "object" || Array.isArray(u)) return null;
  if (!isTokenCount(u.prompt_tokens) || !isTokenCount(u.completion_tokens)) return null;
  return { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens };
}

const req = JSON.parse(readFileSync(0, "utf8"));
const out = {
  text: "", error: "", usage: { prompt_tokens: 0, completion_tokens: 0 }, toolCalls: [],
  attempts: 0, budgetExhausted: false, budgetStop: null,

  /**
   * **用量来源/完整度**（Codex 复核 E2 + F1/F3）：`reported` / `partial` / `unknown` / `none`。
   * 由**逐次实际尝试**合成（不是只看最后一次响应）：
   *   · `none`     —— 一次请求都没发出去（发送前被预算拦下）⇒ 确认零消耗
   *   · `reported` —— 每一次发出的尝试都拿到了**完整合法**的供应商用量
   *   · `partial`  —— 至少有一次拿到了完整合法用量，但还有尝试没用（已得数字是**下界**）
   *   · `unknown`  —— 发出过尝试，但**一次也没拿到**完整合法用量（不得写作 0）
   */
  usageSource: "none",
  usageLowerBound: { prompt_tokens: null, completion_tokens: null },

  /**
   * **实际 HTTP 请求正文**的证据（P2/P3 返工）：只有真正进入 fetch 的那份 JSON 才算数 ——
   * 父进程发来的 IPC 包装（含 baseUrl/apiKey/预算字段）**不是** HTTP 正文，不能当送达证据。
   */
  request: { state: "not-sent", sha256: "", bytes: 0, attemptId: "", decodedText: "" },
};

// 送达状态**只升级不降级**，并且**三元组必须来自同一次尝试**（Codex 复核项 5）：
//   not-sent < refused < not-connecting < unknown-after-submit < submitted
// 反例（实测踩到两种）：① 第 1 次超时、第 2 次被预算拦 ⇒ 不能把“可能已到服务端”降级成“没发出去”；
//   ② 第 1 次收到 500（submitted）、第 2 次连接失败 ⇒ 若共用一个对象，`attemptId/sha256` 会被
//   第 2 次覆写，而 state 仍是 submitted ⇒ 报出去的“已提交”三元组其实指向从未被服务端收到的那次尝试。
// 做法：逐 attempt 记一条（attempts[]），最后**只从最强的那条**填 out.request。
const STATE_RANK = { "not-sent": 0, refused: 1, "not-connecting": 2, "unknown-after-submit": 3, submitted: 4 };
const attemptLog = [];
/**
 * 登记一条 attempt 记录 —— **本文件唯一的登记点**，登记的是**不可变快照**。
 *
 * 为什么必须是快照（Codex 复核 R1）：早前把 `rec` 对象本身推进日志，之后又在 catch 里把同一个对象的
 * `outcome` 由 `submitted` 改写成 `not-connecting` ⇒ 一次 HTTP 尝试在日志里留下**两条同 ID** 的记录
 * （两条都被改写成 not-connecting），而顶层三元组仍是 `submitted`，**找不到与之同源的那条记录**。
 * 现在：一次尝试 = 一条记录；登记点放在该次尝试的结论**定案之后**，登记后任何人不得再改它。
 */
function noteAttempt(rec) {
  const row = {
    n: rec.n,
    outcome: rec.outcome,
    attemptId: rec.attemptId ?? "",
    sha256: rec.sha256 ?? "",
    bytes: rec.bytes ?? 0,
    decodedText: rec.decodedText ?? "",
    // 响应阶段错误（连接已建立之后的读取/解析失败）与连接结果**分开**存放：
    // 它只解释"为什么这次没拿到可用响应"，**不改写** `outcome`（送达事实不因解析失败而消失）。
    ...(rec.responseError ? { responseError: rec.responseError } : {}),
    ...(rec.responseErrorKind ? { responseErrorKind: rec.responseErrorKind } : {}),
  };
  attemptLog.push(row);
  const rank = STATE_RANK[row.outcome];
  const best = STATE_RANK[out.request.state] ?? -1;
  if (rank !== undefined && rank >= best) {
    out.request = {
      state: row.outcome,
      sha256: row.sha256,
      bytes: row.bytes,
      attemptId: row.attemptId,
      decodedText: row.decodedText || out.request.decodedText || "",
    };
  }
}

// 预算：拿不到额度就不发请求（`docs/15` §5.2「每次发送前原子占用额度」）
//
// ★ **无账本就不发包**（P3 返工）：这一道在**桥内**，因此任何调用方都绕不过去 ——
//   “忘了传 budget”这类绕过大体发生在调用方（实测：workloop-eval 曾裸调桥适配函数），
//   仅在调用方校验不够，必须在这里兜底。（replay 根本不会走到本文件：缓存缺失即失败。）
let reserve = null;
if (req.budget?.path) {
  const mod = await import("../budget.ts");
  reserve = (n) => mod.reserveAttempts(req.budget.path, n, req.budget.source ?? "bridge",
    { ...(req.budget.limit !== undefined ? { limit: req.budget.limit } : {}), runId: req.budget.runId ?? "default" });
} else {
  out.budgetExhausted = true;
  out.budgetStop = "missing";
  out.error = "budget_missing: 桥未收到额度账本配置 ⇒ 拒绝发送（无账本不得发包）";
  out.request.state = "refused";
  // 一个字节都没发 ⇒ 确认零消耗（F1/F2：不得让默认占位 0 冒充供应商报告）
  out.usageSource = "none";
  writeFileSync(1, JSON.stringify(out));
  process.exit(0);
}

// 429/5xx 退避重试：最多 3 次，间隔 2s/5s。网关限流时宁可慢不要崩。
let lastErr = "";
/** 至少有一次 attempt **完成完整解析并提交**（E1）——`usable` 的唯一依据 */
let parsedAny = false;
/** 真的发出过请求的尝试数（reserve 成功 = 会 fetch）与其中拿到完整合法用量的次数（F1/F3） */
let sentAttempts = 0;
let reportedAttempts = 0;
let knownUsageAttempts = 0;
// 「空响应」可归因（步骤 3）：只记录**结构性**事实（HTTP 状态 / finish_reason / choices 长度），
// 不记任何凭据、不记 prompt 与响应正文。仅在 usable===false 时挂出（成功路径形状不变）。
let lastHttpStatus = null;
let lastFinishReason = null;
let lastChoicesLen = null;
for (let attempt = 0; attempt < 3; attempt++) {
  // ★ 发送前占用额度（放在退避睡眠**之前**：额度不足就没必要白等）。
  //   拿不到 ⇒ 本次与后续都不再发包，并把**具体原因**（exhausted/corrupt/locked/limit）带出去。
  if (reserve) {
    try {
      reserve(1);
      out.attempts++;
      // 额度已占用 ⇒ 这一次真的会去 fetch（F3：进逐次尝试的计数）
      sentAttempts++;
    } catch (e) {
      out.budgetExhausted = true;
      out.budgetStop = typeof e?.kind === "string" ? e.kind : "unavailable";
      // ★ 预算拒绝也**绑定到这一次 attempt**（Codex 复核 D1）：错误必须能追溯到逐次记录，
      //   否则"发送前被拦"这一步在证据里没有落脚点。
      noteAttempt({
        n: attempt, outcome: "refused", attemptId: "", sha256: "", bytes: 0, decodedText: "",
        responseError: `budget_${out.budgetStop}: ${String(e?.message ?? e)}`,
        responseErrorKind: "budget",
      });
      break;
    }
  }
  if (attempt > 0) await new Promise((r) => setTimeout(r, [0, 2000, 5000][attempt]));

  // ── 一次 attempt 的生命周期：**连接结果**与**响应阶段错误**分开 ──
  //  · `rec.outcome` 只描述连接层事实（拿到响应 = submitted），拿到响应后**不再改写**；
  //  · 解析失败 / 响应体读取失败 / HTTP 状态错误都记在 `responseError`（错误仍可见），
  //    它们不改变"这一次尝试到底有没有送到服务端"这一事实；
  //  · 一次尝试只在末尾登记**一条**记录（`noteAttempt` 内做快照）。
  // ⚠️ `rec` 必须声明在 try 之外：catch 块**看不到** try 块内的 const/let，
  //    否则一次超时/断连就会 ReferenceError 崩桥（桥崩 ⇒ stdout 为空 ⇒ 只能报"无输出"，
  //    送达证据整条丢失）。实测踩到：超时与"先 500 后断连"两条反例同时失败。
  const rec = { n: attempt, outcome: "not-connecting", attemptId: "", sha256: "", bytes: 0, decodedText: "" };
  let responseError = "";
  let responseErrorKind;
  let retry = false;
  /** 本次 attempt 是否完成了一次**完整**的协议解析并提交（E1：usable 只能看它，不看残留字段） */
  let parsed = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 60000);
    // 只在调用方给了 tools 时才带 tools 字段——旧协议请求体保持原样
    const payload = {
      model: req.model,
      messages: (req.system ? [{ role: "system", content: req.system }] : []).concat(req.messages),
      max_tokens: req.maxTokens ?? 500,
      temperature: req.temperature ?? 0.7,
    };
    if (req.tools?.length) {
      payload.tools = req.tools.map((t) => ({ type: "function", function: t }));
      payload.tool_choice = "auto";
    }
    // ★★ **实际 HTTP 正文的唯一构造点**（P3 返工，`docs/37` §3）：
    //   bodyText 就是下面 fetch 的 body（**同一个字符串**），哈希在这里算 ⇒ 可证明“发出去的是什么”。
    //   父进程的 IPC 包装（含 baseUrl/apiKey/budget）**不是** HTTP 正文，不得当送达证据。
    const bodyText = JSON.stringify(payload);
    const bodySha = createHash("sha256").update(bodyText, "utf8").digest("hex");
    rec.attemptId = `${process.pid}-${attempt}-${bodySha.slice(0, 12)}`;
    rec.sha256 = bodySha;
    rec.bytes = Buffer.byteLength(bodyText, "utf8");
    // 解码文本（供保留范围测量）：与上面 payload 同源，JSON 转义不会把「完整送达」误判成「截断」
    rec.decodedText = payload.messages.map((m) => m.content).filter((s) => s !== "").join("\n");
    const res = await fetch(`${req.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${req.apiKey}` },
      body: bodyText,
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    // ★ 拿到任何 HTTP 响应 ⇒ 正文确实到达服务端。**连接事实到此定案**：
    //   下面无论读体失败、JSON 非法还是 4xx/5xx，都只算"响应阶段"的问题，
    //   不得把 submitted 改写成"没连上"（那会把一次真实发出的请求从送达证据里抹掉）。
    rec.outcome = "submitted";
    lastHttpStatus = res.status;
    if (res.status === 429 || res.status >= 500) {
      // ★ 429/5xx 的状态错误也要**归属到本次 attempt**（Codex 复核 D1）：
      //   修前只写 `lastErr`，于是「500 → 非法 JSON → 预算拒绝」整条链里**第一错凭空消失**。
      responseError = `HTTP ${res.status}（服务端错误）`;
      responseErrorKind = "http_status";
      lastErr = `HTTP ${res.status}`;
      retry = true;
    } else if (!res.ok) {
      let t = "";
      responseErrorKind = "http_status";
      try { t = await res.text(); } catch (e) { responseError = `响应体读取失败：${String(e)}`; responseErrorKind = "body_read"; retry = true; }
      // HTTP 状态错误在前、响应体读取失败在后：两者都保留（只留一个会丢掉"到底哪一步坏了"）
      responseError = [t ? `HTTP ${res.status}: ${t.slice(0, 200)}` : `HTTP ${res.status}（响应体未读到）`, responseError]
        .filter(Boolean).join("；");
    } else {
      try {
        responseErrorKind = "body_read";
        const raw = await res.text();
        responseErrorKind = "json_parse";
        const data = JSON.parse(raw);
        lastChoicesLen = Array.isArray(data?.choices) ? data.choices.length : null;
        lastFinishReason = data?.choices?.[0]?.finish_reason ?? null;
        responseErrorKind = "protocol";
        // ★★ **一次完整协议校验与解析，成功才提交**（Codex 复核 E1）
        //   修前先写 `out.text`、再去遍历 `tool_calls` ⇒ 当 `tool_calls` 不是数组（或数组里某项畸形）时
        //   中途抛错，**残留文本**已落在 `out.text` 上 ⇐ 顶层 `usable` 只看"text 非空"⇒ 没有一次完整
        //   成功的响应却被发布成成功（还会有缓存）。现在全部先算在局部变量里，任何一步抛错都不会泄出。
        const msg = data.choices?.[0]?.message ?? {};
        const nextText = typeof msg.content === "string" ? msg.content : "";
        const rawCalls = msg.tool_calls ?? [];
        if (!Array.isArray(rawCalls)) throw new Error("tool_calls 必须是数组");
        const nextCalls = [];
        for (const tc of rawCalls) {
          const name = tc?.function?.name;
          if (typeof name !== "string" || name === "") throw new Error("tool_calls[].function.name 必须是非空字符串");
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* 参数不合法按空处理 */ }
          if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
          const clean = {};
          for (const [k, v] of Object.entries(args)) clean[k] = String(v);
          nextCalls.push({ name, arguments: clean });
        }
        // ↓↓↓ **提交点**：走到这里才动 out.*（在半路抛错时一个字节都不得泄出）
        out.text = nextText;
        out.toolCalls.push(...nextCalls);
        // 完整双字段才是 reported；单字段逐项保留在 nullable 下界里，数值兼容槽不证明字段完整。
        // usageSource 末尾按逐次尝试合成，缺失值不能被占位 0 当作供应商报告。
        const parsedUsage = parseUsage(data.usage);
        const u = data.usage && typeof data.usage === "object" && !Array.isArray(data.usage) ? data.usage : {};
        const p = isTokenCount(u.prompt_tokens) ? u.prompt_tokens : null;
        const c = isTokenCount(u.completion_tokens) ? u.completion_tokens : null;
        if (p !== null || c !== null) knownUsageAttempts++;
        if (p !== null) out.usageLowerBound.prompt_tokens = (out.usageLowerBound.prompt_tokens ?? 0) + p;
        if (c !== null) out.usageLowerBound.completion_tokens = (out.usageLowerBound.completion_tokens ?? 0) + c;
        if (parsedUsage) reportedAttempts++;
        out.usage = { prompt_tokens: out.usageLowerBound.prompt_tokens ?? 0, completion_tokens: out.usageLowerBound.completion_tokens ?? 0 };
        parsed = true;
        responseErrorKind = undefined;
      } catch (e) { responseError = `响应解析失败：${String(e)}`; retry = true; }
    }
  } catch (e) {
    lastErr = e?.name === "AbortError" ? `超时(${req.timeoutMs}ms)` : String(e);
    // 超时/中断 ⇒ 正文可能已到服务端，但不得推断模型已处理；连接层失败 ⇒ 不得声称服务端收到。
    // 状态只升级不降级：已有 attempt 拿到过 HTTP 响应（submitted）就不因后续重试失败而回退。
    if (rec.outcome === "submitted") responseError = responseError || `响应处理失败：${lastErr}`;
    else {
      rec.outcome = e?.name === "AbortError" ? "unknown-after-submit" : "not-connecting";
      // 连接层失败同样归属到本次 attempt（否则"首错丢失"会以另一种形态复发）
      responseError = responseError || (e?.name === "AbortError" ? `超时(${req.timeoutMs}ms)` : `连接失败：${String(e)}`);
    }
    responseErrorKind ??= e?.name === "AbortError" ? "timeout" : rec.outcome === "submitted" ? "response_processing" : "connection";
    retry = true;
  }
  if (responseError) rec.responseError = responseError;
  if (responseErrorKind) rec.responseErrorKind = responseErrorKind;
  if (parsed) parsedAny = true;
  noteAttempt(rec); // ← 本次尝试的**唯一**登记点（此后任何人不得改写这条记录）
  if (retry) continue;
  break;
}

// ── 调用级错误链（Codex 复核 D1）──────────────────────────────────────────
// 规则：
//   · **拿到可用结果**（有文本或有工具调用）⇒ 这次调用**成功**：顶层 error 一律置空。
//     为什么必须置空："第 1 次 500 / 解析失败、第 2 次成功"是**恢复成功**；把历史错误上浮到顶层
//     error，下游会把一次正常回复读成故障（复核也实测证伪了"历史错误=调用级失败"那条思路）。
//     历史错误**不丢**：逐条留在 `attemptsLog[].responseError` 里。
//   · 没拿到可用结果 ⇒ 把逐次记录里的错误拼成错误链：**致命的那条在前**（最后一条，它决定了这次
//     调用为什么没有结论，如 `budget_exhausted`），更早的按发生顺序补在后面 ⇒
//     「HTTP 500 → 响应解析失败 → 预算拒绝」三件都在，且逐条可追溯。
const usable = parsedAny && (out.text !== "" || out.toolCalls.length > 0);if (usable) {
  out.error = "";
} else {
  const errs = attemptLog
    .map((r0, i) => (r0.responseError ? { n: typeof r0.n === "number" ? r0.n : i, msg: r0.responseError } : null))
    .filter((x) => x !== null);
  out.error = errs.length
    ? [errs[errs.length - 1].msg, ...errs.slice(0, -1).map((x) => `更早尝试（第 ${x.n + 1} 次）：${x.msg}`)].join("｜")
    : (lastErr || "未知错误");
  // 步骤 3：把「为什么这条没有结论」的结构性证据落盘（只为**后续**可归因，不回溯、不改判定）
  out.diagnostics = {
    parsedAny,
    textChars: out.text.length,
    toolCalls: out.toolCalls.length,
    httpStatus: lastHttpStatus,
    finishReason: lastFinishReason,
    choicesLen: lastChoicesLen,
    attemptErrorKinds: attemptLog.map((r0) => r0.responseErrorKind ?? null),
  };
}
// 逐 attempt 记录（三元组只从同一次尝试取的证据在这里可核对）；**不含任何凭据**。
// ⚠️ 名字必须是 attemptsLog：`attempts` 在本协议里早已是"底层 HTTP 尝试**次数**"（数值），
//    改成数组会让 `httpAttempts += out.attempts` 变成字符串拼接（实测被测试套件当场抓到：'0[object Object]'）。
out.attemptsLog = attemptLog;
// ── 用量来源/完整度：由**逐次实际尝试**合成（Codex 复核 F1/F3）─────────────────
//  为什么不能用"最后一次成功响应"：同一次桥调用可能先 500（无 usage）再恢复返回 7/11，
//  那只证明"已得 18 是下界"，不能证明整次调用是完整成本。
out.usageSource = sentAttempts === 0 ? "none"
  : reportedAttempts === sentAttempts ? "reported"
  : knownUsageAttempts > 0 ? "partial"
  : "unknown";
writeFileSync(1, JSON.stringify(out));
