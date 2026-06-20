import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { WorkspaceApi } from '../shell/workspaceApi';

// MetricsView is heavy (fetches /api/metrics); stub it — we test the composition.
vi.mock('../MetricsView', () => ({ MetricsView: () => <div data-testid="metrics">METRICS</div> }));

import { InsightsView } from '../sections/insights/InsightsView';

const api = (over: Partial<WorkspaceApi> = {}): WorkspaceApi => ({
  budgets: vi.fn(async () => ({ gauges: [], alerts: [] })),
  policy: vi.fn(async () => ({ rules: [], violations: [] })),
  outcomes: vi.fn(async () => ({ outcomes: [], accuracy: { count: 0, meanCostAccuracy: 0, directionHitRate: 0, recommenderUsable: false } })),
  changelog: vi.fn(async () => ({ changelog: [], audit: [] })),
  ...over,
} as unknown as WorkspaceApi);

describe('InsightsView (WS3a — Metrics + Tune folded into one section)', () => {
  it('renders the analytics (Metrics) and the tuning panels (budgets etc.) together', async () => {
    render(<InsightsView repo="o/r" api={api()} />);
    // MetricsView is lazy-loaded; use findBy to wait for the Suspense boundary to resolve.
    expect(await screen.findByTestId('metrics')).toBeInTheDocument();
    // the Tune panels are present (with their empty states)
    expect(await screen.findByLabelText('Budgets')).toBeInTheDocument();
    expect(screen.getByLabelText('Policy')).toBeInTheDocument();
  });

  it('exposes Analytics + Tuning & Policy tabs and toggles the panels (#184)', async () => {
    render(<InsightsView repo="o/r" api={api()} />);
    await screen.findByTestId('metrics');
    const analyticsTab = screen.getByRole('tab', { name: 'Analytics' });
    const tuningTab = screen.getByRole('tab', { name: /Tuning & Policy/ });
    // default → Analytics active, Tuning hidden
    expect(analyticsTab).toHaveAttribute('aria-selected', 'true');
    expect(document.getElementById('insights-panel-analytics')).not.toHaveAttribute('hidden');
    expect(document.getElementById('insights-panel-tuning')).toHaveAttribute('hidden');
    // switch → Tuning active, Analytics hidden
    fireEvent.click(tuningTab);
    expect(tuningTab).toHaveAttribute('aria-selected', 'true');
    expect(document.getElementById('insights-panel-tuning')).not.toHaveAttribute('hidden');
    expect(document.getElementById('insights-panel-analytics')).toHaveAttribute('hidden');
  });

  it('no longer renders the stale "Tune & Investigate" heading (#184)', async () => {
    render(<InsightsView repo="o/r" api={api()} />);
    await screen.findByTestId('metrics');
    expect(screen.queryByRole('heading', { name: /Tune & Investigate/ })).toBeNull();
  });
});
