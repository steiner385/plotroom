// server/pipeline-model/derive-static.ts
import { parseJobs } from './parse-jobs';
import { narrowEvents } from './narrow-events';
import { expandMatrix } from './expand-matrix';
import type { CheckNode, MatrixCoord, RawJob, StaticGraph, TriggerSpec } from './types';

/**
 * Derive a static CheckNode graph from a set of workflow YAML files.
 *
 * Limits (emitted as confidence:'low', never silently wrong):
 *   - a reusable workflow that itself calls another reusable workflow (nested `uses:`)
 *     is not expanded one level deeper; the node is kept with its name but marked low.
 *   - a `uses:` caller with its own `strategy.matrix` is not fanned out; all emitted
 *     nodes for that caller are marked low.
 */
export function deriveStaticGraph(
  files: Record<string, string>, opts: { rollupFile?: string } = {},
): StaticGraph {
  const rollupFile = opts.rollupFile ?? 'ci.yml';
  const parsed = Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, parseJobs(text)]),
  );
  const rollup = parsed[rollupFile] ?? { triggers: { events: [] }, jobs: [] };

  const checks: CheckNode[] = [];
  const callerNeeds: Record<string, string[]> = {};

  for (const job of rollup.jobs) {
    callerNeeds[job.id] = job.needs;
    const narrowed = narrowEvents(rollup.triggers.events, job.if);
    const callerTriggers: TriggerSpec = { events: narrowed.events };
    const callerLabel = job.name ?? job.id;

    if (job.uses) {
      const calleeName = basename(job.uses);
      const callee = parsed[calleeName];
      if (!callee) {
        // unresolved reusable workflow: opaque, low confidence (spec §5.5)
        checks.push({
          checkName: callerLabel, callerJobId: job.id, triggers: callerTriggers,
          provenance: [{ file: rollupFile, jobId: job.id }], confidence: 'low',
        });
        continue;
      }
      for (const leaf of callee.jobs) {
        for (const inst of expandLeaf(leaf)) {
          checks.push({
            checkName: `${callerLabel} / ${leaf.name ?? leaf.id}${inst.suffix}`,
            callerJobId: job.id,
            triggers: callerTriggers,
            provenance: [
              { file: rollupFile, jobId: job.id },
              { file: calleeName, jobId: leaf.id, ...(inst.coord && Object.keys(inst.coord).length ? { matrixCoord: inst.coord } : {}) },
            ],
            // Fix #1: leaf itself has uses: → nested reusable workflow, unresolvable deeper.
            // Fix #2: caller has its own matrix on a uses: job → fan-out unmodelled.
            confidence: (narrowed.confidence === 'low' || leaf.uses != null || job.matrix != null) ? 'low' : 'high',
          });
        }
      }
    } else {
      // plain job: surfaces under its own name; one node per matrix instance
      for (const inst of expandLeaf(job)) {
        checks.push({
          checkName: `${callerLabel}${inst.suffix}`,
          callerJobId: job.id,
          triggers: callerTriggers,
          provenance: [{ file: rollupFile, jobId: job.id, ...(inst.coord && Object.keys(inst.coord).length ? { matrixCoord: inst.coord } : {}) }],
          confidence: narrowed.confidence,
        });
      }
    }
  }

  return { rollupFile, checks, callerNeeds };
}

/** Expand one job into instances, computing a GitHub-style suffix `(i/n)` using the
 *  instance's POSITION in the expanded product (not indexOf, which collides on repeated
 *  values). No matrix → one bare instance. */
function expandLeaf(job: RawJob): { coord: MatrixCoord; suffix: string }[] {
  const coords = expandMatrix(job.matrix);
  if (!job.matrix) return coords.map((coord) => ({ coord, suffix: '' }));
  const total = coords.length;
  return coords.map((coord, i) => ({ coord, suffix: ` (${i + 1}/${total})` }));
}

function basename(usesPath: string): string {
  return usesPath.split('/').pop() ?? usesPath;
}
