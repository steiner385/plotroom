import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MetricsView } from '../MetricsView';
import type { MetricsPayload } from '../types';

const EMPTY: MetricsPayload = {
  windowDays: 14, runnerWaits: [], queue: [], slowestJobs: [], velocity: [], trends: [],
};

const PAYLOAD: MetricsPayload = {
  windowDays: 14,
  runnerWaits: [
    { repo: 'acme/widgets', event: 'pull_request', days: [
      { date: '2026-06-09', p50: 30, p90: 60, n: 4 },
      { date: '2026-06-10', p50: 45, p90: 240, n: 6 },
    ] },
    { repo: 'acme/widgets', event: 'merge_group', days: [
      { date: '2026-06-10', p50: 120, p90: 300, n: 2 },
    ] },
  ],
  queue: [
    { repo: 'acme/widgets',
      mergesPerDay: [{ date: '2026-06-09', count: 3 }, { date: '2026-06-10', count: 5 }],
      queueWaitDays: [{ date: '2026-06-10', p50: 480, n: 5 }],
      groupRunDays: [{ date: '2026-06-10', p50: 900, n: 5 }] },
  ],
  slowestJobs: [
    { repo: 'acme/widgets', jobs: [
      { name: 'Integration Tests', event: 'merge_group', p50: 1200, p90: 1500,
        variability: 1.25, n: 14, trend: [{ date: '2026-06-10', p50: 1200 }] },
      { name: 'flaky-suite', event: 'pull_request', p50: 300, p90: 1200,
        variability: 4, n: 9, trend: [{ date: '2026-06-10', p50: 300 }] },
    ] },
  ],
  velocity: [
    { repo: 'acme/widgets',
      mergedPerDay: [{ date: '2026-06-10', count: 5 }],
      mergeToQaDays: [{ date: '2026-06-10', p50: 600, n: 5 }],
      avgLifespanDays: [{ date: '2026-06-10', meanHours: 26, n: 4 }] },
  ],
  trends: [
    { repo: 'acme/widgets', samples: [
      { at: '2026-06-10T10:00:00Z', open: 12, ci: 3, queue: 2, failed: 1 },
      { at: '2026-06-10T10:20:00Z', open: 11, ci: 2, queue: 1, failed: 0 },
    ] },
  ],
};

function mockFetchOk(payload: MetricsPayload = PAYLOAD) {
  const fn = vi.fn(async (url: string | URL | Request) => {
    const windowDays = Number(new URL(String(url), 'http://x').searchParams.get('windowDays'));
    return {
      ok: true, status: 200,
      json: async () => ({ ...payload, windowDays }),
    } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('MetricsView', () => {
  it('fetches the default 14-day window on mount and renders all five panels', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView />);
    expect(screen.getByText('Loading metrics…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Runner-wait health' })).toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]![0])).toBe('/api/metrics?windowDays=14');
    for (const heading of ['Runner-wait health', 'Queue throughput',
      'Slowest / most-variable jobs', 'Merge velocity + deploy lag', 'Trends']) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
  });

  it('labels runner-wait sub-sections by event tier', async () => {
    mockFetchOk();
    render(<MetricsView />);
    const heading = await screen.findByRole('heading', { name: 'Runner-wait health' });
    const panel = heading.closest('section')! as HTMLElement;
    expect(within(panel).getByText('pull_request')).toBeInTheDocument();
    expect(within(panel).getByText('merge_group')).toBeInTheDocument();
  });

  it('renders the slowest-jobs table with variability, highlighting ratios > 2', async () => {
    mockFetchOk();
    render(<MetricsView />);
    await waitFor(() => expect(screen.getByText('Integration Tests')).toBeInTheDocument());
    const calm = screen.getByText('1.3×');
    const spiky = screen.getByText('4.0×');
    expect(calm.className).not.toContain('var-high');
    expect(spiky.className).toContain('var-high');
    expect(screen.getByText('flaky-suite')).toBeInTheDocument();
  });

  it('window selector buttons refetch with the chosen window (aria-pressed reflects it)', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Trends' })).toBeInTheDocument());
    const btn7 = screen.getByRole('button', { name: '7d' });
    expect(screen.getByRole('button', { name: '14d' })).toHaveAttribute('aria-pressed', 'true');
    expect(btn7).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn7);
    await waitFor(() => expect(btn7).toHaveAttribute('aria-pressed', 'true'));
    expect(String(fetchFn.mock.calls[1]![0])).toBe('/api/metrics?windowDays=7');
  });

  it('the refresh button refetches the current window', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Trends' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh metrics' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(String(fetchFn.mock.calls[1]![0])).toBe('/api/metrics?windowDays=14');
  });

  it('shows an error state when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 } as Response)));
    render(<MetricsView />);
    await waitFor(() => expect(screen.getByText(/metrics fetch failed/i)).toBeInTheDocument());
  });

  it('renders "no data yet" per empty panel', async () => {
    mockFetchOk(EMPTY);
    render(<MetricsView />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Trends' })).toBeInTheDocument());
    expect(screen.getAllByText('no data yet')).toHaveLength(5);
  });

  it('trends panel shows per-counter sparklines with the latest values', async () => {
    mockFetchOk();
    render(<MetricsView />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Trends' })).toBeInTheDocument());
    const trends = screen.getByRole('heading', { name: 'Trends' }).closest('section')! as HTMLElement;
    expect(within(trends).getByText('open')).toBeInTheDocument();
    expect(within(trends).getByText('failed')).toBeInTheDocument();
    // latest open count (11) shows as the big stat number
    const stats = [...trends.querySelectorAll('.metric-stat b')].map((b) => b.textContent);
    expect(stats).toEqual(['11', '2', '1', '0']); // open / ci / queue / failed latest values
  });
});
