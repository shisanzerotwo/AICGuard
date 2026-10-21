/**
 * 零依赖统计小工具：为多次采样给出比例的可复现置信区间。
 * 只用 Node 内置能力（无第三方），与项目零依赖铁律一致。
 */

/** Wilson score 区间（比例 p 的 95% CI；小样本下优于正态近似）。 */
export function wilson(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/** 零事件时的 95% 上界（rule of three）：3/n。用于"0 次攻破"的防御档。 */
export function zeroEventUpper(n: number): number {
  return n > 0 ? 3 / n : 1;
}

/** 算术均值；空数组返回 0。 */
export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** 样本标准差（n-1）；样本 <2 返回 0。 */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}
