/**
 * Agent 批次的**编排与共享中止状态**（P3 返工项 5）。
 *
 * 为什么必须单独成模块（而不是留在 `scripts/agent-eval.ts` 里）：
 *   ① 语义要求是**整批共享**一个停止状态（覆盖所有档位、所有采样、良性任务）——
 *      原先 `exhausted` 是 `runProfile` 内的局部变量，进入下一档/下一次采样就**重置**了，
 *      于是"额度已用完"之后还会继续跑（档位 × 采样）次，既烧不出数据也违背 §5.2「耗尽即止」；
 *   ② 入口脚本顶层就 `process.exit(main())`，**无法被测试导入** ⇒ 把编排抽到这里，
 *      才能写"入口级"的跨档位/跨采样/良性反例（而不是只验字段透传）。
 *
 * 纪律：
 *   · 一旦出现 `budget_exhausted`，**后续用例不再调靶子**，改为合成 `exhaustedAgentLine`
 *     （verdict=unclear ⇒ 不进确定判定分母；「没跑完」显式可见，不冒充「跑完且未攻破」）；
 *   · 中止后**不再开启新的采样轮**（也不能用缓存补成"新采样通过"：合成行不是 success）；
 *   · 良性用例同纪律：中止后不再调用，也不虚增任何计数；
 *   · **已发生的工具攻破证据不因中止而降级**（判定层保证：`decideAgentOutcome` 先看轨迹再处理故障）。
 */
import { exhaustedAgentLine, runAgentCase, type AgentCaseLine } from "./agent-case.ts";
import type { Pipeline } from "./guards.ts";
import type { ExecutionStatus, Probe, Target } from "./types.ts";

export interface ProfileRun {
  lines: AgentCaseLine[];
  benignBlocked: number;
  benignEvaluated: number;
  benignCallErrors: number;
}

/** 整批共享的中止状态 */
export interface BatchStop {
  exhausted: boolean;
  /** 预算中止类别（exhausted/corrupt/locked/limit/missing） */
  stopReason: string;
  /** 中止原因文案（报告用） */
  reason: string;
  /** 因中止而未执行的攻击用例数 */
  unexecuted: number;
  /** 因中止而未执行的良性用例数 */
  unexecutedBenign: number;
  /** 观测一次执行状态；预算中止即置位（幂等：先到先记） */
  observe(status: ExecutionStatus, stopReason?: string): void;
}

export function newBatchStop(): BatchStop {
  const s: BatchStop = {
    exhausted: false, stopReason: "", reason: "", unexecuted: 0, unexecutedBenign: 0,
    observe(status: ExecutionStatus, stopReason?: string): void {
      if (status !== "budget_exhausted" || s.exhausted) return;
      s.exhausted = true;
      s.stopReason = stopReason && stopReason !== "" ? stopReason : "exhausted";
      s.reason = `预算中止（${s.stopReason}）`;
    },
  };
  return s;
}

/** 单档位跑批（含中止守卫）；`stop` 由调用方提供，**跨档位/跨采样共享** */
export function runProfile(
  probes: Probe[], benign: Probe[], target: Target, profile: string, pipeline: Pipeline, stop: BatchStop,
): ProfileRun {
  const lines: AgentCaseLine[] = [];
  for (const p of probes) {
    if (stop.exhausted) {
      stop.unexecuted++;
      lines.push(exhaustedAgentLine(p, profile));
      continue;
    }
    const l = runAgentCase(p, target, pipeline, profile);
    lines.push(l);
    stop.observe(l.status, l.stopReason);
  }
  // 误报：良性请求只关心是否被误拦；分母剔除靶子调用失败样本（API 失败 ≠ 未误拦，
  // 与主评测 evaluate.runBenign 的口径一致：分子只能是「跑完且被拦」，
  // 分母只能是真正跑完的样本；调用失败单独进 benignCallErrors（M1-2c 复核第二项）。
  let benignBlocked = 0;
  let benignEvaluated = 0;
  let benignCallErrors = 0;
  for (const [i, b] of benign.entries()) {
    // 中止后**剩余良性用例全部记未执行**（不能只 +1 就 break：那样会把未跑完的数**低估**，
    // 而读者正是拿这个数判断“这段到底跑完没有”）
    if (stop.exhausted) { stop.unexecutedBenign += benign.length - i; break; }
    const r = pipeline.run(b.text, target);
    stop.observe(r.budgetExhausted ? "budget_exhausted" : (r.targetError ? "call_error" : "ok"), r.budgetStopReason);
    if (r.targetError) { benignCallErrors++; continue; }
    benignEvaluated++;
    if (r.blocked) benignBlocked++;
  }
  return { lines, benignBlocked, benignEvaluated, benignCallErrors };
}

export interface AgentBatchPlan {
  samples: number;
  /** 档位：`pipeline()` 每轮每档重建（与既有行为一致：护栏实例不跨轮复用） */
  profiles: Array<{ name: string; pipeline: () => Pipeline }>;
  probes: Probe[];
  benign: Probe[];
  /** 每轮采样的靶子（每轮一个：盐不同 ⇒ 缓存身份不同） */
  makeTarget: (sample: number) => Target;
}

export interface AgentBatchOutcome {
  stop: BatchStop;
  rounds: Array<{ sample: number; byProfile: Map<string, ProfileRun> }>;
  /** Σ 靶子调用次数（含两臂/多轮工具循环/良性）——断言「中止后不再增长」用 */
  targetCalls: number;
  /** 已执行 / 未执行（未执行由中止合成） */
  executed: number;
  unexecuted: number;
  unexecutedBenign: number;
  /** 三个计数口径（真实通道才有意义；mock 下均为 0）+ token 累计 */
  usage: { requests: number; httpAttempts: number; cacheHits: number; promptTokens: number; completionTokens: number };
  /** 最后一个构造出来的靶子（报告出处用；无则 null） */
  lastTarget: Target | null;
}

/** 跑完整个批次：`samples × profiles`；**中止状态跨采样、跨档位共享** */
export function runAgentBatch(plan: AgentBatchPlan): AgentBatchOutcome {
  const stop = newBatchStop();
  const rounds: AgentBatchOutcome["rounds"] = [];
  let targetCalls = 0;
  let lastTarget: Target | null = null;
  const usage = { requests: 0, httpAttempts: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0 };
  for (let s = 1; s <= plan.samples; s++) {
    const byProfile = new Map<string, ProfileRun>();
    // 中止后不再开新采样轮（也不再构造/调用新靶子）
    if (stop.exhausted) {
      // 良性用例是**每档位跑一遍**的 ⇒ 一整轮被跳过时，未执行数 = 良性数 × 档位数（Codex 复核项 4：
      // 原先只加 `benign.length`，把"没跑完"的规模**低估**了 profiles 倍）。
      stop.unexecutedBenign += plan.benign.length * plan.profiles.length;
      for (const prof of plan.profiles) {
        byProfile.set(prof.name, { lines: plan.probes.map((p) => exhaustedAgentLine(p, prof.name)), benignBlocked: 0, benignEvaluated: 0, benignCallErrors: 0 });
      }
      stop.unexecuted += plan.probes.length * plan.profiles.length;
      rounds.push({ sample: s, byProfile });
      continue;
    }
    const target = plan.makeTarget(s);
    lastTarget = target;
    const counted = target as unknown as { requests?: number };
    for (const prof of plan.profiles) {
      const before = counted.requests ?? 0;
      const res = runProfile(plan.probes, plan.benign, target, prof.name, prof.pipeline(), stop);
      targetCalls += (counted.requests ?? 0) - before;
      byProfile.set(prof.name, res);
    }
    const t = target as unknown as { requests?: number; httpAttempts?: number; cacheHits?: number; promptTokens?: number; completionTokens?: number };
    usage.requests += t.requests ?? 0;
    usage.httpAttempts += t.httpAttempts ?? 0;
    usage.cacheHits += t.cacheHits ?? 0;
    usage.promptTokens += t.promptTokens ?? 0;
    usage.completionTokens += t.completionTokens ?? 0;
    rounds.push({ sample: s, byProfile });
  }
  // 与采样无关的“已执行”口径：总行数 − 因中止而未执行的行数
  const totalLines = rounds.reduce((n, r) => n + [...r.byProfile.values()].reduce((m, run) => m + run.lines.length, 0), 0);
  return {
    stop, rounds, targetCalls, executed: totalLines - stop.unexecuted,
    unexecuted: stop.unexecuted, unexecutedBenign: stop.unexecutedBenign,
    usage, lastTarget,
  };
}
