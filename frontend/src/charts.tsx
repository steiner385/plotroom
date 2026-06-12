/**
 * Pure SVG chart primitives for the Metrics tab (round 12). No chart deps, no
 * animation. Strokes/fills are CSS variables so every chart stays readable in
 * both light and dark themes. Axis-light: min/max labels only; per-point
 * tooltips via `<title>`.
 */

export interface ChartPoint {
  label: string;
  /** null = gap (no data that day) — lines break instead of bridging. */
  value: number | null;
}

const PAD = 2;          // px inset on every side of the plot box
const LABEL_FONT = 7;   // min/max label font size

/** Default value formatter for labels and tooltips. */
const fmt = (v: number): string => String(Math.round(v * 10) / 10);

interface Scale { x: (i: number) => number; y: (v: number) => number; min: number; max: number; }

function makeScale(values: number[], count: number, width: number, height: number): Scale {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return {
    min, max,
    x: (i) => count === 1 ? width / 2 : PAD + (i * (width - 2 * PAD)) / (count - 1),
    y: (v) => PAD + ((max - v) * (height - 2 * PAD)) / span,
  };
}

/** Consecutive non-null runs of a series: [startIndex, values[]] segments. */
function segments(points: ChartPoint[]): { start: number; values: number[] }[] {
  const out: { start: number; values: number[] }[] = [];
  let current: { start: number; values: number[] } | null = null;
  points.forEach((p, i) => {
    if (p.value == null) { current = null; return; }
    if (!current) { current = { start: i, values: [] }; out.push(current); }
    current.values.push(p.value);
  });
  return out;
}

/** One series' segments as polylines (runs) and circles (isolated points). */
function seriesShapes(points: ChartPoint[], scale: Scale, stroke: string, keyPrefix: string) {
  return segments(points).map((seg, si) => {
    if (seg.values.length === 1) {
      return <circle key={`${keyPrefix}c${si}`} cx={scale.x(seg.start)} cy={scale.y(seg.values[0]!)}
        r={1.5} fill={stroke} />;
    }
    const pts = seg.values
      .map((v, j) => `${scale.x(seg.start + j)},${scale.y(v)}`).join(' ');
    return <polyline key={`${keyPrefix}l${si}`} points={pts} fill="none"
      stroke={stroke} strokeWidth={1.5} />;
  });
}

/** Invisible hover targets carrying the per-point `<title>` tooltips. */
function tooltipTargets(points: ChartPoint[], scale: Scale, height: number,
  format: (v: number) => string) {
  const step = points.length > 1 ? scale.x(1) - scale.x(0) : 0;
  return points.map((p, i) => p.value == null ? null : (
    <rect key={`t${i}`} x={scale.x(i) - step / 2} y={0} width={Math.max(step, 4)} height={height}
      fill="transparent">
      <title>{`${p.label}: ${format(p.value)}`}</title>
    </rect>
  ));
}

function minMaxLabels(scale: Scale, width: number, height: number, format: (v: number) => string) {
  return (
    <>
      <text x={width - PAD} y={PAD + LABEL_FONT} textAnchor="end" fontSize={LABEL_FONT}
        fill="var(--muted)">{format(scale.max)}</text>
      <text x={width - PAD} y={height - PAD} textAnchor="end" fontSize={LABEL_FONT}
        fill="var(--muted)">{format(scale.min)}</text>
    </>
  );
}

export function Sparkline({ points, width = 140, height = 32, color = 'var(--accent)',
  format = fmt, label }: {
  points: ChartPoint[]; width?: number; height?: number; color?: string;
  format?: (v: number) => string;
  /** Accessible name for the chart (aria-label). */
  label?: string;
}) {
  const values = points.flatMap((p) => (p.value == null ? [] : [p.value]));
  if (!values.length) return null;
  const scale = makeScale(values, points.length, width, height);
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      role="img" aria-label={label}>
      {seriesShapes(points, scale, color, 's')}
      {minMaxLabels(scale, width, height, format)}
      {tooltipTargets(points, scale, height, format)}
    </svg>
  );
}

export function Bars({ points, width = 140, height = 32, color = 'var(--accent)',
  format = fmt, label }: {
  points: { label: string; value: number }[]; width?: number; height?: number; color?: string;
  format?: (v: number) => string; label?: string;
}) {
  if (!points.length) return null;
  const max = Math.max(...points.map((p) => p.value), 1);
  const innerH = height - 2 * PAD;
  const slot = (width - 2 * PAD) / points.length;
  const barW = Math.max(slot - 2, 1);
  return (
    <svg className="bars" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      role="img" aria-label={label}>
      {points.map((p, i) => {
        // zero-value days stay visible as a 1px hairline (a gap reads as "no data")
        const h = Math.max((p.value / max) * innerH, 1);
        return (
          <rect key={i} x={PAD + i * slot + (slot - barW) / 2} y={height - PAD - h}
            width={barW} height={h} fill={color}>
            <title>{`${p.label}: ${format(p.value)}`}</title>
          </rect>
        );
      })}
      <text x={width - PAD} y={PAD + LABEL_FONT} textAnchor="end" fontSize={LABEL_FONT}
        fill="var(--muted)">{format(max)}</text>
    </svg>
  );
}

/** Two aligned series (p50/p90 pairs) on a shared scale. */
export function DualLine({ a, b, width = 220, height = 48,
  colorA = 'var(--accent)', colorB = 'var(--amber)', format = fmt, label }: {
  a: ChartPoint[]; b: ChartPoint[]; width?: number; height?: number;
  colorA?: string; colorB?: string; format?: (v: number) => string; label?: string;
}) {
  const values = [...a, ...b].flatMap((p) => (p.value == null ? [] : [p.value]));
  if (!values.length) return null;
  const count = Math.max(a.length, b.length);
  const scale = makeScale(values, count, width, height);
  return (
    <svg className="dual-line" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      role="img" aria-label={label}>
      {seriesShapes(a, scale, colorA, 'a')}
      {seriesShapes(b, scale, colorB, 'b')}
      {minMaxLabels(scale, width, height, format)}
      {tooltipTargets(a, scale, height, format)}
    </svg>
  );
}
