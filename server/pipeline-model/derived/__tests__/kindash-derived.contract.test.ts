// server/pipeline-model/derived/__tests__/kindash-derived.contract.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { deriveStaticGraph, gatingClosure } from '../..';
import { derivedModelForRepo } from '../from-history';

function wf(name: string): string | null {
  try {
    const env = { ...process.env }; delete env.GITHUB_TOKEN; delete env.GH_TOKEN;
    const b64 = execFileSync('gh', ['api', `repos/cairnea/KinDash/contents/.github/workflows/${name}`, '--jq', '.content'], { env, encoding: 'utf8' });
    return Buffer.from(b64.trim(), 'base64').toString('utf8');
  } catch { return null; }
}
const reusableRefs = (ci: string) => [...new Set([...ci.matchAll(/uses:\s*\.\/\.github\/workflows\/(_[a-z0-9-]+\.yml)/gi)].map((m) => m[1]!))];

describe('KinDash DerivedModel (assembly integration)', () => {
  it('assembles a coherent matrix: build: production gates at Queue, advisory/absent cells are sane', () => {
    const ci = wf('ci.yml');
    if (ci == null) { console.warn('skipped — gh/ci.yml unreachable'); return; }
    const files: Record<string, string> = { 'ci.yml': ci };
    for (const n of reusableRefs(ci)) { const t = wf(n); if (t) files[n] = t; }
    // A partial fetch (ci.yml ok but a reusable throttled under parallel load)
    // yields an incomplete graph — can't assert, skip.
    if (reusableRefs(ci).some((n) => !(n in files))) { console.warn('skipped — partial workflow fetch'); return; }

    const graph = deriveStaticGraph(files);
    // KinDash's known conditionally-required callers: skipped==pass.
    // pr-affected-tests runs only the affected test slice on PRs;
    // integration-tests runs only when the diff touches backend.
    const gating = gatingClosure(graph, 'ci', {
      conditionalCallerJobs: ['pr-affected-tests', 'integration-tests'],
    });
    // No history needed for the static half — inject empty stat maps.
    const model = derivedModelForRepo({
      repo: 'cairnea/KinDash', since: '1970-01-01T00:00:00Z', graph, gating,
      successStatsByRepo: () => new Map(), flakeStatsByRepo: () => new Map(),
    });

    expect(model.tiers.map((t) => t.id)).toEqual(['pr', 'queue', 'main', 'nightly']);
    expect(model.checks.length).toBeGreaterThan(0);
    expect(model.cells.length).toBe(model.checks.length * model.tiers.length);

    // build: production must be a gate at Queue.
    const build = model.cells.find((c) => /build: production/i.test(c.check) && c.tierId === 'queue');
    expect(build?.state).toBe('gate');

    // Every cell's state is one of the four; no cell both gates and is absent.
    for (const c of model.cells) {
      expect(['gate', 'advisory', 'conditional', 'absent']).toContain(c.state);
      if (c.state === 'absent') expect(c.intent.runs).toBe(false);
    }
    // With empty history, no cell can have observed facts.
    expect(model.cells.every((c) => c.observed === null)).toBe(true);

    // At least one cell must be 'conditional' — the checks from pr-affected-tests
    // and integration-tests are conditionally-required (skipped==pass) and must
    // surface as conditional rather than gate/advisory.
    const conditionalCells = model.cells.filter((c) => c.state === 'conditional');
    expect(conditionalCells.length).toBeGreaterThan(0);
  });
});
