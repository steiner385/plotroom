import type { GatingResult, StaticGraph } from './types';

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
  // closure; report the events it runs at.
  const gates = graph.checks
    .filter((c) => closure.has(c.callerJobId))
    .map((c) => ({ checkName: c.checkName, events: c.triggers.events.map((e) => e.kind).sort() }))
    .sort((a, b) => a.checkName.localeCompare(b.checkName));

  return { gatingCallerJobs, conditionalCallerJobs, gates };
}
