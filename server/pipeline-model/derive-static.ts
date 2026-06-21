// server/pipeline-model/derive-static.ts
import { parseJobs } from './parse-jobs';
import { narrowEvents } from './narrow-events';
import { expandMatrix } from './expand-matrix';
import type { CheckNode, MatrixCoord, RawJob, StaticGraph, TriggerEvent, TriggerSpec } from './types';

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

  // Events that reach each reusable workflow from OTHER entry-point workflows
  // (e.g. nightly.yml / weekly.yml, which are `on: schedule`). The rollup derives
  // checks from its own jobs only, so a check that also runs nightly — because
  // nightly.yml `uses:` the same reusable (possibly via a nested reusable) — would
  // otherwise never carry the `schedule` trigger and its Nightly tier would be
  // empty. Union those events onto the check so the Nightly tier reflects reality.
  const reusableEvents = reusableEntryEvents(parsed, rollupFile);

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
      // The check runs on the rollup's (narrowed) events PLUS any events from other
      // entry workflows (nightly/weekly) that reach this reusable — so its Nightly
      // tier isn't falsely empty.
      const triggers: TriggerSpec = { events: mergeEventsByKind(narrowed.events, reusableEvents.get(calleeName) ?? []) };
      if (!callee) {
        // unresolved reusable workflow: opaque, low confidence (spec §5.5)
        checks.push({
          checkName: callerLabel, callerJobId: job.id, triggers,
          provenance: [{ file: rollupFile, jobId: job.id }], confidence: 'low',
        });
        continue;
      }
      for (const leaf of callee.jobs) {
        for (const inst of expandLeaf(leaf)) {
          checks.push({
            checkName: `${callerLabel} / ${leaf.name ?? leaf.id}${inst.suffix}`,
            callerJobId: job.id,
            triggers,
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

/** Union two event lists, deduped by `kind` (first occurrence wins — keeps the
 *  rollup's narrowed event config over a bare inherited one). */
function mergeEventsByKind(a: TriggerEvent[], b: TriggerEvent[]): TriggerEvent[] {
  const byKind = new Map<string, TriggerEvent>();
  for (const e of a) if (!byKind.has(e.kind)) byKind.set(e.kind, e);
  for (const e of b) if (!byKind.has(e.kind)) byKind.set(e.kind, e);
  return [...byKind.values()];
}

/** For each reusable workflow, the set of trigger events under which OTHER
 *  entry-point workflows (every parsed file that declares real `on:` events and
 *  isn't the rollup) reach it — following `uses:` edges TRANSITIVELY, so a
 *  reusable invoked via a nested reusable (nightly.yml → _full-ci.yml →
 *  _static-checks.yml) still inherits the entry's events. Reusables have
 *  `on: workflow_call` → no events (parseTriggers drops it), so they're never
 *  treated as entries. Per-job `if:` narrowing of the secondary entry isn't
 *  applied (scheduled workflows almost always run their jobs unconditionally);
 *  the result is the broadest-safe interpretation (spec §5.5). */
function reusableEntryEvents(
  parsed: Record<string, { triggers: TriggerSpec; jobs: RawJob[] }>,
  rollupFile: string,
): Map<string, TriggerEvent[]> {
  const byReusable = new Map<string, Map<string, TriggerEvent>>();
  for (const [file, wf] of Object.entries(parsed)) {
    if (file === rollupFile || wf.triggers.events.length === 0) continue; // not a (non-rollup) entry
    // BFS over uses: edges; record this entry's events on every reusable reached.
    const seen = new Set<string>();
    const stack: string[] = wf.jobs.filter((j) => j.uses).map((j) => basename(j.uses!));
    while (stack.length) {
      const ru = stack.pop()!;
      if (seen.has(ru)) continue;
      seen.add(ru);
      const bag = byReusable.get(ru) ?? new Map<string, TriggerEvent>();
      for (const e of wf.triggers.events) if (!bag.has(e.kind)) bag.set(e.kind, e);
      byReusable.set(ru, bag);
      const callee = parsed[ru];
      if (callee) for (const j of callee.jobs) if (j.uses) stack.push(basename(j.uses));
    }
  }
  return new Map([...byReusable].map(([f, m]) => [f, [...m.values()]]));
}
