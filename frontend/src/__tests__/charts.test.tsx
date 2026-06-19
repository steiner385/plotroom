import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import {
  AreaSeries, BandSeries, MultiLine, SignedLine, ScatterPlot,
  timeTicks, formatBucketLabel, formatBucketTooltip,
  type ChartPoint, type BandPoint,
} from '../charts';

const hourBucket = (h: number): string => `2026-06-11T${String(h).padStart(2, '0')}`;
const pts = (values: (number | null)[]): ChartPoint[] =>
  values.map((value, i) => ({ bucket: hourBucket(i), value }));
const band = (values: ([number, number] | null)[]): BandPoint[] =>
  values.map((v, i) => ({ bucket: hourBucket(i), p50: v?.[0] ?? null, p90: v?.[1] ?? null }));

describe('formatBucketLabel', () => {
  it('formats hour buckets as HH:MM (local time)', () => {
    const label = formatBucketLabel('2026-06-11T14', 'hour');
    expect(label).toMatch(/^\d{2}:\d{2}$/);
    // distinct hours yield distinct labels
    expect(formatBucketLabel('2026-06-11T15', 'hour')).not.toBe(label);
  });

  it('formats day buckets as "Mon D" (UTC day, no TZ drift)', () => {
    expect(formatBucketLabel('2026-06-11', 'day')).toBe('Jun 11');
    expect(formatBucketLabel('2026-01-02', 'day')).toBe('Jan 2');
  });
});

describe('formatBucketTooltip', () => {
  it('hour tooltips carry the day AND the time', () => {
    const tip = formatBucketTooltip('2026-06-11T14', 'hour');
    expect(tip).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
  });

  it('day tooltips equal the day label', () => {
    expect(formatBucketTooltip('2026-06-11', 'day')).toBe('Jun 11');
  });
});

describe('timeTicks (major @ day/month, minor @ hour/day)', () => {
  const localDay = (b: string) =>
    new Date(`${b}:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  it('emits one tick per bucket (a minor tick at every bucket boundary)', () => {
    const ticks = timeTicks(['2026-06-11T00', '2026-06-11T01', '2026-06-11T02'], 'hour');
    expect(ticks.map((t) => t.index)).toEqual([0, 1, 2]);
  });

  it('empty buckets → no ticks', () => {
    expect(timeTicks([], 'hour')).toEqual([]);
  });

  it('hour: edges + day-rollovers are major+labeled, interior same-day are minor+unlabeled (TZ-robust)', () => {
    const buckets = ['2026-06-11T10', '2026-06-11T11', '2026-06-11T12', '2026-06-11T13'];
    const ticks = timeTicks(buckets, 'hour');
    for (let i = 0; i < ticks.length; i++) {
      const edge = i === 0 || i === ticks.length - 1;
      const dayChanged = i > 0 && localDay(buckets[i]!) !== localDay(buckets[i - 1]!);
      expect(ticks[i]!.major).toBe(edge || dayChanged);
      expect(ticks[i]!.label != null).toBe(ticks[i]!.major);          // labels only on majors
      if (ticks[i]!.major) expect(ticks[i]!.label).toBe(localDay(buckets[i]!)); // major label = the day
    }
  });

  it('hour: a multi-day window has interior MAJOR ticks at day boundaries AND minor ticks between (TZ-robust)', () => {
    // 26 consecutive UTC hours always cross ≥1 local midnight in any timezone
    const buckets = Array.from({ length: 26 }, (_, h) =>
      new Date(Date.UTC(2026, 5, 11, h)).toISOString().slice(0, 13));
    const ticks = timeTicks(buckets, 'hour');
    const interiorMajors = ticks.filter((t, i) => t.major && i !== 0 && i !== ticks.length - 1);
    expect(interiorMajors.length).toBeGreaterThanOrEqual(1); // ≥1 day-boundary major
    expect(ticks.some((t) => !t.major)).toBe(true);          // minor (hour) ticks between
  });

  it('day: minor at every day, major+labeled at the month rollover and edges', () => {
    const ticks = timeTicks(['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02'], 'day');
    expect(ticks.map((t) => t.major)).toEqual([true, false, true, true]); // edge, minor, month-rollover, edge
    expect(ticks[2]!.label).toBe('Jul 1');
    expect(ticks[1]!.label).toBeNull();
  });
});

describe('AreaSeries', () => {
  it('renders a full-width svg with line + area fill', () => {
    const { container } = render(<AreaSeries points={pts([0, 10, 5])} kind="hour" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('100%');
    expect(svg.getAttribute('viewBox')).toBeTruthy();
    expect(container.querySelectorAll('polyline')).toHaveLength(1);
    expect(container.querySelectorAll('polygon')).toHaveLength(1); // soft area fill
  });

  it('draws horizontal gridlines with y-axis labels (0 / mid / max)', () => {
    const { container } = render(<AreaSeries points={pts([0, 10, 5])} kind="hour" />);
    expect(container.querySelectorAll('line').length).toBeGreaterThanOrEqual(3);
    const texts = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).toContain('10'); // max
    expect(texts).toContain('5');  // mid
    expect(texts).toContain('0');  // baseline
  });

  it('renders minor (hour) + major (day) x-axis tick MARKS, labels on majors only', () => {
    // span 30 hours so the window crosses a local-day boundary in any timezone →
    // both minor (hour) and major (day) ticks are present
    const points: ChartPoint[] = Array.from({ length: 30 }, (_, h) => ({
      bucket: new Date(Date.UTC(2026, 5, 11, h)).toISOString().slice(0, 13), value: h + 1,
    }));
    const { container } = render(<AreaSeries points={points} kind="hour" />);
    const minors = container.querySelectorAll('line[data-tick="minor"]');
    const majors = container.querySelectorAll('line[data-tick="major"]');
    expect(minors.length).toBeGreaterThan(0);   // hour-boundary minor marks
    expect(majors.length).toBeGreaterThanOrEqual(2); // ≥ first/last anchors + a day boundary
    // major marks hang lower (taller) than minor marks
    const len = (el: Element) => Number(el.getAttribute('y2')) - Number(el.getAttribute('y1'));
    expect(len(majors[0]!)).toBeGreaterThan(len(minors[0]!));
    // every minor tick is unlabeled; at least one major carries a "Mon D" label
    const labels = [...container.querySelectorAll('text')].map((t) => t.textContent ?? '');
    expect(labels.some((t) => /^[A-Z][a-z]{2} \d{1,2}$/.test(t))).toBe(true);
  });

  it('breaks line and area at null gaps instead of bridging', () => {
    const { container } = render(<AreaSeries points={pts([1, 2, null, 3, 4])} kind="hour" />);
    expect(container.querySelectorAll('polyline')).toHaveLength(2);
    expect(container.querySelectorAll('polygon')).toHaveLength(2);
  });

  it('renders the sparse-data placeholder below 3 populated buckets', () => {
    const { container, getByText } = render(<AreaSeries points={pts([1, 2])} kind="hour" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(getByText('collecting data — 2 samples so far')).toBeInTheDocument();
  });

  it('uses singular wording for one sample', () => {
    const { getByText } = render(<AreaSeries points={pts([null, 5, null])} kind="hour" />);
    expect(getByText('collecting data — 1 sample so far')).toBeInTheDocument();
  });

  it('honors the populated override (zero-filled count series stay guarded)', () => {
    // 6 aligned buckets, zero-filled — but only 2 real samples behind them
    const { container, getByText } = render(
      <AreaSeries points={pts([0, 1, 0, 0, 1, 0])} kind="hour" populated={2} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(getByText('collecting data — 2 samples so far')).toBeInTheDocument();
  });

  it('exposes per-point tooltips (day + time for hour buckets) and no animation', () => {
    const points = pts([60, 120, 90]);
    const { container } = render(<AreaSeries points={points} kind="hour" />);
    // With the single overlay rect, tooltip text appears after a mousemove event.
    const overlay = container.querySelector('rect[data-tooltip-overlay]')!;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(
      { left: 0, width: 1000, right: 1000, top: 0, bottom: 150, height: 150, x: 0, y: 0 } as DOMRect);
    // move to left edge (bucket 0)
    fireEvent.mouseMove(overlay, { clientX: 0 });
    const title = overlay.querySelector('title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toContain(`${formatBucketTooltip(points[0]!.bucket, 'hour')}: 60`);
    expect(container.querySelector('animate, animateTransform, animateMotion')).toBeNull();
  });

  it('strokes with CSS variables (theme-aware)', () => {
    const { container } = render(<AreaSeries points={pts([1, 2, 3])} kind="hour" />);
    expect(container.querySelector('polyline')!.getAttribute('stroke')).toBe('var(--accent)');
  });
});

describe('BandSeries', () => {
  it('renders a p50 line + p50→p90 band polygon and labels the band', () => {
    const { container, getByText } = render(
      <BandSeries points={band([[10, 20], [15, 30], [12, 25]])} kind="hour" />);
    expect(container.querySelectorAll('polyline')).toHaveLength(1); // p50 line
    const polys = container.querySelectorAll('polygon');
    expect(polys).toHaveLength(1); // the band
    // band polygon has an up edge and a back edge: 2 coords per bucket
    expect(polys[0]!.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(6);
    expect(getByText(/band = p50–p90/)).toBeInTheDocument();
  });

  it('shows gridlines + axis labels like other full charts', () => {
    const { container } = render(
      <BandSeries points={band([[10, 20], [15, 30], [12, 25]])} kind="hour" />);
    expect(container.querySelectorAll('line').length).toBeGreaterThanOrEqual(3);
    expect(container.querySelectorAll('text').length).toBeGreaterThanOrEqual(4);
  });

  it('renders the sparse placeholder below 3 populated buckets', () => {
    const { container, getByText } = render(
      <BandSeries points={band([[10, 20], null])} kind="hour" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(getByText('collecting data — 1 sample so far')).toBeInTheDocument();
  });

  it('compact mode: fixed small size, no axes, compact placeholder', () => {
    const { container } = render(
      <BandSeries points={band([[10, 20], [15, 30], [12, 25]])} kind="hour" compact />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('120');
    expect(container.querySelectorAll('text')).toHaveLength(0);
    expect(container.querySelectorAll('line')).toHaveLength(0);
    expect(container.querySelectorAll('polyline')).toHaveLength(1);
    expect(container.querySelectorAll('polygon')).toHaveLength(1);

    const sparse = render(<BandSeries points={band([[10, 20]])} kind="hour" compact />);
    expect(sparse.container.querySelector('svg')).toBeNull();
    expect(sparse.getByText('collecting (1)')).toBeInTheDocument();
  });

  it('tolerates buckets where p90 is missing (band skips, line continues)', () => {
    const { container } = render(
      <BandSeries points={[
        { bucket: hourBucket(0), p50: 10, p90: 20 },
        { bucket: hourBucket(1), p50: 15, p90: null },
        { bucket: hourBucket(2), p50: 12, p90: 24 },
      ]} kind="hour" />);
    expect(container.querySelectorAll('polyline')).toHaveLength(1); // p50 unbroken
    expect(container.querySelectorAll('polygon').length).toBeGreaterThanOrEqual(1);
  });
});

describe('MultiLine', () => {
  const series = [
    { name: 'open', color: 'var(--accent)', points: pts([5, 6, 7]) },
    { name: 'ci', color: 'var(--amber)', points: pts([2, 3, 1]) },
    { name: 'failed', color: 'var(--fail)', points: pts([0, 1, 0]) },
  ];

  it('renders one polyline per series with its own CSS-var stroke', () => {
    const { container } = render(<MultiLine series={series} kind="hour" />);
    const lines = container.querySelectorAll('polyline');
    expect(lines).toHaveLength(3);
    expect([...lines].map((l) => l.getAttribute('stroke')))
      .toEqual(['var(--accent)', 'var(--amber)', 'var(--fail)']);
  });

  it('renders a legend with a color chip and label per series', () => {
    const { container, getByText } = render(<MultiLine series={series} kind="hour" />);
    for (const s of series) expect(getByText(s.name)).toBeInTheDocument();
    const chips = container.querySelectorAll('.legend-chip');
    expect(chips).toHaveLength(3);
    expect((chips[0] as HTMLElement).getAttribute('style')).toContain('var(--accent)');
  });

  it('shares one y scale across series and draws gridlines + ticks', () => {
    const { container } = render(<MultiLine series={series} kind="hour" />);
    const texts = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).toContain('7'); // global max across series
    expect(container.querySelectorAll('line').length).toBeGreaterThanOrEqual(3);
  });

  it('per-bucket tooltips combine all series values', () => {
    const { container } = render(<MultiLine series={series} kind="hour" />);
    // With the single overlay, hover bucket 0 (left edge) to verify combined tooltip text.
    const overlay = container.querySelector('rect[data-tooltip-overlay]')!;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(
      { left: 0, width: 1000, right: 1000, top: 0, bottom: 150, height: 150, x: 0, y: 0 } as DOMRect);
    fireEvent.mouseMove(overlay, { clientX: 0 });
    const title = overlay.querySelector('title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toContain('open 5');
    expect(title!.textContent).toContain('ci 2');
    expect(title!.textContent).toContain('failed 0');
  });

  it('renders the sparse placeholder below 3 populated buckets', () => {
    const sparse = [
      { name: 'open', color: 'var(--accent)', points: pts([5, null, null]) },
      { name: 'ci', color: 'var(--amber)', points: pts([2, 3, null]) },
    ];
    const { container, getByText } = render(<MultiLine series={sparse} kind="hour" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(getByText('collecting data — 2 samples so far')).toBeInTheDocument();
  });

  it('contains no animation elements', () => {
    const { container } = render(<MultiLine series={series} kind="hour" />);
    expect(container.querySelector('animate, animateTransform, animateMotion')).toBeNull();
  });
});

describe('SignedLine (calibration error trend)', () => {
  it('renders negative values with an emphasized solid zero gridline', () => {
    const { container } = render(
      <SignedLine points={pts([10, -20, 30])} kind="hour" />);
    const zero = container.querySelector('[data-zero-gridline]')!;
    expect(zero).toBeTruthy();
    expect(zero.getAttribute('stroke-dasharray')).toBeNull(); // solid = emphasized
    // negative point sits BELOW the zero line (larger svg y)
    const zeroY = Number(zero.getAttribute('y1'));
    const ys = [...container.querySelectorAll('polyline')]
      .flatMap((p) => p.getAttribute('points')!.split(' ').map((xy) => Number(xy.split(',')[1])));
    expect(Math.max(...ys)).toBeGreaterThan(zeroY); // the −20 vertex
    expect(Math.min(...ys)).toBeLessThan(zeroY);    // the +30 vertex
  });

  it('labels the extremes and zero with the supplied format', () => {
    const { container } = render(
      <SignedLine points={pts([10, -20, 30])} kind="hour" format={(v) => `${v}%`} />);
    const texts = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).toContain('30%');
    expect(texts).toContain('-20%');
    expect(texts).toContain('0%');
  });

  it('all-positive series still draws the zero baseline', () => {
    const { container } = render(<SignedLine points={pts([5, 10, 15])} kind="hour" />);
    expect(container.querySelector('[data-zero-gridline]')).toBeTruthy();
  });

  it('carries per-bucket tooltips and breaks at null gaps', () => {
    const { container } = render(
      <SignedLine points={pts([10, null, -5, 8])} kind="hour" format={(v) => `${v}%`} />);
    // With the single overlay, hover each bucket and verify null vs non-null tooltip.
    const overlay = container.querySelector('rect[data-tooltip-overlay]')!;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(
      { left: 0, width: 999, right: 999, top: 0, bottom: 150, height: 150, x: 0, y: 0 } as DOMRect);
    // bucket 2 (index 2 of 4) → clientX = 2/3 * 999 ≈ 666
    fireEvent.mouseMove(overlay, { clientX: 666 });
    expect(overlay.querySelector('title')!.textContent).toContain('-5%');
    // bucket 1 (null) → clientX = 1/3 * 999 ≈ 333
    fireEvent.mouseMove(overlay, { clientX: 333 });
    expect(!overlay.querySelector('title') || overlay.querySelector('title')!.textContent === '').toBe(true);
  });

  it('renders the sparse placeholder below 3 populated buckets', () => {
    const { container, getByText } = render(
      <SignedLine points={pts([10, -20, null])} kind="hour" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(getByText('collecting data — 2 samples so far')).toBeInTheDocument();
  });
});

describe('ScatterPlot (predicted vs actual)', () => {
  const POINTS = [
    { predicted: 100, actual: 100 }, // on the diagonal
    { predicted: 100, actual: 200 }, // above (took longer)
    { predicted: 200, actual: 100 }, // below (finished early)
  ];

  /** y of the diagonal at a given x (linear interpolation of its endpoints). */
  function diagonalYAt(diag: Element, cx: number): number {
    const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((a) => Number(diag.getAttribute(a)));
    return y1! + ((cx - x1!) * (y2! - y1!)) / (x2! - x1!);
  }

  it('renders one circle per point and the perfect-calibration diagonal', () => {
    const { container } = render(<ScatterPlot points={POINTS} />);
    expect(container.querySelectorAll('circle')).toHaveLength(3);
    expect(container.querySelector('[data-diagonal]')).toBeTruthy();
  });

  it('points above the diagonal are exactly those where actual > predicted', () => {
    const { container } = render(<ScatterPlot points={POINTS} />);
    const diag = container.querySelector('[data-diagonal]')!;
    const circles = [...container.querySelectorAll('circle')];
    const rel = circles.map((c) => {
      const cy = Number(c.getAttribute('cy'));
      const dy = diagonalYAt(diag, Number(c.getAttribute('cx')));
      return cy < dy - 0.01 ? 'above' : cy > dy + 0.01 ? 'below' : 'on';
    });
    expect(rel).toEqual(['on', 'above', 'below']);
  });

  it('tooltips carry predicted → actual with the supplied format', () => {
    const { container } = render(
      <ScatterPlot points={POINTS} format={(v) => `${v}s`} />);
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles).toContain('predicted 100s → actual 200s');
  });

  it('renders the sparse placeholder below 3 points', () => {
    const { container, getByText } = render(
      <ScatterPlot points={POINTS.slice(0, 2)} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(getByText('collecting data — 2 samples so far')).toBeInTheDocument();
  });

  it('contains no animation elements', () => {
    const { container } = render(<ScatterPlot points={POINTS} />);
    expect(container.querySelector('animate, animateTransform, animateMotion')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part A (#179): single tooltip overlay instead of per-bucket ghost rects
// ---------------------------------------------------------------------------
describe('tooltip overlay: single rect instead of N per-bucket rects', () => {
  const buckets3 = pts([10, 20, 30]);

  /** Stub getBoundingClientRect on the overlay rect so pointer-x math works in JSDOM. */
  function stubOverlayRect(overlayEl: Element, left = 0, width = 1000) {
    vi.spyOn(overlayEl, 'getBoundingClientRect').mockReturnValue(
      { left, width, right: left + width, top: 0, bottom: 150, height: 150, x: left, y: 0 } as DOMRect);
  }

  it('AreaSeries: ONE overlay rect covers the full chart (not N per-bucket rects)', () => {
    const { container } = render(<AreaSeries points={buckets3} kind="hour" />);
    const overlays = container.querySelectorAll('rect[data-tooltip-overlay]');
    expect(overlays).toHaveLength(1);
    // must NOT have multiple per-bucket hover rects anymore
    const allRects = [...container.querySelectorAll('rect')];
    expect(allRects.filter((r) => r.getAttribute('data-tooltip-overlay') === null)).toHaveLength(0);
  });

  it('AreaSeries: mousemove over bucket 1 (middle of 3) surfaces that bucket tooltip', () => {
    const { container } = render(<AreaSeries points={buckets3} kind="hour" />);
    const overlay = container.querySelector('rect[data-tooltip-overlay]')!;
    stubOverlayRect(overlay, 0, 1000);
    // bucket 1 is at index 1 of 3; x fraction ≈ 0.5 → clientX 500
    fireEvent.mouseMove(overlay, { clientX: 500 });
    const title = overlay.querySelector('title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toContain('20');
  });

  it('AreaSeries: mouseleave clears the tooltip', () => {
    const { container } = render(<AreaSeries points={buckets3} kind="hour" />);
    const overlay = container.querySelector('rect[data-tooltip-overlay]')!;
    stubOverlayRect(overlay, 0, 1000);
    fireEvent.mouseMove(overlay, { clientX: 500 });
    fireEvent.mouseLeave(overlay);
    const title = overlay.querySelector('title');
    // after leave, no title or empty title
    expect(!title || title.textContent === '').toBe(true);
  });

  it('MultiLine: ONE overlay rect (not N), mousemove on bucket 0 surfaces all series values', () => {
    const series = [
      { name: 'open', color: 'var(--accent)', points: pts([5, 6, 7]) },
      { name: 'ci', color: 'var(--amber)', points: pts([2, 3, 1]) },
    ];
    const { container } = render(<MultiLine series={series} kind="hour" />);
    const overlays = container.querySelectorAll('rect[data-tooltip-overlay]');
    expect(overlays).toHaveLength(1);
    const overlay = overlays[0]!;
    stubOverlayRect(overlay, 0, 1000);
    // bucket 0 → far left → clientX ~0
    fireEvent.mouseMove(overlay, { clientX: 10 });
    const title = overlay.querySelector('title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toContain('open 5');
    expect(title!.textContent).toContain('ci 2');
  });

  it('BandSeries: ONE overlay rect, mousemove shows p50 + p90 for hovered bucket', () => {
    const points = [
      { bucket: hourBucket(0), p50: 10, p90: 20 },
      { bucket: hourBucket(1), p50: 15, p90: 30 },
      { bucket: hourBucket(2), p50: 12, p90: 24 },
    ];
    const { container } = render(<BandSeries points={points} kind="hour" />);
    const overlays = container.querySelectorAll('rect[data-tooltip-overlay]');
    expect(overlays).toHaveLength(1);
    const overlay = overlays[0]!;
    stubOverlayRect(overlay, 0, 1000);
    fireEvent.mouseMove(overlay, { clientX: 990 }); // near right → bucket 2
    const title = overlay.querySelector('title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toContain('12');
  });

  it('SignedLine: ONE overlay rect, mousemove on null bucket shows no tooltip', () => {
    // 4 buckets, index 1 is null — 3 non-null satisfies the sparse-data guard
    const withNull = pts([10, null, 20, 30]);
    const { container } = render(<SignedLine points={withNull} kind="hour" />);
    const overlays = container.querySelectorAll('rect[data-tooltip-overlay]');
    expect(overlays).toHaveLength(1);
    const overlay = overlays[0]!;
    stubOverlayRect(overlay, 0, 999);
    // bucket 1 (null) is at index 1 of 4 → x fraction = 1/3 → clientX ≈ 333
    fireEvent.mouseMove(overlay, { clientX: 333 });
    const title = overlay.querySelector('title');
    expect(!title || title.textContent === '').toBe(true);
  });
});
