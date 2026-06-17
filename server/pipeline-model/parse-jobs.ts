import { parse } from 'yaml';
import { parseTriggers } from './parse-triggers';
import type { RawJob, TriggerSpec } from './types';

export function parseJobs(yamlText: string): { triggers: TriggerSpec; jobs: RawJob[] } {
  let doc: unknown;
  try { doc = parse(yamlText); } catch { return { triggers: { events: [] }, jobs: [] }; }
  if (!isObj(doc)) return { triggers: { events: [] }, jobs: [] };

  const triggers = parseTriggers(doc.on);
  const rawJobs = isObj(doc.jobs) ? doc.jobs : {};
  const jobs: RawJob[] = Object.entries(rawJobs).map(([id, j]) => {
    const job = isObj(j) ? j : {};
    const needs = job.needs == null ? []
      : Array.isArray(job.needs) ? (job.needs as unknown[]).map(String)
      : [String(job.needs)];
    const matrix = isObj(job.strategy) && isObj(job.strategy.matrix)
      ? matrixDims(job.strategy.matrix) : null;
    return {
      id,
      name: typeof job.name === 'string' ? job.name : null,
      needs,
      if: typeof job.if === 'string' ? job.if : null,
      uses: typeof job.uses === 'string' ? job.uses : null,
      matrix,
    };
  });
  return { triggers, jobs };
}

/** Keep only array-valued matrix dimensions (the ones that multiply instances);
 *  `include`/`exclude` and scalar entries are ignored for instance-counting. */
function matrixDims(m: Record<string, unknown>): Record<string, unknown[]> | null {
  const dims: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === 'include' || k === 'exclude') continue;
    // Fix #4: ignore empty-array dims (they would zero the product; treat as no matrix)
    if (Array.isArray(v) && v.length > 0) dims[k] = v as unknown[];
  }
  return Object.keys(dims).length ? dims : null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
