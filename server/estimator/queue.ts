/**
 * Estimator contracts (for the poller — Task 11):
 *
 * - headCommitOid non-null iff AWAITING_CHECKS is assumed from the mapper; entries with
 *   state AWAITING_CHECKS but headCommitOid=null are not yet building (no CI group assigned).
 * - GroupProgress.failed must be fed from computeProgress().failed for the group's checks.
 * - MERGEABLE entries occupy no future capacity: they are done awaiting merge and are excluded
 *   from both the building set and aheadCount.
 * - UNMERGEABLE entries are facing ejection (stale against the queue's base): they get
 *   `unmergeable: true` with no percent/eta/waiting-line math, and are transparent to every
 *   other entry's math (excluded from building set and aheadCount, like MERGEABLE).
 * - `coveringGroupOid` (HEADGREEN multi-PR groups): a queued entry whose position falls inside
 *   a building group's batch coverage range rides that group — when set, the entry inherits the
 *   group's {percent, etaSeconds, failed} with aheadCount 0, exactly like the own-group path.
 *   The entry's own AWAITING_CHECKS oid still wins when present.
 * - When a PR's mergeQueueEntry disappears after a failed group, the PR will re-classify from
 *   its PR-event rollup (it will look 'ready'). The poller may hold the previous queue stage
 *   for one tick if it wants smoother UX — not required for v1.
 */

import type { QueueEntry } from '../types';
import { percentile } from '../math';

export interface GroupProgress { oid: string; percent: number; etaSeconds: number | null; overdue: boolean; failed: boolean; }
export interface QueueStageResult {
  percent: number | null;
  etaSeconds: number | null;
  overdue: boolean;
  aheadCount: number; // entries ahead of me (MERGEABLE/UNMERGEABLE excluded — they occupy no future capacity)
  failed: boolean;    // true when my group has failed; false for QUEUED entries not yet in a group
  unmergeable: boolean; // true when my own entry state is UNMERGEABLE (facing ejection)
}

const DEFAULT_GROUP_SECS = 900;

export function queueStage(opts: {
  entries: QueueEntry[];
  prNumber: number;
  groups: GroupProgress[];
  medianGroupSecs: number | null;
  batchSize: number;
  /** Building-group oid whose batch coverage range includes this PR's position
   *  (computed by the poller); the PR rides that group's progress. */
  coveringGroupOid?: string | null;
}): QueueStageResult {
  const { entries, prNumber, groups, batchSize } = opts;
  const groupRun = opts.medianGroupSecs ?? DEFAULT_GROUP_SECS;
  const me = entries.find((x) => x.prNumber === prNumber);
  if (!me) return { percent: null, etaSeconds: null, overdue: false, aheadCount: 0, failed: false, unmergeable: false };

  // UNMERGEABLE = stale against the queue's base, facing ejection — no progress,
  // no waiting-line math; surfaced via the flag instead.
  if (me.state === 'UNMERGEABLE') {
    return { percent: null, etaSeconds: null, overdue: false, aheadCount: 0, failed: false, unmergeable: true };
  }

  const byOid = new Map(groups.map((g) => [g.oid, g]));

  // Building = AWAITING_CHECKS with a headCommitOid assigned (CI group is running).
  // A covered member (its position falls in a building group's batch range) rides
  // that group identically — its own oid wins when both are present.
  const groupOid = (me.state === 'AWAITING_CHECKS' && me.headCommitOid)
    ? me.headCommitOid
    : opts.coveringGroupOid ?? null;
  if (groupOid) {
    const g = byOid.get(groupOid);
    if (g) return { percent: g.percent, etaSeconds: g.etaSeconds, overdue: g.overdue, aheadCount: 0, failed: g.failed, unmergeable: false };
    return { percent: null, etaSeconds: groupRun, overdue: false, aheadCount: 0, failed: false, unmergeable: false };
  }

  // MERGEABLE entries are done-awaiting-merge and UNMERGEABLE entries are facing
  // ejection — neither occupies future runner capacity; both are excluded from the
  // building set and aheadCount.
  const ahead = entries.filter((x) => x.position < me.position
    && x.state !== 'MERGEABLE' && x.state !== 'UNMERGEABLE');
  // Building = AWAITING_CHECKS with headCommitOid (non-null asserts a CI group was assigned)
  const building = ahead.filter((x) => x.state === 'AWAITING_CHECKS' && x.headCommitOid);
  const queuedAhead = ahead.length - building.length;
  const deepest = [...building].sort((a, b) => b.position - a.position)[0];
  const deepestEta = deepest ? (byOid.get(deepest.headCommitOid!)?.etaSeconds ?? groupRun) : 0;
  const futureRuns = Math.ceil((queuedAhead + 1) / batchSize); // +1 = me
  return {
    percent: null,
    etaSeconds: Math.round(deepestEta + futureRuns * groupRun),
    overdue: false,
    aheadCount: ahead.length,
    failed: false,
    unmergeable: false,
  };
}

// ---- multi-train merge ETA simulation (issue #40) --------------------------

/** Eject probability above this adds one extra train at p90 ("assumes ≤1 eject"). */
export const EJECT_BUMP_MIN_PROB = 0.15;

/** Minimum (runs + ejects) samples before an observed eject probability is
 *  trusted; below this the probability reads as 0 (no p90 bump). */
export const EJECT_PROB_MIN_SAMPLES = 5;

/**
 * Observed 7-day eject probability: ejects / (runs + ejects). `runs` counts
 * clean group_runs rows; `ejects` counts distinct ejected group shas
 * (group_failures). Returns 0 under EJECT_PROB_MIN_SAMPLES total samples —
 * one bad afternoon must not double every p90 forever.
 */
export function ejectProbability(runs: number, ejects: number): number {
  const total = runs + ejects;
  if (!(total >= EJECT_PROB_MIN_SAMPLES)) return 0;
  return ejects / total;
}

export interface MergeEtaSimulation {
  p50Secs: number;
  p90Secs: number;
  /** Trains that must complete before this PR merges: the currently-building
   *  train ahead (when one exists) plus the future full batches ahead of mine. */
  trainsAhead: number;
  /** True when the p90 includes one extra train (ejectProb > EJECT_BUMP_MIN_PROB). */
  assumesEjects: boolean;
}

/**
 * Analytic multi-train merge ETA for a WAITING queue entry (issue #40) — no
 * Monte Carlo. With dur50/dur90 = p50/p90 of the observed train-duration
 * samples (group_runs, last 20):
 *
 *   trains    = ceil((queuedAhead + 1) / batchSize)        // future trains incl. mine
 *   p50Secs   = currentTrainEta + trains × dur50
 *   p90Secs   = currentTrainEta + (trains + bump) × dur90  // bump = 1 when ejectProb > 15%
 *   trainsAhead = trains − 1 + (1 when a train is currently building)
 *
 * The bump models "one of the trains ahead gets ejected and re-runs" — the
 * dominant tail risk in practice; deeper eject cascades are rare enough that
 * a single extra train keeps the p90 honest without simulation.
 *
 * Returns null without duration samples (callers fall back to the existing
 * single-number queueStage ETA).
 */
export function simulateMergeEta(opts: {
  /** QUEUED entries ahead of me (building/MERGEABLE/UNMERGEABLE excluded). */
  queuedAhead: number;
  batchSize: number;
  /** Observed whole-train durations (group_runs last 20), any order. */
  durationSamples: number[];
  /** 0..1 — already min-samples-gated (see ejectProbability). */
  ejectProb: number;
  /** Remaining ETA of the deepest currently-building train ahead; null when
   *  no train is building ahead of me. */
  currentTrainEtaSecs: number | null;
}): MergeEtaSimulation | null {
  const samples = opts.durationSamples.filter((d) => Number.isFinite(d) && d > 0);
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const dur50 = percentile(sorted, 0.5);
  const dur90 = percentile(sorted, 0.9);
  const batch = Math.max(1, opts.batchSize);
  const trains = Math.ceil((Math.max(0, opts.queuedAhead) + 1) / batch);
  const currentEta = Math.max(0, opts.currentTrainEtaSecs ?? 0);
  const assumesEjects = opts.ejectProb > EJECT_BUMP_MIN_PROB;
  return {
    p50Secs: Math.round(currentEta + trains * dur50),
    p90Secs: Math.round(currentEta + (trains + (assumesEjects ? 1 : 0)) * dur90),
    trainsAhead: trains - 1 + (opts.currentTrainEtaSecs != null ? 1 : 0),
    assumesEjects,
  };
}
