import type { GatingResult, StaticGraph } from './types';

/** Events at which a required check actually enforces a merge/branch gate. A
 *  `schedule` (nightly/weekly) run is a backstop cadence, never a gate — a
 *  required check that ALSO runs nightly must show as advisory at the Nightly
 *  tier, not as a gate. `workflow_dispatch`/`workflow_run` likewise don't gate. */
const GATING_EVENTS = new Set(['pull_request', 'merge_group', 'push']);

export function gatingClosure(
  graph: StaticGraph, requiredRollupName: string,
  opts: { conditionalCallerJobs?: string[] } = {},
): GatingResult {
  // Find the rollup caller job by id == requiredRollupName.
  if (!(requiredRollupName in graph.callerNeeds)) {
    return { gatingCallerJobs: [], conditionalCallerJobs: [], gates: [] };
  }
  // Transitive needs-closure from the rollup (excluding the rollup itself).
  const closure = new Set<string>();
  const stack = [...(graph.callerNeeds[requiredRollupName] ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (closure.has(id)) continue;
    closure.add(id);
    for (const n of graph.callerNeeds[id] ?? []) stack.push(n);
  }

  const conditional = new Set(opts.conditionalCallerJobs ?? []);
  const gatingCallerJobs = [...closure].filter((id) => !conditional.has(id)).sort((a, b) => a.localeCompare(b));
  const conditionalCallerJobs = [...closure].filter((id) => conditional.has(id)).sort((a, b) => a.localeCompare(b));

  // A node gates (unconditionally OR conditionally) when its caller is in the
  // closure; report the merge-relevant events it runs at. We intersect with
  // GATING_EVENTS so a required check that ALSO runs on `schedule` (because a
  // nightly/weekly workflow re-runs the same reusable) doesn't falsely register
  // as a *gate* at the Nightly tier — it's advisory there.
  const gates = graph.checks
    .filter((c) => closure.has(c.callerJobId))
    .map((c) => ({
      checkName: c.checkName,
      events: c.triggers.events.map((e) => e.kind).filter((k) => GATING_EVENTS.has(k)).sort(),
    }))
    .sort((a, b) => a.checkName.localeCompare(b.checkName));

  return { gatingCallerJobs, conditionalCallerJobs, gates };
}
