import { parse } from 'yaml';

interface JobDef {
  name?: unknown;
  uses?: unknown;
  needs?: unknown;
  if?: unknown;
}

/**
 * Conservative event-activity for a job, derived from its `if:` expression.
 * - 'all'    — no `if:`, no `github.event_name` mention, or a form the heuristic
 *              can't reason about (mixed ==/!=, exotic functions). Safe default.
 * - 'only'   — positive `github.event_name == 'X'` mentions: the job provably
 *              never runs for events outside the set (any non-event clauses are
 *              assumed true, which can only WIDEN activity within the set).
 * - 'except' — negative-only `github.event_name != 'Y'` mentions: treated as
 *              provably inactive for Y, active everywhere else.
 */
export type EventActivity =
  | { mode: 'all' }
  | { mode: 'only'; events: string[] }
  | { mode: 'except'; events: string[] };

export interface CiGraphNode {
  /** Needed node prefixes (same naming rules as `prefixes`). */
  needs: string[];
  /** Which workflow events the job can run for. */
  activity: EventActivity;
}

export interface CiGraph {
  /** Required-check name prefixes (the rollup job's needs-closure, BFS order). */
  prefixes: string[];
  /** Display-name-level nodes: node prefix → { needs, event activity }. */
  nodes: Map<string, CiGraphNode>;
  /** Workflow display name (YAML top-level `name:`, e.g. `CI`); null when absent.
   *  Used to scope the required population to checks from THIS workflow. */
  workflowName: string | null;
}

/** JSON-serializable CiGraph (the `nodes` Map flattened to a plain record) —
 *  the persisted last-known-good shape stored in the history `meta` table. */
export interface CiGraphJson {
  prefixes: string[];
  nodes: Record<string, CiGraphNode>;
  workflowName: string | null;
}

export function ciGraphToJson(g: CiGraph): CiGraphJson {
  return {
    prefixes: [...g.prefixes],
    nodes: Object.fromEntries(g.nodes),
    workflowName: g.workflowName,
  };
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

function isActivity(v: unknown): v is EventActivity {
  if (!v || typeof v !== 'object') return false;
  const a = v as { mode?: unknown; events?: unknown };
  if (a.mode === 'all') return true;
  return (a.mode === 'only' || a.mode === 'except') && isStringArray(a.events);
}

/** Decode a persisted CiGraphJson back into a CiGraph. Null when the value is
 *  not a structurally valid graph (corrupt/legacy row) — callers treat that as
 *  "nothing persisted" rather than restoring garbage. */
export function ciGraphFromJson(raw: unknown): CiGraph | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const g = raw as { prefixes?: unknown; nodes?: unknown; workflowName?: unknown };
  if (!isStringArray(g.prefixes)) return null;
  if (g.workflowName !== null && typeof g.workflowName !== 'string') return null;
  if (!g.nodes || typeof g.nodes !== 'object' || Array.isArray(g.nodes)) return null;
  const nodes = new Map<string, CiGraphNode>();
  for (const [prefix, node] of Object.entries(g.nodes)) {
    const n = node as { needs?: unknown; activity?: unknown } | null;
    if (!n || typeof n !== 'object' || !isStringArray(n.needs) || !isActivity(n.activity)) return null;
    nodes.set(prefix, { needs: n.needs, activity: n.activity });
  }
  return { prefixes: g.prefixes, nodes, workflowName: g.workflowName ?? null };
}

/** True unless `activity` PROVES the job never runs for `event`. */
export function activeForEvent(activity: EventActivity, event: string): boolean {
  if (activity.mode === 'only') return activity.events.includes(event);
  if (activity.mode === 'except') return !activity.events.includes(event);
  return true;
}

const ALL: EventActivity = { mode: 'all' };
const EVENT_MENTION = /github\.event_name\s*([!=]=)\s*['"]([^'"]+)['"]/g;

/**
 * Extract an event-activity predicate from a job's `if:` string.
 *
 * Heuristic (deliberately conservative — only prune what is provable):
 * - positive mentions `github.event_name == 'X'` → potentially-active set {X…}.
 *   Non-event clauses compounded with `&&`/`||` are assumed true; that can only
 *   make MORE of the expression true, never activate an event outside the set,
 *   so 'only' remains a sound proof of inactivity for the rest.
 * - negative mentions `github.event_name != 'Y'` count only when there are NO
 *   positive mentions → active for everything except {Y…}. (With an `||` of
 *   non-event clauses this can over-prune — see the caveat in `mode: 'except'` —
 *   but the observed pattern gates advisory jobs outside the rollup closure.)
 * - both kinds present, or `event_name` used in an unrecognized form → 'all'.
 */
function extractActivity(ifExpr: unknown): EventActivity {
  if (typeof ifExpr !== 'string' || !ifExpr.includes('github.event_name')) return ALL;
  const pos = new Set<string>();
  const neg = new Set<string>();
  for (const m of ifExpr.matchAll(EVENT_MENTION)) {
    (m[1] === '==' ? pos : neg).add(m[2]!);
  }
  if (pos.size > 0 && neg.size > 0) return ALL; // mixed — nothing provable
  if (pos.size > 0) return { mode: 'only', events: [...pos] };
  if (neg.size > 0) return { mode: 'except', events: [...neg] };
  return ALL;
}

/** Union of two activities (two job keys sharing a display name → one node). */
function mergeActivity(a: EventActivity, b: EventActivity): EventActivity {
  if (a.mode === 'only' && b.mode === 'only') {
    return { mode: 'only', events: [...new Set([...a.events, ...b.events])] };
  }
  if (a.mode === 'except' && b.mode === 'except') {
    return { mode: 'except', events: a.events.filter((e) => b.events.includes(e)) };
  }
  return ALL; // any other mix: can't prove inactivity for anything
}

/**
 * Derive the required-check graph from a GitHub Actions workflow file by
 * walking the rollup job's `needs:` graph — one parse, two outputs.
 *
 * The watched repos gate merges on a single rollup job (`ci`) that `needs:`
 * every blocking job. A PR's blocking checks are therefore exactly the rollup
 * job plus its transitive needs-closure. For each job in the closure the check
 * name prefix is the job's display `name:` (falling back to the job key); jobs
 * that call a reusable workflow (`uses:`) render their checks as
 * `<name> / <inner job>`, so those prefixes get a ` /` suffix to avoid
 * accidentally matching unrelated checks that share the bare name.
 *
 * `nodes` maps each closure node's prefix to the prefixes of the jobs it
 * `needs:` (same naming rules) plus an event-activity predicate parsed from the
 * job's `if:` — used to classify queued checks as waiting-for-runner vs
 * blocked-on-upstream, per event phase (PR CI vs merge_group). `prefixes` stays
 * event-agnostic (the union over all events), as before.
 *
 * Unparseable YAML returns `null` — derivation learned nothing, so callers keep
 * the richer config/derived-so-far/fallback prefixes. VALID yaml with a missing
 * `jobs:` map or missing rollup job degrades to the rollup-only graph (the
 * rollup check itself always exists, and nothing else gates the merge).
 * Cycle-safe via a visited set.
 */
export function deriveCiGraph(ciYamlText: string, rollupJobId = 'ci'): CiGraph | null {
  let doc: unknown;
  try {
    doc = parse(ciYamlText);
  } catch {
    return null;
  }
  const rawName = (doc as { name?: unknown } | null)?.name;
  const workflowName = typeof rawName === 'string' && rawName ? rawName : null;
  const jobs = (doc as { jobs?: unknown } | null)?.jobs;
  const rollupOnly = (): CiGraph =>
    ({ prefixes: [rollupJobId], nodes: new Map([[rollupJobId, { needs: [], activity: ALL }]]), workflowName });
  if (!jobs || typeof jobs !== 'object') return rollupOnly();
  const jobMap = jobs as Record<string, JobDef | null>;
  if (!(rollupJobId in jobMap)) return rollupOnly();

  const prefixOf = (jobKey: string): string => {
    const job = jobMap[jobKey] ?? {};
    const name = typeof job.name === 'string' && job.name ? job.name : jobKey;
    return typeof job.uses === 'string' && job.uses ? `${name} /` : name;
  };

  // BFS over needs, starting at the rollup job (included in the closure)
  const visited = new Set<string>([rollupJobId]);
  const queue = [rollupJobId];
  const prefixes: string[] = [];
  const nodes = new Map<string, CiGraphNode>();
  while (queue.length) {
    const jobKey = queue.shift()!;
    const job = jobMap[jobKey] ?? {};
    const prefix = prefixOf(jobKey);
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
    const rawNeeds = typeof job.needs === 'string' ? [job.needs]
      : Array.isArray(job.needs) ? job.needs : [];
    const neededKeys = rawNeeds.filter((n): n is string => typeof n === 'string' && n in jobMap);
    // two job keys can share a display name — union their needs/activity under one node
    const existing = nodes.get(prefix);
    const neededPrefixes = existing?.needs ?? [];
    for (const k of neededKeys) {
      const np = prefixOf(k);
      if (!neededPrefixes.includes(np)) neededPrefixes.push(np);
    }
    const activity = extractActivity(job.if);
    nodes.set(prefix, {
      needs: neededPrefixes,
      activity: existing ? mergeActivity(existing.activity, activity) : activity,
    });
    for (const k of neededKeys) {
      if (visited.has(k)) continue;
      visited.add(k);
      queue.push(k);
    }
  }
  return { prefixes, nodes, workflowName };
}

/** Required-check name prefixes only (thin wrapper over deriveCiGraph). */
export function derivePrefixes(ciYamlText: string, rollupJobId = 'ci'): string[] | null {
  return deriveCiGraph(ciYamlText, rollupJobId)?.prefixes ?? null;
}
