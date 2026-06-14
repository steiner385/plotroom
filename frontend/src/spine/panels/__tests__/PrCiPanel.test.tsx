import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrCiPanel } from '../PrCiPanel';
import type { DashboardState } from '../../../types';

const pr = (number: number, substate: string | null) => ({
  repo: 'acme/widgets', number, title: `pr ${number}`, url: 'u',
  stage: { stage: 'ci', substate, percent: null, etaSeconds: null, etaRangeSeconds: null, overdue: false },
  queueAheadCount: null, checks: [],
});
const repos = (prs: object[]) =>
  [{ repo: 'acme/widgets', hasDeploy: false, prs, queue: null }] as unknown as DashboardState['repos'];

describe('PrCiPanel', () => {
  it('lists PRs in CI, failed ones first, and shows an empty note when none are in CI', () => {
    const { rerender } = render(<PrCiPanel repos={repos([pr(1, null), pr(2, 'ci-failed')])} />);
    const rows = screen.getAllByTestId(/spine-prci-row-/);
    expect(rows[0]).toHaveAttribute('data-testid', 'spine-prci-row-2'); // failed first
    expect(rows.map((r) => r.getAttribute('data-testid'))).toContain('spine-prci-row-1');

    rerender(<PrCiPanel repos={repos([])} />);
    expect(screen.getByText(/no PRs in CI/i)).toBeInTheDocument();
  });
});
