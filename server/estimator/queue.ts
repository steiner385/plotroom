/**
 * Estimator contracts (for the poller — Task 11):
 *
 * - headCommitOid non-null iff AWAITING_CHECKS is assumed from the mapper; entries with
 *   state AWAITING_CHECKS but headCommitOid=null are not yet building (no CI group assigned).
 * - GroupProgress.failed must be fed from computeProgress().failed for the group's checks.
 * - MERGEABLE entries occupy no future capacity: they are done awaiting merge and are excluded
 *   from both the building set and aheadCount.
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
  aheadCount: number; // entries ahead of me (MERGEABLE excluded — they occupy no future capacity)
  failed: boolean;    // true when my group has failed; false for QUEUED entries not yet in a group
}

const DEFAULT_GROUP_SECS = 900;

export function queueStage(opts: {
  entries: QueueEntry[];
  prNumber: number;
  groups: GroupProgress[];
  medianGroupSecs: number | null;
  batchSize: number;
}): QueueStageResult {
  const { entries, prNumber, groups, batchSize } = opts;
  const groupRun = opts.medianGroupSecs ?? DEFAULT_GROUP_SECS;
  const me = entries.find((x) => x.prNumber === prNumber);
  if (!me) return { percent: null, etaSeconds: null, overdue: false, aheadCount: 0, failed: false };

  const byOid = new Map(groups.map((g) => [g.oid, g]));

  // Building = AWAITING_CHECKS with a headCommitOid assigned (CI group is running)
  if (me.state === 'AWAITING_CHECKS' && me.headCommitOid) {
    const g = byOid.get(me.headCommitOid);
    if (g) return { percent: g.percent, etaSeconds: g.etaSeconds, overdue: g.overdue, aheadCount: 0, failed: g.failed };
    return { percent: null, etaSeconds: groupRun, overdue: false, aheadCount: 0, failed: false };
  }

  // MERGEABLE entries are done-awaiting-merge — they occupy no future runner capacity and
  // are excluded from both the building set and aheadCount.
  const ahead = entries.filter((x) => x.position < me.position && x.state !== 'MERGEABLE');
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
  };
}
