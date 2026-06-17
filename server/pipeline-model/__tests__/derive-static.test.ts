// server/pipeline-model/__tests__/derive-static.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveStaticGraph } from '../derive-static';

const fx = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const files = () => ({ 'ci.yml': fx('ci.yml'), '_static.yml': fx('_static.yml') });

describe('deriveStaticGraph', () => {
  it('expands a reusable workflow into one CheckNode per callee leaf (matrix expanded)', () => {
    const g = deriveStaticGraph(files());
    const names = g.checks.map((c) => c.checkName).sort();
    expect(names).toContain('static-checks / types: tsc');
    expect(names).toContain('static-checks / test: unit (1/3)');
    expect(names).toContain('static-checks / test: unit (3/3)');
    // plain (non-uses) jobs surface under their own name
    expect(names).toContain('build: production');
    expect(names).toContain('heavy: full');
  });

  it('records the provenance path caller→callee for reusable leaves', () => {
    const g = deriveStaticGraph(files());
    const unit1 = g.checks.find((c) => c.checkName === 'static-checks / test: unit (1/3)')!;
    expect(unit1.provenance).toEqual([
      { file: 'ci.yml', jobId: 'static-checks' },
      { file: '_static.yml', jobId: 'unit', matrixCoord: { shard: 1 } },
    ]);
    const build = g.checks.find((c) => c.checkName === 'build: production')!;
    expect(build.provenance).toEqual([{ file: 'ci.yml', jobId: 'build' }]);
  });

  it('narrows triggers by the caller if: (skip-aware)', () => {
    const g = deriveStaticGraph(files());
    const heavy = g.checks.find((c) => c.checkName === 'heavy: full')!;
    expect(heavy.triggers.events).toEqual([{ kind: 'merge_group' }]); // not pull_request
    const tsc = g.checks.find((c) => c.checkName === 'static-checks / types: tsc')!;
    expect(tsc.triggers.events.map((e) => e.kind)).toEqual(['pull_request', 'merge_group']);
  });

  it('exposes caller-level needs for the closure step', () => {
    const g = deriveStaticGraph(files());
    expect(g.callerNeeds['build']).toEqual(['static-checks']);
    expect(g.callerNeeds['static-checks']).toEqual([]);
  });

  it('an unresolved uses: (callee file missing) yields one low-confidence opaque node', () => {
    const g = deriveStaticGraph({ 'ci.yml': `on:\n  pull_request:\njobs:\n  x:\n    uses: ./.github/workflows/_missing.yml` });
    const x = g.checks.find((c) => c.checkName === 'x')!;
    expect(x.confidence).toBe('low');
    expect(x.provenance).toEqual([{ file: 'ci.yml', jobId: 'x' }]);
  });

  // Fix #1: callee leaf that itself has uses: (nested reusable workflow) → confidence:'low'
  it('a callee leaf with uses: (nested reusable workflow) is marked low-confidence', () => {
    const deepCallee = `
on:
  workflow_call:
jobs:
  nested-leaf:
    uses: ./.github/workflows/_deep.yml
`;
    const callee = `
on:
  workflow_call:
jobs:
  leaf-with-uses:
    uses: ./.github/workflows/_deep-callee.yml
    name: "nested leaf"
`;
    const rollup = `
on:
  pull_request:
jobs:
  caller:
    uses: ./.github/workflows/_callee.yml
`;
    const g = deriveStaticGraph({
      'ci.yml': rollup,
      '_callee.yml': callee,
      '_deep-callee.yml': deepCallee,
    });
    const node = g.checks.find((c) => c.checkName === 'caller / nested leaf')!;
    expect(node).toBeDefined();
    expect(node.confidence).toBe('low');
  });

  // Fix #2: uses: caller that also carries strategy.matrix → all emitted nodes low-confidence
  it('a uses: caller with its own strategy.matrix emits low-confidence nodes', () => {
    const callee = `
on:
  workflow_call:
jobs:
  leaf-job:
    name: "leaf"
    runs-on: ubuntu-latest
`;
    const rollup = `
on:
  pull_request:
jobs:
  caller:
    uses: ./.github/workflows/_callee.yml
    strategy:
      matrix:
        env: [qa, prod]
`;
    const g = deriveStaticGraph({ 'ci.yml': rollup, '_callee.yml': callee });
    const nodes = g.checks.filter((c) => c.callerJobId === 'caller');
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.confidence).toBe('low');
    }
  });

  // Fix #3: repeated values in a matrix dimension must produce distinct suffixes (no collision)
  it('duplicate values in a matrix dim produce distinct (1/3),(2/3),(3/3) suffixes', () => {
    const rollup = `
on:
  pull_request:
jobs:
  sharded:
    name: "test: unit"
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 1, 2]
`;
    const g = deriveStaticGraph({ 'ci.yml': rollup });
    const names = g.checks.filter((c) => c.callerJobId === 'sharded').map((c) => c.checkName);
    expect(names).toHaveLength(3);
    expect(names).toContain('test: unit (1/3)');
    expect(names).toContain('test: unit (2/3)');
    expect(names).toContain('test: unit (3/3)');
    // all three must be distinct (no collision)
    expect(new Set(names).size).toBe(3);
  });
});
