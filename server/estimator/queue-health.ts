/**
 * Merge-queue health classifier (issue #39) — discriminates the two documented
 * incident shapes, which have OPPOSITE remediations:
 *
 *   - dispatch-stall (2026-06-08 incident class): workflow runs for building
 *     groups EXIST but never get picked up — REST `run_started_at == created_at`
 *     (GraphQL `WorkflowRun` exposes no runStartedAt today, so the poller passes
 *     null and the signature falls back to "no check has left the queued
 *     statuses"). Remediation: HUMAN queue recovery (delete-and-recreate);
 *     never admin-merge.
 *
 *   - cap-backlog: runs DO start, but checks sit in runner-pickup waits —
 *     demand exceeds the runner cap. Remediation: wait, or raise the cap.
 *
 * Pure function — all GitHub/SQLite I/O happens in the poller, which assembles
 * one GroupBuildTelemetry per building group from the group rollup checks.
 */

export type QueueHealthState = 'healthy' | 'cap-backlog' | 'dispatch-stall';

export interface QueueHealth {
  state: QueueHealthState;
  /** Human remediation string for the state (verbatim from QUEUE_HEALTH_REMEDIATION). */
  detail: string;
}

/** A run must be at least this old before "nothing started" reads as a stall —
 *  younger runs are simply warming up (cold runner pools take minutes). */
export const DISPATCH_STALL_MIN_AGE_SECS = 5 * 60;

/** A runner-pickup wait must reach this before it reads as cap-backlog —
 *  a few seconds of pickup latency is normal, not demand pressure. */
export const CAP_BACKLOG_MIN_WAIT_SECS = 60;

export const QUEUE_HEALTH_REMEDIATION: Record<QueueHealthState, string> = {
  healthy: 'queue healthy',
  'cap-backlog': 'cap-backlog: demand exceeds runner cap — wait or raise cap',
  'dispatch-stall': 'dispatch-stall: queue recovery needed — do NOT admin-merge',
};

/** Per-building-group build telemetry, assembled by the poller from the
 *  group rollup's checks (see Poller.groupTelemetryFor). */
export interface GroupBuildTelemetry {
  oid: string;
  /** Earliest `workflowRun.createdAt` among the group's checks; null when the
   *  rollup carries no workflow-run identity (old data / not fetched yet). */
  runCreatedAt: string | null;
  /** REST-only `run_started_at` when a future enrichment supplies it; the
   *  GraphQL path always passes null (field verified absent on WorkflowRun). */
  runStartedAt: string | null;
  /** True when any check has left the queued statuses (IN_PROGRESS/COMPLETED)
   *  — i.e. the run was picked up by at least one runner. */
  anyCheckStarted: boolean;
  /** Checks currently classified waitKind 'runner' (needs satisfied, waiting
   *  for a runner). */
  runnerWaitsInProgress: number;
  /** Longest measured in-progress runner wait (seconds); null when none of the
   *  waiting checks has a measurable wait (e.g. event-inactive needs). */
  maxRunnerWaitSecs: number | null;
}

function isStalled(g: GroupBuildTelemetry, nowMs: number): boolean {
  if (g.anyCheckStarted) return false; // something ran — not a dispatch stall
  if (!g.runCreatedAt) return false;   // no run identity — can't age it
  const createdMs = Date.parse(g.runCreatedAt);
  if (!Number.isFinite(createdMs)) return false;
  if ((nowMs - createdMs) / 1000 <= DISPATCH_STALL_MIN_AGE_SECS) return false;
  // run never started: runStartedAt unknown (GraphQL) or pinned to createdAt (REST)
  return g.runStartedAt == null || g.runStartedAt === g.runCreatedAt;
}

function isBacklogged(g: GroupBuildTelemetry): boolean {
  if (g.runnerWaitsInProgress === 0) return false;
  // an unmeasurable wait still counts — the check IS runner-waiting
  return g.maxRunnerWaitSecs == null || g.maxRunnerWaitSecs >= CAP_BACKLOG_MIN_WAIT_SECS;
}

/**
 * Classify the queue's health from its building groups' telemetry.
 * Precedence: dispatch-stall (the dangerous one — wrong remediation makes it
 * worse) > cap-backlog > healthy. No building groups = healthy (a queue of
 * only-waiting entries is indistinguishable from a fresh batch about to start).
 */
export function classifyQueueHealth(groups: GroupBuildTelemetry[], now: Date): QueueHealth {
  const nowMs = now.getTime();
  if (groups.some((g) => isStalled(g, nowMs))) {
    return { state: 'dispatch-stall', detail: QUEUE_HEALTH_REMEDIATION['dispatch-stall'] };
  }
  if (groups.some(isBacklogged)) {
    return { state: 'cap-backlog', detail: QUEUE_HEALTH_REMEDIATION['cap-backlog'] };
  }
  return { state: 'healthy', detail: QUEUE_HEALTH_REMEDIATION.healthy };
}
