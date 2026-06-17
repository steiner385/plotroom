import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ProtectionMap, type DerivedModel } from '../ProtectionMap';

const MODEL: DerivedModel = {
  tiers: [
    { id: 'pr', label: 'PR', event: 'pull_request' },
    { id: 'queue', label: 'Queue', event: 'merge_group' },
  ],
  checks: ['build: production', 'a11y: axe'],
  cells: [
    { check: 'build: production', tierId: 'pr', intent: { runs: true, gates: true, conditional: false },
      observed: null, drift: true, state: 'gate' },
    { check: 'build: production', tierId: 'queue', intent: { runs: true, gates: true, conditional: false },
      observed: { ran: true, runs: 200, realFailures: 0, failRatePct: 0, flakeRatePct: 0, minutes: 1000 }, drift: false, state: 'gate' },
    { check: 'a11y: axe', tierId: 'pr', intent: { runs: true, gates: false, conditional: true },
      observed: null, drift: false, state: 'conditional' },
    { check: 'a11y: axe', tierId: 'queue', intent: { runs: false, gates: false, conditional: false },
      observed: null, drift: false, state: 'absent' },
  ],
};

function mockFetch(model: DerivedModel | { error: string }, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/repos')) {
      return { ok: true, json: async () => [{ repo: 'cairnea/KinDash', excluded: false }] } as Response;
    }
    return { ok: status === 200, status, json: async () => model } as Response;
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('ProtectionMap', () => {
  it('renders the matrix with state-coded cells and a summary', async () => {
    mockFetch(MODEL);
    render(<ProtectionMap />);
    await screen.findByTestId('pm-grid');
    // build: production gates at both PR and Queue
    expect(screen.getByTestId('pm-cell-build: production-queue')).toHaveAttribute('data-state', 'gate');
    // a11y is conditional at PR, absent at Queue
    expect(screen.getByTestId('pm-cell-a11y: axe-pr')).toHaveAttribute('data-state', 'conditional');
    expect(screen.getByTestId('pm-cell-a11y: axe-queue')).toHaveAttribute('data-state', 'absent');
    // summary chips
    expect(screen.getByTestId('pm-summary').textContent).toMatch(/2 checks × 2 tiers/);
    expect(screen.getByText('2 gate')).toBeInTheDocument();
    expect(screen.getByText('1 conditional')).toBeInTheDocument();
  });

  it('marks drift cells', async () => {
    mockFetch(MODEL);
    render(<ProtectionMap />);
    await screen.findByTestId('pm-grid');
    expect(screen.getByTestId('pm-cell-build: production-pr')).toHaveAttribute('data-drift', '1');
    expect(screen.getByTestId('pm-cell-build: production-queue')).toHaveAttribute('data-drift', '0');
    expect(screen.getByText('1 drift')).toBeInTheDocument();
  });

  it('shows an error when the map cannot be derived', async () => {
    mockFetch({ error: 'no derivable ci.yml for x/y' }, 404);
    render(<ProtectionMap />);
    expect((await screen.findByTestId('pm-error')).textContent).toMatch(/no derivable ci.yml/);
  });
});
