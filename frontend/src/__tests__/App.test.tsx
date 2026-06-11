import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { App } from '../App';
import { useDashboard } from '../useDashboard';
import type { DashboardHook } from '../useDashboard';
import type { DashboardState, PrView } from '../types';

vi.mock('../useDashboard');
const mockUseDashboard = vi.mocked(useDashboard);

const prView = (number: number): PrView => ({
  repo: 'x', number, title: `pr ${number}`, url: `https://x/${number}`,
  stage: { stage: 'ci', substate: null, percent: 10, etaSeconds: null, etaRangeSeconds: null, overdue: false },
  queueAheadCount: null,
  checks: [], groupChecks: null,
});

const STATE: DashboardState = {
  generatedAt: '2026-06-10T12:00:00Z', staleSince: null,
  repos: [
    { repo: 'acme/widgets', hasDeploy: true, accuracy: {}, prs: [prView(1)], queue: null },
    { repo: 'octo/bridge', hasDeploy: false, accuracy: {}, prs: [prView(2)], queue: null },
  ],
};

const hook = (overrides?: Partial<DashboardHook>): DashboardHook =>
  ({ state: STATE, connected: true, ...overrides });

beforeEach(() => {
  mockUseDashboard.mockReturnValue(hook());
});

describe('App', () => {
  it('uses the server-provided hasDeploy per repo group (5-node vs 3-node track)', () => {
    render(<App />);
    const tracks = screen.getAllByLabelText(/stage \d+ of \d+/);
    // deploy repo renders the 5-stage track (CI/Queue/Merged/QA/Prod), non-deploy the 3-stage one
    expect(tracks[0]).toHaveAttribute('aria-label', 'stage 1 of 5');
    expect(tracks[1]).toHaveAttribute('aria-label', 'stage 1 of 3');
  });

  it('renders a loading state until the first SSE frame', () => {
    mockUseDashboard.mockReturnValue(hook({ state: null }));
    render(<App />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders disconnected badge when connected=false', () => {
    mockUseDashboard.mockReturnValue(hook({ connected: false }));
    render(<App />);
    expect(screen.getByText('disconnected — retrying…')).toBeInTheDocument();
    const badge = screen.getByText('disconnected — retrying…');
    expect(badge.className).toContain('stale');
  });

  it('does not render disconnected badge when connected=true', () => {
    render(<App />);
    expect(screen.queryByText('disconnected — retrying…')).not.toBeInTheDocument();
  });

  it('shows the "live · updated" stamp while connected', () => {
    render(<App />);
    expect(screen.getByText(/^live · updated /)).toBeInTheDocument();
  });

  it('hides the updated stamp while disconnected (badge covers the state)', () => {
    mockUseDashboard.mockReturnValue(hook({ connected: false }));
    render(<App />);
    expect(screen.queryByText(/updated /)).not.toBeInTheDocument();
    expect(screen.getByText('disconnected — retrying…')).toBeInTheDocument();
  });

  it('passes per-repo accuracy down to PR rows (visible in expanded panel)', () => {
    const withChecks: PrView = { ...prView(1), checks: [
      { name: 'fast-checks / ESLint', status: 'IN_PROGRESS', conclusion: null, isRequired: true, workflowName: null,
        elapsedSeconds: 60, expectedSeconds: 180, url: null,
        waitKind: null, blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null },
    ] };
    mockUseDashboard.mockReturnValue(hook({ state: { ...STATE, repos: [
      { repo: 'acme/widgets', hasDeploy: true,
        accuracy: { ci: { medianAbsErrSecs: 90, n: 7 } }, prs: [withChecks], queue: null },
    ] } }));
    render(<App />);
    fireEvent.click(screen.getByText('#1'));
    expect(screen.getByText('ETA accuracy (ci): typically ±2m (n=7)')).toBeInTheDocument();
  });

  it('StatusStrip filter hides non-matching rows and shows (n hidden) in section header', () => {
    // repo1: 1 ci PR; repo2: 1 ci PR — filter by "running" (ci): all visible, no hidden
    render(<App />);
    const strip = screen.getByRole('group', { name: 'Status overview' });
    const runningTile = within(strip).getAllByRole('button')[0]!; // first tile = running
    fireEvent.click(runningTile);
    // both repos have ci PRs so nothing is hidden
    expect(screen.queryByText(/hidden/)).not.toBeInTheDocument();
  });

  it('StatusStrip filter collapses repos with zero matching PRs to show (n hidden)', () => {
    const ciPr: PrView = { ...prView(10), stage: { stage: 'ci', substate: null, percent: null,
      etaSeconds: null, etaRangeSeconds: null, overdue: false } };
    const queuePr: PrView = { ...prView(20), stage: { stage: 'queue', substate: null, percent: null,
      etaSeconds: null, etaRangeSeconds: null, overdue: false } };
    // repo1 has only a ci PR; repo2 has only a queue PR
    mockUseDashboard.mockReturnValue(hook({ state: { ...STATE, repos: [
      { repo: 'acme/widgets', hasDeploy: true, accuracy: {}, prs: [ciPr], queue: null },
      { repo: 'octo/bridge', hasDeploy: false, accuracy: {}, prs: [queuePr], queue: null },
    ] } }));
    render(<App />);
    const strip = screen.getByRole('group', { name: 'Status overview' });
    const runningTile = within(strip).getAllByRole('button')[0]!; // first tile = running
    fireEvent.click(runningTile);
    // repo2 has a queue PR, not ci → (1 hidden) shown for that repo
    expect(screen.getByText(/\(1 hidden\)/)).toBeInTheDocument();
    // repo1's ci PR should still be visible
    expect(screen.getByText('#10')).toBeInTheDocument();
    // repo2's queue PR should be hidden
    expect(screen.queryByText('#20')).not.toBeInTheDocument();
  });

  it('clicking active tile again clears the filter', () => {
    const queuePr: PrView = { ...prView(20), stage: { stage: 'queue', substate: null, percent: null,
      etaSeconds: null, etaRangeSeconds: null, overdue: false } };
    mockUseDashboard.mockReturnValue(hook({ state: { ...STATE, repos: [
      { repo: 'acme/widgets', hasDeploy: true, accuracy: {}, prs: [prView(1), queuePr], queue: null },
    ] } }));
    render(<App />);
    const strip = screen.getByRole('group', { name: 'Status overview' });
    const runningTile = within(strip).getAllByRole('button')[0]!; // first tile = running
    // filter to running
    fireEvent.click(runningTile);
    expect(screen.queryByText('#20')).not.toBeInTheDocument();
    // click running again to clear
    fireEvent.click(runningTile);
    expect(screen.getByText('#20')).toBeInTheDocument();
  });
});
