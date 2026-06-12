import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  AreaSeries, BandSeries, MultiLine, SignedLine, ScatterPlot,
  axisTicks, formatBucketLabel, formatBucketTooltip,
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

describe('axisTicks', () => {
  it('emits start / middle / end ticks', () => {
    const ticks = axisTicks(['2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11'], 'day');
    expect(ticks.map((t) => t.index)).toEqual([0, 2, 4]);
    expect(ticks.map((t) => t.text)).toEqual(['Jun 7', 'Jun 9', 'Jun 11']);
  });

  it('dedupes indices for short series', () => {
    expect(axisTicks(['2026-06-11'], 'day').map((t) => t.index)).toEqual([0]);
    expect(axisTicks(['2026-06-10', '2026-06-11'], 'day').map((t) => t.index)).toEqual([0, 1]);
    expect(axisTicks([], 'day')).toEqual([]);
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

  it('labels the x axis at start / middle / end with bucket labels', () => {
    const points = pts([1, 2, 3, 4, 5]);
    const { container } = render(<AreaSeries points={points} kind="hour" />);
    const texts = [...container.querySelectorAll('text')].map((t) => t.textContent);
    for (const i of [0, 2, 4]) {
      expect(texts).toContain(formatBucketLabel(points[i]!.bucket, 'hour'));
    }
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
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles).toContain(`${formatBucketTooltip(points[0]!.bucket, 'hour')}: 60`);
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
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent);
    const withAll = titles.find((t) => t?.includes('open 5') && t.includes('ci 2') && t.includes('failed 0'));
    expect(withAll).toBeTruthy();
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
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles.some((t) => t?.includes('-5%'))).toBe(true);
    expect(titles).toHaveLength(3); // null bucket gets no tooltip
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
