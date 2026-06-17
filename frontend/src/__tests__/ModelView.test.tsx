import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ModelView, requiredGates, driftCells } from '../sections/model/ModelView';
import type { WorkspaceApi } from '../shell/workspaceApi';
import type { DerivedModelLike } from '../sections/optimize/types';

const cell = (check: string, tierId: string, state: string, drift = false): DerivedModelLike['cells'][number] =>
  ({ check, tierId, intent: { runs: state !== 'absent', gates: state === 'gate', conditional: false }, observed: null, state, drift });

const MODEL: DerivedModelLike = {
  tiers: [{ id: 'pr', label: 'PR', event: 'pull_request' }, { id: 'queue', label: 'Queue', event: 'merge_group' }],
  checks: ['build', 'lint'],
  cells: [
    cell('build', 'pr', 'advisory'), cell('build', 'queue', 'gate'),
    cell('lint', 'pr', 'advisory'), cell('lint', 'queue', 'absent', true),
  ],
  checkMeta: [
    { check: 'build', isRequiredMergeGate: true, provenance: [{ file: 'ci.yml', jobId: 'build' }] },
    { check: 'lint', isRequiredMergeGate: false, provenance: [{ file: 'ci.yml', jobId: 'lint' }] },
  ],
};

const api = (over: Partial<WorkspaceApi> = {}): WorkspaceApi => ({
  getPipeline: vi.fn(async () => ({ repo: 'o/r', sourceSha: 'deadbeefcafe', model: MODEL })),
  security: vi.fn(async () => ({ repo: 'o/r', sourceSha: 'deadbeefcafe', scannedFiles: 1, findings: [] })),
  ruleset: vi.fn(async () => ({ readable: true, derivedRequired: ['build'], liveRequired: ['build'], missingFromModel: [], extraInModel: [], inSync: true })),
  simulate: vi.fn(), prompt: vi.fn(), draftPrDryRun: vi.fn(), draftPrOpen: vi.fn(), self: vi.fn(), ...over,
} as unknown as WorkspaceApi);

describe('requiredGates / driftCells (pure)', () => {
  it('extracts the required-gate set', () => expect(requiredGates(MODEL)).toEqual(['build']));
  it('finds drifting cells', () => expect(driftCells(MODEL)).toHaveLength(1));
});

describe('ModelView (US3)', () => {
  it('shows the merge contract + the pinned sha', async () => {
    render(<ModelView repo="o/r" api={api()} />);
    expect(await screen.findByText(/Merge contract:/)).toBeInTheDocument();
    expect(screen.getByText(/1 required gate — build/)).toBeInTheDocument();
    expect(screen.getByText(/@deadbee/)).toBeInTheDocument();
  });

  it('renders the matrix and flags drift', async () => {
    render(<ModelView repo="o/r" api={api()} />);
    expect(await screen.findByLabelText('Protection matrix')).toBeInTheDocument();
    expect(screen.getByText(/1 cell drifting/)).toBeInTheDocument();
  });

  it('renders the security panel (Group M) with finding + confidence', async () => {
    const withFindings = api({ security: vi.fn(async () => ({ repo: 'o/r', sourceSha: 's', scannedFiles: 1,
      findings: [{ file: 'ci.yml', kind: 'pull_request_target', detail: 'runs on fork PRs', confidence: 'high' as const }] })) });
    render(<ModelView repo="o/r" api={withFindings} />);
    const panel = await screen.findByLabelText('Security findings');
    expect(within(panel).getByText('pull_request_target')).toBeInTheDocument();
    expect(within(panel).getByText('[high]')).toBeInTheDocument();
  });

  it('shows a ruleset mismatch (the dangerous gap — ruleset requires a check config misses)', async () => {
    const mismatch = api({ ruleset: vi.fn(async () => ({ readable: true, derivedRequired: ['build'], liveRequired: ['build', 'security-scan'], missingFromModel: ['security-scan'], extraInModel: [], inSync: false })) });
    render(<ModelView repo="o/r" api={mismatch} />);
    expect(await screen.findByText(/Ruleset mismatch/)).toHaveTextContent(/requires security-scan not enforced by config/);
  });

  it('shows "grant administration:read" when the ruleset is unreadable (no false in-sync)', async () => {
    const unreadable = api({ ruleset: vi.fn(async () => ({ readable: false, derivedRequired: ['build'], liveRequired: [], missingFromModel: [], extraInModel: [], inSync: false })) });
    render(<ModelView repo="o/r" api={unreadable} />);
    expect(await screen.findByText(/grant administration:read/)).toBeInTheDocument();
  });

  it('still renders the model when the security audit fails (advisory, non-blocking)', async () => {
    const secFails = api({ security: vi.fn(async () => { throw new Error('administration:read missing'); }) });
    render(<ModelView repo="o/r" api={secFails} />);
    expect(await screen.findByLabelText('Protection matrix')).toBeInTheDocument(); // model still renders
  });

  it('surfaces a derivation error', async () => {
    render(<ModelView repo="o/r" api={api({ getPipeline: vi.fn(async () => { throw new Error('no derivable model'); }) })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no derivable model');
  });
});
