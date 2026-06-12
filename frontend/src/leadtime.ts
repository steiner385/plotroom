import type { LeadTimeSegmentId } from './types';

/** Lead-time segment display metadata (issue #44), pipeline order — mirrors
 *  the server's LEAD_TIME_SEGMENTS ids. Single source of truth for BOTH the
 *  Metrics lead-time panel and the per-PR waterfall (issue #50), so segment
 *  colors always agree between the two. */
export const LEAD_TIME_SEGMENTS: { id: LeadTimeSegmentId; label: string; color: string }[] = [
  { id: 'toFirstGreen', label: 'to first green', color: 'var(--accent)' },
  { id: 'greenToEnqueued', label: 'green → enqueued', color: 'var(--amber)' },
  { id: 'queue', label: 'queue', color: 'var(--purple)' },
  { id: 'qaDeploy', label: 'QA deploy', color: 'var(--done)' },
  { id: 'awaitingProd', label: 'awaiting prod', color: 'var(--fail)' },
];
