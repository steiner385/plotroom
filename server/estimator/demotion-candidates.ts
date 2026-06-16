/**
 * Pure detector for "almost always green" CI checks that are candidates for
 * demotion to a lower-frequency tier. No I/O — the metrics builder feeds it
 * per-(check, event) success aggregates and it returns a ranked candidate list.
 *
 * Intelligence: among checks that clear the greenness bar, rank by COST (runner-
 * minutes spent in the window) descending — an expensive always-green check is a
 * far better demotion target than a cheap one, because demoting it saves real
 * minutes for little lost signal. This is the "cost × greenness" ranking.
 *
 * The success rate is computed over distinct (sha, attempt) runs with CANCELLED
 * excluded (see SuccessStat), so a FLAKY check — which has a failed attempt in
 * the window — drops below the threshold and never qualifies. That keeps this
 * lane cleanly distinct from the flake lane: flaky ≠ demotable.
 *
 * GATE SAFETY (see demotionTarget): the detector never proposes a demotion that
 * removes a merge gate. A merge_group check is the terminal pre-land gate and is
 * never suggested for a post-merge tier; a pull_request check is suggested only
 * when the same check still gates in the merge queue, so the suggestion can only
 * ever move WHERE a green check runs, never leave it ungated. "Green gate" is
 * survivorship — evidence the control works, not that it is removable.
 */

/** Minimum distinct runs in the window for a check to be eligible — a long green
 *  streak on 3 runs is not evidence. */
export const DEMOTION_MIN_RUNS = 50;
/** Success-rate bar (percent). ≥99% tolerates a single rare real failure. */
export const DEMOTION_MIN_SUCCESS_PCT = 99;
/** Cap on rows surfaced (advisory panel). */
export const DEMOTION_TOP_N = 12;

/**
 * Per-(check, event) success aggregate over the metrics window. `totalRuns` and
 * `failingRuns` count distinct (sha, attempt) samples with CANCELLED excluded
 * (a spot-kill is not a failure); `sumDurationSecs` is the total runner-seconds
 * the check spent in the window — the cost basis for ranking.
 */
export interface SuccessStat {
  name: string;
  event: string;
  totalRuns: number;
  failingRuns: number;
  sumDurationSecs: number;
}

/**
 * The lower-frequency tier a candidate may be demoted to — GATE-AWARE.
 *
 * The key safety rule: a `merge_group` check is the **terminal pre-land gate**
 * (the merge queue runs the required `ci` rollup on the merge_group ref, and
 * these jobs are its `needs`). A post-merge tier (nightly) runs AFTER merge and
 * AFTER main auto-deploys, so demoting a queue gate to nightly converts a
 * *preventive* control into a *detective* one — broken/non-compliant code would
 * merge and deploy before the check ever runs. "100% green" on a gate is
 * survivorship (the gate is green because it's blocking the failures), not
 * evidence it's removable. So we NEVER suggest demoting a merge_group check.
 *
 * A `pull_request` check is only safe to demote to "merge queue only" when the
 * SAME check still runs on `merge_group` (the gate remains in the queue — the
 * #7534 pattern). If it runs only on PRs, demoting it off PRs would ungate it
 * entirely, so we suppress it.
 *
 * A `push` check runs post-merge already (a main backstop, not a gate), so
 * demoting it to nightly only reduces backstop frequency — allowed.
 *
 * Returns null when no SAFE demotion exists for this (check, event).
 */
interface Ladder { currentTier: string; suggestedTier: string; }
function demotionTarget(stat: SuccessStat, gatedInQueue: Set<string>): Ladder | null {
  if (stat.event === 'pull_request') {
    // Safe ONLY if the gate remains in the merge queue.
    if (!gatedInQueue.has(stat.name)) return null;
    return { currentTier: 'every PR push', suggestedTier: 'merge queue only' };
  }
  if (stat.event === 'push') {
    return { currentTier: 'every push to main', suggestedTier: 'nightly' };
  }
  // merge_group (the gate) and any other event: no safe demotion from success
  // data alone.
  return null;
}

/** One demotion candidate, projected to the serializable facts the UI ships. */
export interface DemotionCandidate {
  name: string;
  event: string;
  currentTier: string;
  suggestedTier: string;
  /** Success rate over the window, 1-decimal percent. */
  successRatePct: number;
  runsInWindow: number;
  /** Runner-minutes spent in the window — the cost basis and the rank key. */
  minutesInWindow: number;
  reason: string;
}

export interface DemotionConfig { minRuns: number; minSuccessPct: number; topN: number; }
export const DEMOTION_DEFAULTS: DemotionConfig = {
  minRuns: DEMOTION_MIN_RUNS, minSuccessPct: DEMOTION_MIN_SUCCESS_PCT, topN: DEMOTION_TOP_N,
};

export function computeDemotionCandidates(
  stats: SuccessStat[], cfg: DemotionConfig = DEMOTION_DEFAULTS,
): DemotionCandidate[] {
  // Check NAMES that run on merge_group — i.e. still gate in the queue. Presence
  // (not greenness) is what matters: a gate that runs at all keeps protecting,
  // so a PR-tier demotion of the same check leaves the queue gate intact. Built
  // from the FULL stats list, not just candidates.
  const gatedInQueue = new Set(
    stats.filter((s) => s.event === 'merge_group' && s.totalRuns > 0).map((s) => s.name),
  );
  const out: DemotionCandidate[] = [];
  for (const s of stats) {
    if (s.totalRuns < cfg.minRuns) continue;     // not enough history to trust
    const greenRuns = s.totalRuns - s.failingRuns;
    const successPct = s.totalRuns ? (greenRuns / s.totalRuns) * 100 : 0;
    if (successPct < cfg.minSuccessPct) continue; // not green enough
    const ladder = demotionTarget(s, gatedInQueue);
    if (!ladder) continue;                        // no SAFE demotion (gate / would ungate)
    const minutes = Math.round(s.sumDurationSecs / 60);
    out.push({
      name: s.name,
      event: s.event,
      currentTier: ladder.currentTier,
      suggestedTier: ladder.suggestedTier,
      successRatePct: Math.round(successPct * 10) / 10,
      runsInWindow: s.totalRuns,
      minutesInWindow: minutes,
      reason: `${greenRuns}/${s.totalRuns} green · ~${minutes} runner-min in window`,
    });
  }
  // All survivors clear the greenness bar, so rank purely by cost (minutes
  // spent) desc — most expensive always-green checks first. Tiebreak by name
  // for a stable order.
  out.sort((a, b) => b.minutesInWindow - a.minutesInWindow || a.name.localeCompare(b.name));
  return out.slice(0, cfg.topN);
}
