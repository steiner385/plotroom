import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Sparkline, Bars, DualLine, type ChartPoint } from '../charts';

const pts = (values: (number | null)[]): ChartPoint[] =>
  values.map((value, i) => ({ label: `d${i}`, value }));

describe('Sparkline', () => {
  it('renders one polyline scaled to min/max over the inner box', () => {
    const { container } = render(<Sparkline points={pts([0, 10, 5])} width={104} height={24} />);
    const lines = container.querySelectorAll('polyline');
    expect(lines).toHaveLength(1);
    // x spans 2..102 (2px padding), y: max(10) → 2, min(0) → 22, mid(5) → 12
    expect(lines[0]!.getAttribute('points')).toBe('2,22 52,2 102,12');
  });

  it('breaks the line at null gaps (separate polylines, no bridging)', () => {
    const { container } = render(
      <Sparkline points={pts([1, 2, null, 3, 4])} width={104} height={24} />);
    expect(container.querySelectorAll('polyline')).toHaveLength(2);
  });

  it('renders an isolated point (no neighbors) as a dot, not a polyline', () => {
    const { container } = render(
      <Sparkline points={pts([null, 5, null])} width={104} height={24} />);
    expect(container.querySelectorAll('polyline')).toHaveLength(0);
    expect(container.querySelectorAll('circle')).toHaveLength(1);
  });

  it('renders nothing for empty or all-null series', () => {
    expect(render(<Sparkline points={[]} />).container.querySelector('svg')).toBeNull();
    expect(render(<Sparkline points={pts([null, null])} />).container.querySelector('svg')).toBeNull();
  });

  it('uses a CSS-var stroke (theme-aware) and shows min/max labels', () => {
    const { container } = render(<Sparkline points={pts([60, 120])} />);
    expect(container.querySelector('polyline')!.getAttribute('stroke')).toBe('var(--accent)');
    const texts = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).toContain('120');
    expect(texts).toContain('60');
  });

  it('exposes per-point tooltips via <title>', () => {
    const { container } = render(<Sparkline points={pts([60, 120])} />);
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles).toContain('d0: 60');
    expect(titles).toContain('d1: 120');
  });

  it('contains no animation elements', () => {
    const { container } = render(<Sparkline points={pts([1, 2, 3])} />);
    expect(container.querySelector('animate, animateTransform, animateMotion')).toBeNull();
  });
});

describe('Bars', () => {
  it('renders one rect per point, heights proportional to the max', () => {
    const { container } = render(
      <Bars points={[{ label: 'a', value: 1 }, { label: 'b', value: 4 }]} height={24} />);
    const rects = container.querySelectorAll('rect');
    expect(rects).toHaveLength(2);
    const h0 = Number(rects[0]!.getAttribute('height'));
    const h1 = Number(rects[1]!.getAttribute('height'));
    expect(h1).toBeGreaterThan(h0);
    expect(h0 / h1).toBeCloseTo(0.25, 5);
  });

  it('each bar carries a <title> tooltip and zero-value bars stay visible (hairline)', () => {
    const { container } = render(
      <Bars points={[{ label: '2026-06-10', value: 0 }, { label: '2026-06-11', value: 2 }]} />);
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles).toContain('2026-06-10: 0');
    expect(titles).toContain('2026-06-11: 2');
    expect(Number(container.querySelectorAll('rect')[0]!.getAttribute('height'))).toBeGreaterThan(0);
  });

  it('renders nothing for an empty series', () => {
    expect(render(<Bars points={[]} />).container.querySelector('svg')).toBeNull();
  });
});

describe('DualLine', () => {
  it('renders two polylines on a shared scale with distinct CSS-var strokes', () => {
    const a = pts([10, 20]);   // p50
    const b = pts([20, 40]);   // p90
    const { container } = render(<DualLine a={a} b={b} width={104} height={44} />);
    const lines = container.querySelectorAll('polyline');
    expect(lines).toHaveLength(2);
    const strokes = [...lines].map((l) => l.getAttribute('stroke'));
    expect(new Set(strokes).size).toBe(2);
    expect(strokes.every((s) => s?.startsWith('var(--'))).toBe(true);
    // shared scale: b's max (40) sits at the top, a's min (10) at the bottom
    const aPts = lines[0]!.getAttribute('points')!;
    const bPts = lines[1]!.getAttribute('points')!;
    expect(aPts.split(' ')[0]).toBe('2,42'); // 10 = global min → bottom
    expect(bPts.split(' ')[1]).toBe('102,2'); // 40 = global max → top
  });

  it('tolerates null gaps in either series', () => {
    const { container } = render(
      <DualLine a={pts([1, null, 3])} b={pts([2, 4, null])} width={104} height={44} />);
    // a splits into two isolated dots; b is one 2-point polyline
    expect(container.querySelectorAll('polyline')).toHaveLength(1);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('renders nothing when both series are empty', () => {
    expect(render(<DualLine a={[]} b={[]} />).container.querySelector('svg')).toBeNull();
  });
});
