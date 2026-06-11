import type { CheckRun } from '../types';
import { matchingPrefix, workflowScopeAllows } from './classify';

/**
 * Runner-wait classification for queued checks (pure — no history/poller imports).
 *
 * A queued check whose needs-graph node is known is either:
 * - 'blocked'  — some needed upstream check is not completed-ok yet (still running,
 *                queued, missing from the rollup, or completed with a failing
 *                conclusion — the failed-need case is reported too);
 * - 'runner'   — every needed check completed ok, so the job is eligible to run and
 *                is waiting for a runner. waitingSeconds anchors on the LATEST
 *                needed completion; SKIPPED needs never anchor (their placeholder
 *                timestamps are unreliable — completedAt < startedAt observed in
 *                the wild — and skip-resolution is instant), so all-needs-skipped
 *                yields a null wait;
 * - 'unknown'  — the graph is unknown/unmatched, or the node is a root job
 *                (needs=[]: nothing to anchor a wait on).
 *
 * Event phases: jobs can be gated per event (`if: github.event_name == …` — PR CI
 * vs merge_group in the watched repos). A need whose job provably never runs for
 * the check's event is satisfied by absence and dropped via `activeFor`.
 */
export type WaitClassification =
  | { kind: 'unknown' }
  | { kind: 'blocked'; blockedOn: string }
  | { kind: 'runner'; waitingSeconds: number | null };

/** Whether the graph node `neededPrefix` can run for `event` (true when unknown). */
export type NeedActivePredicate = (neededPrefix: string, event: string) => boolean;

const ALWAYS_ACTIVE: NeedActivePredicate = () => true;

export interface RunnerWaitSample {
  name: string;       // canonical check name
  event: string;
  waitSecs: number;
  startedAt: string;
}

/** Statuses that mean "no runner has picked this check up yet". */
const QUEUED_STATUSES = new Set(['QUEUED', 'PENDING', 'REQUESTED', 'WAITING']);

/** Conclusions that satisfy a `needs:` edge (GitHub treats these as success-like). */
const OK_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

/**
 * Live checks satisfying a needed node prefix, within the same event population.
 * Each candidate is assigned to its graph node via longest-match over ALL graph
 * keys and must land exactly on `prefix` — bare startsWith would let a check on
 * a sibling longer-named node (`build-test`) satisfy a need on `build`. Callers
 * without a graph key list fall back to single-prefix matching.
 *
 * When the rollup workflow is known, only checks FROM that workflow (or with no
 * workflow identity — permissive for old data) can satisfy a need: the graph
 * describes the rollup workflow's jobs, so e.g. `Auto-merge PRs`' `ci-gate` must
 * never satisfy a need on the `ci` node.
 */
function matchingNeeded(prefix: string, check: CheckRun, allChecks: CheckRun[],
  graphKeys: readonly string[] | null, rollupWorkflowName: string | null): CheckRun[] {
  const keys = graphKeys ?? [prefix];
  return allChecks.filter((c) =>
    c !== check && c.event === check.event
    && workflowScopeAllows(c.workflowName, rollupWorkflowName)
    && matchingPrefix(c.name, keys) === prefix);
}

export function classifyWait(check: CheckRun, allChecks: CheckRun[],
  needs: string[] | null, now: Date,
  activeFor: NeedActivePredicate = ALWAYS_ACTIVE,
  graphKeys: readonly string[] | null = null,
  rollupWorkflowName: string | null = null): WaitClassification | null {
  if (!QUEUED_STATUSES.has(check.status)) return null;
  if (needs === null || needs.length === 0) return { kind: 'unknown' };
  // needs whose job never runs for this event are satisfied by absence
  const activeNeeds = needs.filter((p) => activeFor(p, check.event));
  // every need event-inactive: nothing to anchor on, but the check IS runner-waiting
  if (activeNeeds.length === 0) return { kind: 'runner', waitingSeconds: null };

  const completedAts: number[] = [];
  for (const prefix of activeNeeds) {
    const matched = matchingNeeded(prefix, check, allChecks, graphKeys, rollupWorkflowName);
    // needed job not in the rollup yet — blocked on the node itself
    if (matched.length === 0) return { kind: 'blocked', blockedOn: prefix };
    for (const m of matched) {
      if (m.status !== 'COMPLETED' || !OK_CONCLUSIONS.has(m.conclusion ?? '')) {
        return { kind: 'blocked', blockedOn: m.name };
      }
      if (m.conclusion === 'SKIPPED') continue; // satisfies the need, never anchors
      const t = m.completedAt ? Date.parse(m.completedAt) : NaN;
      if (Number.isFinite(t)) completedAts.push(t);
    }
  }
  if (completedAts.length === 0) return { kind: 'runner', waitingSeconds: null };
  return {
    kind: 'runner',
    waitingSeconds: Math.round((now.getTime() - Math.max(...completedAts)) / 1000),
  };
}

/**
 * Learnable runner-pickup samples from a check set: for every check WITH a
 * startedAt whose needs-graph node is known and non-empty, and whose needed
 * checks (same event) all have a completedAt —
 * wait = startedAt − max(needed completedAt). No new API calls required.
 * Needs inactive for the check's event are dropped (see classifyWait); SKIPPED
 * needs are excluded from the anchor (unreliable placeholder timestamps). When
 * no anchoring completion remains, no sample is emitted.
 * Implausible samples are dropped (kept range: 0 ≤ wait < 7200 — zero waits are
 * real same-second warm pickups; the UNIQUE constraint dedupes re-ingestion).
 */
export function extractRunnerWaits(checks: CheckRun[],
  needsFor: (canonicalName: string) => string[] | null,
  activeFor: NeedActivePredicate = ALWAYS_ACTIVE,
  graphKeys: readonly string[] | null = null,
  rollupWorkflowName: string | null = null): RunnerWaitSample[] {
  const samples: RunnerWaitSample[] = [];
  for (const check of checks) {
    if (!check.startedAt) continue;
    const needs = needsFor(check.name);
    if (needs === null || needs.length === 0) continue;
    const activeNeeds = needs.filter((p) => activeFor(p, check.event));
    let maxCompleted = -Infinity;
    let anchored = true;
    for (const prefix of activeNeeds) {
      const matched = matchingNeeded(prefix, check, checks, graphKeys, rollupWorkflowName);
      if (matched.length === 0) { anchored = false; break; }
      for (const m of matched) {
        if (m.conclusion === 'SKIPPED') continue; // never an anchor; instant resolution
        const t = m.completedAt ? Date.parse(m.completedAt) : NaN;
        if (!Number.isFinite(t)) { anchored = false; break; }
        if (t > maxCompleted) maxCompleted = t;
      }
      if (!anchored) break;
    }
    // maxCompleted === -Infinity: every active need skipped (or none active) — no anchor
    if (!anchored || maxCompleted === -Infinity) continue;
    const waitSecs = (Date.parse(check.startedAt) - maxCompleted) / 1000;
    if (!(waitSecs >= 0) || waitSecs >= 7200) continue; // also drops NaN
    samples.push({ name: check.name, event: check.event, waitSecs, startedAt: check.startedAt });
  }
  return samples;
}
