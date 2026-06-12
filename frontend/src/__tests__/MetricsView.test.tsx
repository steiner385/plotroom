import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MetricsView } from '../MetricsView';
import type { MetricsBucket, MetricsPayload, MetricsWindow } from '../types';

const EMPTY: MetricsPayload = {
  window: '3d', bucket: 'hour',
  runnerWaits: [], queue: [], slowestJobs: [], velocity: [], trends: [], calibration: [],
};

const H = (h: number): string => `2026-06-11T${String(h).padStart(2, '0')}`;
/** Fixed clock so the window axis lines up with the fixture buckets. */
const NOW = () => new Date('2026-06-11T10:30:00Z');

const PAYLOAD: MetricsPayload = {
  window: '3d', bucket: 'hour',
  runnerWaits: [
    { repo: 'acme/widgets', event: 'pull_request', p50: { value: 45, prev: 30 }, buckets: [
      { bucket: H(8), p50: 30, p90: 60, n: 4 },
      { bucket: H(9), p50: 45, p90: 240, n: 6 },
      { bucket: H(10), p50: 40, p90: 120, n: 5 },
    ] },
    { repo: 'acme/widgets', event: 'merge_group', p50: { value: 120, prev: null }, buckets: [
      { bucket: H(10), p50: 120, p90: 300, n: 2 },
    ] },
  ],
  queue: [
    { repo: 'acme/widgets',
      merges: { value: 8, prev: 4 },
      queueWaitP50: { value: 480, prev: 480 },
      groupRunP50: { value: 900, prev: null },
      mergesPerBucket: [
        { bucket: H(8), count: 3 }, { bucket: H(9), count: 2 }, { bucket: H(10), count: 3 }],
      queueWaitBuckets: [
        { bucket: H(8), p50: 500, n: 3 }, { bucket: H(9), p50: 460, n: 2 }, { bucket: H(10), p50: 480, n: 3 }],
      groupRunBuckets: [{ bucket: H(10), p50: 900, n: 2 }] },
  ],
  slowestJobs: [
    { repo: 'acme/widgets', jobs: [
      { name: 'Integration Tests', event: 'merge_group', p50: 1200, p90: 1500,
        variability: 1.25, n: 14, trend: [
          { bucket: H(8), p50: 1100, p90: 1300, n: 4 },
          { bucket: H(9), p50: 1200, p90: 1500, n: 5 },
          { bucket: H(10), p50: 1250, p90: 1450, n: 5 },
        ] },
      { name: 'flaky-suite', event: 'pull_request', p50: 300, p90: 1200,
        variability: 4, n: 9, trend: [{ bucket: H(10), p50: 300, p90: 1200, n: 9 }] },
    ] },
  ],
  velocity: [
    { repo: 'acme/widgets',
      merged: { value: 5, prev: 5 },
      mergeToQaP50: { value: 600, prev: 300 },
      lifespanMeanHours: { value: 26, prev: null },
      mergedPerBucket: [
        { bucket: H(8), count: 2 }, { bucket: H(9), count: 1 }, { bucket: H(10), count: 2 }],
      mergeToQaBuckets: [
        { bucket: H(8), p50: 600, n: 2 }, { bucket: H(9), p50: 540, n: 1 }, { bucket: H(10), p50: 660, n: 2 }],
      avgLifespanBuckets: [
        { bucket: H(8), meanHours: 20, n: 2 }, { bucket: H(9), meanHours: 30, n: 1 }, { bucket: H(10), meanHours: 26, n: 2 }] },
  ],
  trends: [
    { repo: 'acme/widgets', points: [
      { bucket: H(8), open: 12, ci: 3, queue: 2, failed: 1 },
      { bucket: H(9), open: 12, ci: 2, queue: 1, failed: 1 },
      { bucket: H(10), open: 11, ci: 2, queue: 1, failed: 0 },
    ] },
  ],
  calibration: [
    { repo: 'acme/widgets', stage: 'ci', n: 42,
      medianErrorPct: 18.4, p90AbsErrorPct: 55,
      buckets: [
        { bucket: H(8), medianErrorPct: 12, n: 14 },
        { bucket: H(9), medianErrorPct: -5, n: 13 },
        { bucket: H(10), medianErrorPct: 22, n: 15 },
      ],
      points: [
        { predicted: 300, actual: 360 }, { predicted: 240, actual: 230 },
        { predicted: 500, actual: 640 }, { predicted: 120, actual: 130 },
      ] },
    { repo: 'acme/widgets', stage: 'queue', n: 11,
      medianErrorPct: -7.2, p90AbsErrorPct: 20,
      buckets: [
        { bucket: H(9), medianErrorPct: -8, n: 6 },
        { bucket: H(10), medianErrorPct: -6, n: 5 },
      ],
      points: [{ predicted: 900, actual: 840 }, { predicted: 800, actual: 760 }] },
  ],
};

/** Mock fetch that echoes the requested window/bucket (server clamp emulated). */
function mockFetchOk(payload: MetricsPayload = PAYLOAD) {
  const fn = vi.fn(async (url: string | URL | Request) => {
    const params = new URL(String(url), 'http://x').searchParams;
    const window = (params.get('window') ?? '3d') as MetricsWindow;
    const requested = (params.get('bucket') ?? 'hour') as MetricsBucket;
    const bucket: MetricsBucket = (window === '14d' || window === '30d') ? 'day' : requested;
    return {
      ok: true, status: 200,
      json: async () => ({ ...payload, window, bucket }),
    } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

const PANELS = ['Trends', 'Runner-wait health', 'Queue throughput',
  'Slowest / most-variable jobs', 'Merge velocity + deploy lag', 'ETA calibration'];

describe('MetricsView', () => {
  it('fetches window=3d bucket=hour by default and renders all six panels', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView now={NOW} />);
    expect(screen.getByText('Loading metrics…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Trends' })).toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]![0])).toBe('/api/metrics?window=3d&bucket=hour');
    for (const heading of PANELS) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
  });

  it('window pills cover 24h–30d with the default pressed', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    for (const w of ['24h', '3d', '7d', '14d', '30d']) {
      expect(screen.getByRole('button', { name: w })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: '3d' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switching window refetches; hour stays available at 7d', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(String(fetchFn.mock.calls[1]![0])).toBe('/api/metrics?window=7d&bucket=hour');
    expect(screen.getByRole('button', { name: 'hourly' })).not.toBeDisabled();
  });

  it('windows > 7d disable hourly and fetch day buckets', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    fireEvent.click(screen.getByRole('button', { name: '14d' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(String(fetchFn.mock.calls[1]![0])).toBe('/api/metrics?window=14d&bucket=day');
    expect(screen.getByRole('button', { name: 'hourly' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'daily' })).toHaveAttribute('aria-pressed', 'true');
    // back to a short window re-enables hourly and restores the preference
    fireEvent.click(screen.getByRole('button', { name: '3d' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(3));
    expect(String(fetchFn.mock.calls[2]![0])).toBe('/api/metrics?window=3d&bucket=hour');
    expect(screen.getByRole('button', { name: 'hourly' })).not.toBeDisabled();
  });

  it('bucket toggle switches to daily buckets', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    fireEvent.click(screen.getByRole('button', { name: 'daily' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(String(fetchFn.mock.calls[1]![0])).toBe('/api/metrics?window=3d&bucket=day');
    expect(screen.getByRole('button', { name: 'daily' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the refresh button refetches the current selection', async () => {
    const fetchFn = mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh metrics' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(String(fetchFn.mock.calls[1]![0])).toBe('/api/metrics?window=3d&bucket=hour');
  });

  it('shows an error state when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 } as Response)));
    render(<MetricsView now={NOW} />);
    await waitFor(() => expect(screen.getByText(/metrics fetch failed/i)).toBeInTheDocument());
  });

  it('renders "no data yet" per empty panel', async () => {
    mockFetchOk(EMPTY);
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    expect(screen.getAllByText('no data yet')).toHaveLength(6);
  });

  it('trends panel: one multi-line chart per repo with a legend and latest headline stats', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    const trends = screen.getByRole('heading', { name: 'Trends' }).closest('section')! as HTMLElement;
    // one chart, not four micro-multiples
    expect(trends.querySelectorAll('svg')).toHaveLength(1);
    // legend lists all four series
    const legend = trends.querySelector('.chart-legend')!;
    for (const name of ['open', 'ci', 'queue', 'failed']) {
      expect(within(legend as HTMLElement).getByText(name)).toBeInTheDocument();
    }
    // latest values (last bucket) as the headline stats
    const stats = [...trends.querySelectorAll('.metric-stat b')].map((b) => b.textContent);
    expect(stats).toEqual(['11', '2', '1', '0']);
  });

  it('headline stats show deltas vs the previous window when computable', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    // runner waits: 45 vs 30 → +50%; queue merges: 8 vs 4 → +100%
    expect(screen.getByText('+50% vs prev')).toBeInTheDocument();
    expect(screen.getAllByText('+100% vs prev').length).toBeGreaterThanOrEqual(1);
    // equal windows → "≈ prev" (queueWait 480 vs 480 and merged 5 vs 5)
    expect(screen.getAllByText('≈ prev').length).toBeGreaterThanOrEqual(2);
    // prev null (merge_group runner wait, group run, lifespan) → no delta rendered for those stats
    const mg = screen.getByText('merge_group p50 wait').closest('.metric-stat')! as HTMLElement;
    expect(mg.querySelector('.metric-delta')).toBeNull();
  });

  it('repos with zero data in a panel are omitted entirely', async () => {
    mockFetchOk({
      ...EMPTY,
      trends: [
        { repo: 'octo/empty', points: [] },
        { repo: 'acme/widgets', points: PAYLOAD.trends[0]!.points },
      ],
    });
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Trends' });
    expect(screen.getByRole('heading', { name: 'acme/widgets' })).toBeInTheDocument();
    expect(screen.queryByText('octo/empty')).toBeNull();
  });

  it('sparse series render the collecting-data placeholder instead of dots', async () => {
    mockFetchOk({
      ...EMPTY,
      queue: [{
        repo: 'acme/widgets',
        merges: { value: 2, prev: 0 },
        queueWaitP50: { value: null, prev: null },
        groupRunP50: { value: null, prev: null },
        mergesPerBucket: [{ bucket: H(9), count: 1 }, { bucket: H(10), count: 1 }],
        queueWaitBuckets: [],
        groupRunBuckets: [],
      }],
    });
    render(<MetricsView now={NOW} />);
    await screen.findByRole('heading', { name: 'Queue throughput' });
    expect(screen.getByText('collecting data — 2 samples so far')).toBeInTheDocument();
  });

  it('slowest-jobs table keeps its leaderboard with variability highlighting and band trends', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    await waitFor(() => expect(screen.getByText('Integration Tests')).toBeInTheDocument());
    const calm = screen.getByText('1.3×');
    const spiky = screen.getByText('4.0×');
    expect(calm.className).not.toContain('var-high');
    expect(spiky.className).toContain('var-high');
    // first job's trend renders as a compact band chart (3 populated buckets)
    const table = screen.getByText('Integration Tests').closest('table')! as HTMLElement;
    expect(table.querySelectorAll('svg.chart-svg-compact').length).toBeGreaterThanOrEqual(1);
    // second job has a single trend bucket → compact placeholder
    expect(within(table).getByText('collecting (1)')).toBeInTheDocument();
  });


  it('calibration panel: per-stage headline sentences with signed direction', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'ETA calibration' });
    const panel = heading.closest('section')! as HTMLElement;
    // +18.4% median error → optimistic (stages take longer than promised)
    expect(within(panel).getByText('p50 ETAs run 18% optimistic (n=42)')).toBeInTheDocument();
    // −7.2% → pessimistic (stages finish earlier than promised)
    expect(within(panel).getByText('p50 ETAs run 7% pessimistic (n=11)')).toBeInTheDocument();
    expect(within(panel).getByText(/p90 \|error\| 55%/)).toBeInTheDocument();
  });

  it('calibration panel: error-trend line (zero gridline) and scatter render per stage', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'ETA calibration' });
    const panel = heading.closest('section')! as HTMLElement;
    // ci has 3 buckets → real SignedLine with the emphasized zero gridline
    const trend = within(panel).getByRole('img',
      { name: 'acme/widgets ci median ETA error per hour' });
    expect(trend.querySelector('[data-zero-gridline]')).toBeTruthy();
    // ci has 4 scatter points → real ScatterPlot with the perfect-calibration diagonal
    const scatter = within(panel).getByRole('img',
      { name: 'acme/widgets ci predicted vs actual ETA' });
    expect(scatter.querySelector('[data-diagonal]')).toBeTruthy();
    expect(scatter.querySelectorAll('circle')).toHaveLength(4);
  });

  it('calibration panel: sparse stages fall back to collecting placeholders', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'ETA calibration' });
    const panel = heading.closest('section')! as HTMLElement;
    // queue: 2 buckets and 2 points — both charts guard with placeholders
    expect(within(panel).getAllByText('collecting data — 2 samples so far')).toHaveLength(2);
    expect(within(panel).queryByRole('img',
      { name: 'acme/widgets queue predicted vs actual ETA' })).toBeNull();
  });

  it('calibration panel: entries with no buckets and no points are omitted entirely', async () => {
    mockFetchOk({ ...EMPTY, calibration: [
      { repo: 'acme/widgets', stage: 'ci', n: 0, medianErrorPct: 0, p90AbsErrorPct: 0,
        buckets: [], points: [] },
    ] });
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'ETA calibration' });
    const panel = heading.closest('section')! as HTMLElement;
    expect(within(panel).getByText('no data yet')).toBeInTheDocument();
  });

  it('runner-wait panel labels event tiers and renders full-width band charts', async () => {
    mockFetchOk();
    render(<MetricsView now={NOW} />);
    const heading = await screen.findByRole('heading', { name: 'Runner-wait health' });
    const panel = heading.closest('section')! as HTMLElement;
    expect(within(panel).getByText('pull_request p50 wait')).toBeInTheDocument();
    expect(within(panel).getByText('merge_group p50 wait')).toBeInTheDocument();
    // pull_request tier has 3 populated buckets → a real chart with the band caption
    expect(within(panel).getAllByText(/band = p50–p90/).length).toBeGreaterThanOrEqual(1);
  });
});
