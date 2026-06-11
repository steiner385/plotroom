import type { CheckRun } from '../types';
import type { Expected } from '../history';
import { median, percentile } from '../math';

export interface ProgressInput {
  checks: CheckRun[];          // already filtered to the relevant population
  expectedSet: string[];       // canonical names from history for (repo, event)
  lookup: (name: string) => Expected | null;
  now: Date;
  /** Raw historical SUCCESS duration samples per check (last 20). When provided
   *  with ≥5 values for a running check, the remaining-time estimate re-anchors
   *  on the samples that exceed the current elapsed time (conditional median) —
   *  fixes bimodal cold/warm distributions where p50 underestimates a warm run. */
  samples?: (name: string) => number[];
  /** Expected runner-pickup wait per check (learned medians). Added to the
   *  remaining-time estimate of queued/not-yet-appeared checks only — a running
   *  check already has its runner. */
  queueDelay?: (name: string) => number | null;
}
export interface ProgressResult {
  percent: number;
  etaSeconds: number | null;
  etaRangeSeconds: [number, number] | null;
  overdue: boolean;
  failed: boolean;  // true when any non-SKIPPED COMPLETED check concluded FAILURE|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED (NOT CANCELLED)
}

const RUNNING_CAP = 0.97;
const OVERDUE_FACTOR = 1.5;
const DEFAULT_DURATION = 60;

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

export function computeProgress({ checks, expectedSet, lookup, now, samples, queueDelay }: ProgressInput): ProgressResult {
  const live = new Map(checks.map((c) => [c.name, c]));
  const names = new Set([...expectedSet, ...checks.map((c) => c.name)]);
  const knownP50s = [...names].map((n) => lookup(n)?.p50).filter((v): v is number => v != null);
  const fallback = knownP50s.length ? median(knownP50s) : DEFAULT_DURATION;

  let wSum = 0, pSum = 0, etaP50 = 0, etaP90 = 0;
  let overdue = false, anyUnfinished = false, wideVariance = false;
  let failed = false;

  for (const name of names) {
    const c = live.get(name);
    if (c?.conclusion === 'SKIPPED') continue; // completed, weight 0
    const exp = lookup(name);
    const p50 = exp?.p50 ?? fallback;
    const p90 = exp?.p90 ?? p50;
    let progress: number, rem50: number, rem90: number;
    if (c?.status === 'COMPLETED') {
      progress = 1; rem50 = 0; rem90 = 0;
      // Track failure conclusions (CANCELLED is not a failure — it's auto-retried)
      if (FAILED_CONCLUSIONS.has(c.conclusion ?? '')) failed = true;
    } else if (c?.status === 'IN_PROGRESS' && c.startedAt) {
      const rawElapsed = (now.getTime() - Date.parse(c.startedAt)) / 1000;
      if (!Number.isFinite(rawElapsed)) {
        // Malformed or non-parseable startedAt — treat as queued
        progress = 0; rem50 = p50; rem90 = p90;
        anyUnfinished = true;
      } else {
        const elapsed = Math.max(rawElapsed, 0); // clamp future startedAt to 0
        progress = Math.min(elapsed / p50, RUNNING_CAP);
        anyUnfinished = true;
        // Conditional-remaining estimator: with ≥5 raw samples, re-anchor on the
        // samples still consistent with the current elapsed time (those > elapsed).
        const vals = samples?.(name) ?? [];
        const qualifying = vals.length >= 5 ? vals.filter((v) => v > elapsed) : null;
        if (qualifying && qualifying.length === 0) {
          if (vals.length >= 10) {
            // ≥10 samples and elapsed exceeded every one — overdue regardless of 1.5×p50
            overdue = true;
          } else {
            // 5–9 samples with zero qualifying: not enough evidence to bypass the guard;
            // fall back to the legacy 1.5×p50 overdue rule
            if (elapsed > OVERDUE_FACTOR * p50) overdue = true;
          }
          rem50 = 0; rem90 = 0; // moot: overdue suppresses the ETA
        } else if (qualifying && qualifying.length >= 2) {
          const sortedQ = [...qualifying].sort((a, b) => a - b);
          rem50 = median(sortedQ) - elapsed;
          rem90 = percentile(sortedQ, 0.9) - elapsed;
          progress = Math.min(elapsed / (elapsed + rem50), RUNNING_CAP);
        } else {
          // <5 samples total, or exactly 1 qualifying — current p50/p90 logic
          if (elapsed > OVERDUE_FACTOR * p50) overdue = true;
          rem50 = Math.max(p50 - elapsed, 0); rem90 = Math.max(p90 - elapsed, 0);
        }
      }
    } else {
      // queued, or expected-from-history but not yet in the rollup — a runner must
      // still pick it up, so the learned pickup wait extends both estimates
      const delay = queueDelay?.(name) ?? 0;
      progress = 0; rem50 = p50 + delay; rem90 = p90 + delay;
      anyUnfinished = true;
    }
    // Item 3 — variance guard: wide-variance condition requires p50 > 0
    if (exp && exp.p50 > 0 && exp.p90 / exp.p50 > 2 && progress < 1) wideVariance = true;
    wSum += p50; pSum += p50 * progress;
    etaP50 = Math.max(etaP50, rem50); etaP90 = Math.max(etaP90, rem90);
  }

  const percent = wSum ? Math.round((pSum / wSum) * 100) : 100;
  if (!anyUnfinished) return { percent: 100, etaSeconds: 0, etaRangeSeconds: null, overdue: false, failed };
  if (overdue) return { percent, etaSeconds: null, etaRangeSeconds: null, overdue: true, failed };
  return {
    percent,
    etaSeconds: Math.round(etaP50),
    etaRangeSeconds: wideVariance ? [Math.round(etaP50), Math.round(etaP90)] : null,
    overdue: false,
    failed,
  };
}
