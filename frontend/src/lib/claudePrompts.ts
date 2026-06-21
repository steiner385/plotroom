// Pure builders that turn a recommendation/candidate into a ready-to-paste Claude
// Code prompt — the "draft a Claude Code prompt" counterpart to each "Draft PR"
// button. Self-contained instructions (rationale + the change + a PR title) an
// engineer can hand to their own CC session. No I/O; trivially unit-tested.
import type { DemotionCandidate, PromotionCandidate } from '../types';
import type { CandidateMutationDto } from '../shell/workspaceApi';

/** Demote an almost-always-green TERMINAL check to a lower-frequency tier. Mirrors
 *  the server's demotion proposal rationale (see server/demotion-action.ts). */
export function demotionPrompt(repo: string, c: DemotionCandidate): string {
  return [
    `In ${repo}, demote the CI check "${c.name}" so it runs less often — move it from ${c.currentTier} to ${c.suggestedTier}.`,
    ``,
    `Why: ${c.reason} (${c.successRatePct}% green over ${c.runsInWindow} runs, ~${c.minutesInWindow.toLocaleString()} runner-min/window). It is a TERMINAL check — no other job declares \`needs:\` it — so demoting it forfeits no fail-fast cancellation.`,
    ``,
    `Edit the workflow that defines "${c.name}":`,
    `- Restrict it so it no longer runs on every \`pull_request\` (e.g. add \`if: github.event_name == 'merge_group'\`, or move the job out of the PR job-set).`,
    `- Do NOT remove any merge-queue gate — the \`ci\` rollup must still pass on PRs.`,
    ``,
    `Open a PR titled "ci: demote ${c.name} (reduce redundant runs)".`,
  ].join('\n');
}

/** Shift a real-failing late check left so failures surface at PR time. */
export function promotionPrompt(repo: string, c: PromotionCandidate): string {
  const fails = `${c.realFailures} real, non-flaky failure${c.realFailures === 1 ? '' : 's'} across ${c.incidents} incident${c.incidents === 1 ? '' : 's'}`;
  return [
    `In ${repo}, shift the CI check "${c.name}" left so real failures are caught earlier — promote it from ${c.currentTier} to ${c.suggestedTier}.`,
    ``,
    `Why: ${c.reason} (${fails}; ${c.failRatePct}% of ${c.runsInWindow} runs). Catching these at PR time avoids late ${c.currentTier} failures.`,
    ``,
    `Edit the workflow that defines "${c.name}":`,
    `- Add it to the PR tier (relax the \`if:\` / add \`pull_request\` to \`on:\`) so it runs on PRs.`,
    `- This ADDS PR-time cost — confirm the failures are real (not flake) before committing.`,
    ``,
    `Open a PR titled "ci: shift ${c.name} left to PR".`,
  ].join('\n');
}

function describeMutation(m: CandidateMutationDto): string {
  switch (m.op) {
    case 'timeout': return `Set \`timeout-minutes: ${m.minutes}\` on job \`${m.jobId}\`.`;
    case 'runner': return `Change \`runs-on\` of job \`${m.jobId}\` to \`${m.runsOn}\`.`;
    case 'concurrency': return `Add a \`concurrency\` group \`${m.group}\` (with cancel-in-progress) to the workflow.`;
    case 'shift-left': return `Shift job \`${m.jobId}\` left so it runs on \`pull_request\` for earlier feedback.`;
    case 'remove': return `Remove job \`${m.jobId}\` from the pipeline.`;
  }
}

/** Apply a composed stack of structured pipeline edits (the Build tab's candidate). */
export function pipelineEditsPrompt(repo: string, mutations: CandidateMutationDto[]): string {
  const n = mutations.length;
  return [
    `In ${repo}, apply the following CI pipeline change${n === 1 ? '' : 's'} to .github/workflows:`,
    ``,
    ...mutations.map((m) => `- ${describeMutation(m)}`),
    ``,
    `Constraints:`,
    `- Do NOT drop any required merge-queue gate — the \`ci\` rollup must still pass on PRs.`,
    `- Keep the edits minimal and structured; preserve unrelated jobs and keys.`,
    ``,
    `Open a PR titled "ci: pipeline changes (${n} change${n === 1 ? '' : 's'})".`,
  ].join('\n');
}

/** Set requiredCheckPrefixes in .pr-dashboard.yml (the Prefixes lever). */
export function prefixesPrompt(repo: string, prefixes: string[]): string {
  return [
    `In ${repo}, set \`requiredCheckPrefixes\` in .pr-dashboard.yml so the merge queue can tell a real gate failure from advisory noise.`,
    ``,
    `Set it to exactly:`,
    `requiredCheckPrefixes:`,
    ...prefixes.map((p) => `  - ${p}`),
    ``,
    `Preserve every other key in .pr-dashboard.yml unchanged. Open a PR titled "ci: set requiredCheckPrefixes".`,
  ].join('\n');
}
