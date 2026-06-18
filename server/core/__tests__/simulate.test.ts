import { describe, it, expect } from 'vitest';
import { simulateTierMove, simulatePlan, perRunMinutes } from '../model/simulate';
import type { DerivedModel } from '../../pipeline-model/derived';

const obs = (runs: number, minutes: number) => ({ ran: runs > 0, runs, realFailures: 0, failRatePct: 0, flakeRatePct: 0, minutes });
const cell = (check: string, tierId: string, runs: boolean, gates: boolean, o: ReturnType<typeof obs> | null, state: string) =>
  ({ check, tierId, intent: { runs, gates, conditional: false }, observed: o, drift: false, state }) as DerivedModel['cells'][number];

const MODEL: DerivedModel = {
  tiers: [
    { id: 'pr', label: 'PR', event: 'pull_request' },
    { id: 'queue', label: 'Queue', event: 'merge_group' },
    { id: 'main', label: 'Main', event: 'push' },
  ],
  checks: ['build', 'lint'],
  cells: [
    cell('build', 'pr', true, false, obs(300, 600), 'advisory'),
    cell('build', 'queue', true, true, obs(100, 200), 'gate'),
    cell('build', 'main', false, false, null, 'absent'),
    cell('lint', 'pr', true, false, obs(300, 600), 'advisory'),
    cell('lint', 'queue', false, false, null, 'absent'),
    cell('lint', 'main', false, false, null, 'absent'),
  ],
  checkMeta: [
    { check: 'build', triggers: ['pull_request', 'merge_group'], provenance: [{ file: 'ci.yml', jobId: 'build' }], confidence: 'high', isRequiredMergeGate: true },
    { check: 'lint', triggers: ['pull_request', 'merge_group'], provenance: [{ file: 'ci.yml', jobId: 'lint' }], confidence: 'high', isRequiredMergeGate: false },
  ],
};

describe('simulateTierMove (server-side, FR-011/FR-012)', () => {
  it('pools per-run minutes across tiers', () => {
    expect(perRunMinutes(MODEL, 'lint')).toBe(2); // 600/300
  });

  it('removing lint from PR saves its observed minutes (legal — not a gate)', () => {
    const r = simulateTierMove(MODEL, { check: 'lint', fromTierId: 'pr', toTierId: null });
    expect(r.legal).toBe(true);
    expect(r.direction).toBe('remove');
    expect(r.costDeltaMinutes).toBe(-600);
    expect(r.note).toMatch(/saves 600 min/);
  });

  it('reports a best-case PR-latency delta when a check leaves the PR tier (roadmap 4.2)', () => {
    const r = simulateTierMove(MODEL, { check: 'lint', fromTierId: 'pr', toTierId: null });
    expect(r.latencyDeltaSeconds).toBe(-120); // 2 min/run off the PR critical path
    expect(r.note).toMatch(/~2m faster PR/);
  });

  it('binds to the legality validator: refuses removing the required build gate from the queue', () => {
    const r = simulateTierMove(MODEL, { check: 'build', fromTierId: 'queue', toTierId: null });
    expect(r.legal).toBe(false);
    expect(r.reason).toBe('required-gate');
    expect(r.note).toMatch(/not possible/);
  });

  it('honors the union required set (live ruleset requires lint → its removal refused)', () => {
    const r = simulateTierMove(MODEL, { check: 'lint', fromTierId: 'pr', toTierId: null }, ['lint']);
    expect(r.legal).toBe(false);
    expect(r.reason).toBe('required-gate');
  });

  it('moving to an unobserved tier estimates the add-side and flags estimated', () => {
    // lint PR(600) → main: no main history → estimate perRun(2) × main cadence(0 here) = 0; remove 600 → -600 est
    const r = simulateTierMove(MODEL, { check: 'lint', fromTierId: 'pr', toTierId: 'main' });
    expect(r.estimated).toBe(true);
    expect(r.direction).toBe('demote');
  });
});

describe('simulatePlan (N2/FR-042 — composite legality)', () => {
  it('sums cost and is legal when moves are jointly safe', () => {
    const p = simulatePlan(MODEL, [{ check: 'lint', fromTierId: 'pr', toTierId: null }]);
    expect(p.legal).toBe(true);
    expect(p.combinedCostDeltaMinutes).toBe(-600);
  });

  it('rejects the plan if any single move is illegal (required gate)', () => {
    const p = simulatePlan(MODEL, [{ check: 'build', fromTierId: 'queue', toTierId: null }]);
    expect(p.legal).toBe(false);
    expect(p.reason).toMatch(/build/);
  });

  it('catches an EMERGENT strand: two individually-legal moves that jointly remove a required check everywhere', () => {
    // a model where required check `dup` runs at BOTH pr and queue (gate at queue)
    const m = {
      tiers: MODEL.tiers,
      checks: ['dup'],
      cells: [
        cell('dup', 'pr', true, false, obs(50, 100), 'advisory'),
        cell('dup', 'queue', true, false, obs(50, 100), 'advisory'), // NOT the merge gate here
        cell('dup', 'main', false, false, null, 'absent'),
      ],
      checkMeta: [{ check: 'dup', triggers: [], provenance: [{ file: 'ci.yml', jobId: 'dup' }], confidence: 'high', isRequiredMergeGate: true }],
    } as typeof MODEL;
    // each move alone leaves dup running at the other tier (legal); together → nowhere
    const p = simulatePlan(m, [
      { check: 'dup', fromTierId: 'pr', toTierId: null },
      { check: 'dup', fromTierId: 'queue', toTierId: null },
    ]);
    expect(p.legal).toBe(false);
    expect(p.reason).toMatch(/strands required gate "dup"/);
  });
});
