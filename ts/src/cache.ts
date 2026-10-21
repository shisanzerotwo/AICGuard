/**
 * 回复缓存的身份与模式（M2-1）。
 *
 * 为什么单独成模块：缓存键漏掉任何"会改变模型输出"的输入，就会串结果——
 * 审查 R3 的实证就是**换模型/换端点后仍命中旧缓存**（键里只有 salt/model/system/参数/消息）。
 * 现在身份由这里统一构造与哈希，两个真实靶子（LlmBot / AgentBot）共用同一实现。
 *
 * 键覆盖（全部缺失即漏判）：
 *   键版本 + 采样标识(salt) + 模型 + **规范化端点** + 采样参数 + 系统提示 + 消息 + **工具契约**
 *
 * 历史兼容：旧条目的键是 v1 形态（不带 `v`/端点/工具契约），v2 键**永远不会命中它们**，
 * 但文件**保留在磁盘上不删**（docs/15 §2.3：旧缓存不删除；这类记录属 legacy/provenance_unknown，
 * 不得参与修复版模型排名）。需要使用旧响应时只能显式重判，不能假装是新采样。
 *
 * 模式（docs/15 §2.3）：
 *   - `fresh`：使用本次实验的独立采样标识（每轮不同 salt ⇒ 必然新请求）；
 *   - `replay`：**只读缓存**，缺失时返回失败而不联网（不得偷偷补数）。
 */

import { createHash } from "node:crypto";

/** 缓存键版本：升级即让全部旧条目失效（旧文件保留） */
export const CACHE_KEY_VERSION = 2;

/** fresh = 允许发请求；replay = 只读缓存，缺失即失败 */
export type CacheMode = "fresh" | "replay";

export function isCacheMode(v: unknown): v is CacheMode {
  return v === "fresh" || v === "replay";
}

/**
 * 端点规范化：协议 + 主机 + 路径（去尾斜杠、小写）。
 * 端点不同 ⇒ 连的是不同的服务/网关，缓存必须隔离（同一模型走不同网关也不得串）。
 */
export function normalizeEndpoint(baseUrl: string): string {
  const raw = (baseUrl ?? "").trim();
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

/** 缓存身份：任何一项变化都必须产生不同的键 */
export interface CacheIdentity {
  /** 采样标识；fresh 模式下每次独立采样都必须不同 */
  salt: string;
  model: string;
  /** 原始端点；入库前会经 normalizeEndpoint 规范化 */
  endpoint: string;
  systemPrompt: string;
  messages: unknown;
  temperature?: number;
  maxTokens?: number;
  /** 工具契约（版本 + 清单哈希）；普通文本靶子可不传 */
  toolContract?: string;
}

/** 由身份计算缓存键（v2） */
export function cacheKey(id: CacheIdentity): string {
  return createHash("sha1")
    .update(JSON.stringify({
      v: CACHE_KEY_VERSION,
      salt: id.salt,
      model: id.model,
      endpoint: normalizeEndpoint(id.endpoint),
      temperature: id.temperature ?? null,
      maxTokens: id.maxTokens ?? null,
      system: id.systemPrompt,
      messages: id.messages,
      tool: id.toolContract ?? null,
    }))
    .digest("hex");
}

/** replay 模式缓存缺失时的统一错误文案（消费方据此记 call_error，而不是当成"防住了"） */
export function replayMissError(key: string): string {
  return `replay 模式缓存缺失（key ${key.slice(0, 10)}）：不得联网补数，本条按调用失败记 unclear`;
}
