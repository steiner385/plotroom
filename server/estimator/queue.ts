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
