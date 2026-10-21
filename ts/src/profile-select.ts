/**
 * 档位子集选择（G2，`docs/40`）。
 *
 * 为什么需要：`docs/15` §5.2 给 M6 的 Agent 组算的是「6 条攻击 × **两档**」，
 * 而 `scripts/agent-eval.ts` 的档位表是**固定 4 档**（none / rules+norm / full / full+agent），
 * 没有收窄入口 ⇒ 预估上限 88 次，超过本组审批口径 56。
 *
 * 纪律：**未知档位名一律报错，不静默忽略**——静默忽略会让"少跑了档位"看起来像"跑过了"；
 * 空的档位串同样报错，**不得**静默回退成"全档"（那会把收窄意图反转成放大）。
 */
export interface NamedProfile {
  name: string;
}

/**
 * 从候选档位表里按名字挑子集。
 * @param all  候选档位（保持表内顺序）
 * @param spec 逗号分隔的档位名；`undefined` = 不收窄（返回全部）
 */
export function selectProfiles<T extends NamedProfile>(all: readonly T[], spec: string | undefined): T[] {
  const valid = all.map((p) => p.name);
  if (spec === undefined) return [...all];
  const names = spec.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (names.length === 0) {
    throw new Error(`--profiles 为空：写法如 --profiles none,full（可选：${valid.join(" / ")}）`);
  }
  const unknown = names.filter((n) => !valid.includes(n));
  if (unknown.length > 0) {
    throw new Error(`未知档位：${unknown.join(", ")}（可选：${valid.join(" / ")}）`);
  }
  return all.filter((p) => names.includes(p.name));
}
