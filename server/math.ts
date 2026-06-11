/**
 * Shared math utilities used by history.ts and estimator/progress.ts.
 */

/** Returns the p-th percentile of an already-sorted array. */
export function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

/** Returns the lower median of xs (unsorted input is fine — a copy is sorted internally). */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}
