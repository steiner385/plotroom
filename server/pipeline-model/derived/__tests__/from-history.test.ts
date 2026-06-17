import { describe, it, expect } from 'vitest';
import { derivedModelForRepo } from '../from-history';
import type { StaticGraph, GatingResult } from '../../types';
import type { SuccessStat, FlakeStat } from '../../../history';

const ev = (...k: string[]) => ({ events: k.map((kind) => ({ kind })) }) as never;
const graph: StaticGraph = {
  rollupFile: 'ci.yml', callerNeeds: { build: [], ci: ['build'] },
  checks: [{ checkName: 'build: production', callerJobId: 'build', triggers: ev('merge_group'), provenance: [], confidence: 'high' }],
};
const gating: GatingResult = { gatingCallerJobs: ['build'], conditionalCallerJobs: [], gates: [{ checkName: 'build: production', events: ['merge_group'] }] };

describe('derivedModelForRepo', () => {
  it('reads observed stats for the repo and assembles the model', () => {
    const success: SuccessStat[] = [{ name: 'build: production', event: 'merge_group', totalRuns: 300, failingRuns: 0, sumDurationSecs: 90_000 }];
    const flake: FlakeStat[] = [];
    const model = derivedModelForRepo({
      repo: 'cairnea/KinDash', since: '2026-06-01T00:00:00Z', graph, gating,
      successStatsByRepo: () => new Map([['cairnea/KinDash', success]]),
      flakeStatsByRepo: () => new Map([['cairnea/KinDash', flake]]),
    });
    const queue = model.cells.find((c) => c.check === 'build: production' && c.tierId === 'queue')!;
    expect(queue.state).toBe('gate');
    expect(queue.observed).toMatchObject({ runs: 300, minutes: 1500 });
  });

  it('handles a repo with no observed stats (empty maps) without throwing', () => {
    const model = derivedModelForRepo({
      repo: 'x/y', since: 's', graph, gating,
      successStatsByRepo: () => new Map(), flakeStatsByRepo: () => new Map(),
    });
    expect(model.cells.find((c) => c.tierId === 'queue')!.observed).toBeNull();
  });
});
