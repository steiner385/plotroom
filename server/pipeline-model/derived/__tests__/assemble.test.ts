// server/pipeline-model/derived/__tests__/assemble.test.ts
import { describe, it, expect } from 'vitest';
import { assembleDerivedModel } from '../assemble';
import { KINDASH_TIERS } from '../tiers';
import { observedKey, type ObservedCell } from '../observed';
import type { StaticGraph, GatingResult } from '../../types';

const ev = (...kinds: string[]) => ({ events: kinds.map((kind) => ({ kind })) }) as never;

const graph: StaticGraph = {
  rollupFile: 'ci.yml',
  callerNeeds: { 'static-checks': [], build: ['static-checks'], ci: ['build'] },
  checks: [
    // build: production runs on PR + Queue, gates both
    { checkName: 'build: production', callerJobId: 'build', triggers: ev('pull_request', 'merge_group'), provenance: [], confidence: 'high' },
    // a queue-only gate
    { checkName: 'static-checks / test: unit', callerJobId: 'static-checks', triggers: ev('merge_group'), provenance: [], confidence: 'high' },
    // an advisory PR-only check (low confidence → conditional)
    { checkName: 'a11y: axe', callerJobId: 'a11y', triggers: ev('pull_request'), provenance: [], confidence: 'low' },
  ],
};
const gating: GatingResult = {
  gatingCallerJobs: ['build', 'static-checks'],
  conditionalCallerJobs: [],
  gates: [
    { checkName: 'build: production', events: ['merge_group', 'pull_request'] },
    { checkName: 'static-checks / test: unit', events: ['merge_group'] },
  ],
};

describe('assembleDerivedModel', () => {
  const observed = new Map<string, ObservedCell>([
    [observedKey('build: production', 'merge_group'), { ran: true, runs: 200, realFailures: 0, failRatePct: 0, flakeRatePct: 0, minutes: 1000 }],
  ]);
  const model = assembleDerivedModel(graph, gating, observed, KINDASH_TIERS);
  const cell = (check: string, tierId: string) => model.cells.find((c) => c.check === check && c.tierId === tierId)!;

  it('has one cell per (check, tier)', () => {
    expect(model.checks.length).toBe(3);
    expect(model.cells.length).toBe(3 * KINDASH_TIERS.length);
  });
  it('build: production is a gate at PR and Queue, absent at Main/Nightly', () => {
    expect(cell('build: production', 'pr').state).toBe('gate');
    expect(cell('build: production', 'queue').state).toBe('gate');
    expect(cell('build: production', 'main').state).toBe('absent');
  });
  it('a low-confidence check renders conditional where it runs', () => {
    expect(cell('a11y: axe', 'pr').state).toBe('conditional');
    expect(cell('a11y: axe', 'queue').state).toBe('absent');
  });
  it('attaches observed facts where present and null elsewhere', () => {
    expect(cell('build: production', 'queue').observed).toMatchObject({ runs: 200 });
    expect(cell('build: production', 'pr').observed).toBeNull();
  });
  it('flags drift: build gates at PR (configured) but has no PR history while active at Queue', () => {
    expect(cell('build: production', 'pr').drift).toBe(true);
    expect(cell('build: production', 'queue').drift).toBe(false);
  });
});
