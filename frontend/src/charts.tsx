/**
 * Pure SVG chart components for the Metrics tab. No chart deps, no animation.
 * Strokes/fills are CSS variables so every chart stays readable in both light
 * and dark themes.
 *
 * Readability (metrics-readability redesign):
 *  - charts render full panel width (viewBox + width:100%), 120–160 units tall
 *  - dashed horizontal gridlines at max / mid plus a baseline, each y-labeled
 *  - x-axis bucket labels at start / middle / end (HH:MM local for hour
 *    buckets, "Mon D" for day buckets)
 *  - sparse-data guard: a series with <3 populated buckets renders a
 *    "collecting data — n samples so far" placeholder instead of floating dots
 */

export type BucketKind = 'hour' | 'day';

export interface ChartPoint {
  /** Bucket key — ISO UTC hour (`YYYY-MM-DDTHH`) or day (`YYYY-MM-DD`). */
  bucket: string;
  /** null = gap (no data in that bucket) — lines break instead of bridging. */
  value: number | null;
}

export interface BandPoint { bucket: string; p50: number | null; p90: number | null }

export interface LineSeries { name: string; color: string; points: ChartPoint[] }

export interface AxisTick { index: number; text: string }

// Geometry is in viewBox units; the svg scales to the panel width (width:100%).
const VB_W = 1000;
const PAD_L = 48; const PAD_R = 14; const PAD_T = 12; const PAD_B = 24;
const FONT = 12;

/** Default value formatter for labels and tooltips. */
const fmt = (v: number): string => String(Math.round(v * 10) / 10);

/** Axis label for a bucket key: local HH:MM for hours, "Jun 11" for days. */
export function formatBucketLabel(bucket: string, kind: BucketKind): string {
  if (kind === 'hour') {
    return new Date(`${bucket}:00:00Z`).toLocaleTimeString('en-US',
      { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return new Date(`${bucket}T00:00:00Z`).toLocaleDateString('en-US',
    { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Tooltip label: day + local time for hour buckets, day for day buckets. */
export function formatBucketTooltip(bucket: string, kind: BucketKind): string {
  if (kind === 'hour') {
    const day = new Date(`${bucket}:00:00Z`).toLocaleDateString('en-US',
      { month: 'short', day: 'numeric' });
    return `${day} ${formatBucketLabel(bucket, 'hour')}`;
  }
  return formatBucketLabel(bucket, 'day');
}

/** Start / middle / end x-axis ticks, deduped for short series. */
export function axisTicks(buckets: string[], kind: BucketKind): AxisTick[] {
  if (!buckets.length) return [];
  const idx = [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])];
  return idx.map((index) => ({ index, text: formatBucketLabel(buckets[index]!, kind) }));
}

interface Geom { x: (i: number) => number; y: (v: number) => number; h: number }

function makeGeom(count: number, yMax: number, height: number): Geom {
  return {
    x: (i) => count <= 1 ? PAD_L + (VB_W - PAD_L - PAD_R) / 2
      : PAD_L + (i * (VB_W - PAD_L - PAD_R)) / (count - 1),
    y: (v) => height - PAD_B - (v / yMax) * (height - PAD_T - PAD_B),
    h: height,
  };
}

/** Sparse-data guard placeholder ("collecting data — n samples so far"). */
function Placeholder({ n, compact }: { n: number; compact?: boolean }) {
  return (
    <div className={compact ? 'chart-placeholder compact' : 'chart-placeholder'}>
      {compact ? `collecting (${n})` : `collecting data — ${n} sample${n === 1 ? '' : 's'} so far`}
    </div>
  );
}

/** Dashed gridlines at max + mid, a solid baseline at 0, all y-labeled. */
function GridAndAxes({ geom, yMax, format, ticks, count }: {
  geom: Geom; yMax: number; format: (v: number) => string; ticks: AxisTick[]; count: number;
}) {
  const yLabel = (v: number, solid = false) => (
    <g key={`y${v}`}>
      <line x1={PAD_L} x2={VB_W - PAD_R} y1={geom.y(v)} y2={geom.y(v)}
        stroke="var(--border)" strokeDasharray={solid ? undefined : '3 4'} />
      <text x={PAD_L - 7} y={geom.y(v) + FONT / 2 - 1} textAnchor="end" fontSize={FONT}
        fill="var(--muted)">{format(v)}</text>
    </g>
  );
  return (
    <g>
      {yLabel(yMax)}
      {yLabel(yMax / 2)}
      {yLabel(0, true)}
      {ticks.map((t) => (
        <text key={`x${t.index}`} x={geom.x(t.index)} y={geom.h - 6}
          textAnchor={t.index === 0 ? 'start' : t.index === count - 1 ? 'end' : 'middle'}
          fontSize={FONT} fill="var(--muted)">{t.text}</text>
      ))}
    </g>
  );
}

/** Consecutive non-null runs of a series: [startIndex, values[]] segments. */
function segments(values: (number | null)[]): { start: number; values: number[] }[] {
  const out: { start: number; values: number[] }[] = [];
  let current: { start: number; values: number[] } | null = null;
  values.forEach((v, i) => {
    if (v == null) { current = null; return; }
    if (!current) { current = { start: i, values: [] }; out.push(current); }
    current.values.push(v);
  });
  return out;
}

/** One series' segments as polylines (runs) and circles (isolated points). */
function lineShapes(values: (number | null)[], geom: Geom, stroke: string, keyPrefix: string) {
  return segments(values).map((seg, si) => {
    if (seg.values.length === 1) {
      return <circle key={`${keyPrefix}c${si}`} cx={geom.x(seg.start)} cy={geom.y(seg.values[0]!)}
        r={3.5} fill={stroke} />;
    }
    const pts = seg.values.map((v, j) => `${geom.x(seg.start + j)},${geom.y(v)}`).join(' ');
    return <polyline key={`${keyPrefix}l${si}`} points={pts} fill="none"
      stroke={stroke} strokeWidth={2} />;
  });
}

/** Invisible hover targets carrying per-bucket `<title>` tooltips. */
function tooltipTargets(buckets: string[], geom: Geom, kind: BucketKind,
  text: (i: number) => string | null) {
  const step = buckets.length > 1 ? geom.x(1) - geom.x(0) : VB_W - PAD_L - PAD_R;
  return buckets.map((_, i) => {
    const t = text(i);
    return t == null ? null : (
      <rect key={`t${i}`} x={geom.x(i) - step / 2} y={0} width={Math.max(step, 4)} height={geom.h}
        fill="transparent">
        <title>{t}</title>
      </rect>
    );
  });
}

/**
 * Counts / single-percentile series over time: line + soft area fill down to
 * the zero baseline. `populated` overrides the sparse-data count for series
 * that were zero-filled onto the full window axis (real sample count).
 */
export function AreaSeries({ points, kind, height = 140, color = 'var(--accent)',
  format = fmt, label, populated }: {
  points: ChartPoint[]; kind: BucketKind; height?: number; color?: string;
  format?: (v: number) => string;
  /** Accessible name for the chart (aria-label). */
  label?: string;
  /** Real sample count behind the series (sparse-data guard override). */
  populated?: number;
}) {
  const values = points.map((p) => p.value);
  const present = values.filter((v): v is number => v != null);
  const n = populated ?? present.length;
  if (n < 3) return <Placeholder n={n} />;
  const yMax = Math.max(...present, 0) || 1;
  const geom = makeGeom(points.length, yMax, height);
  const yBase = geom.y(0);
  return (
    <svg className="chart-svg" width="100%" viewBox={`0 0 ${VB_W} ${height}`}
      role="img" aria-label={label}>
      <GridAndAxes geom={geom} yMax={yMax} format={format}
        ticks={axisTicks(points.map((p) => p.bucket), kind)} count={points.length} />
      {segments(values).map((seg, si) => {
        if (seg.values.length === 1) return null; // the dot from lineShapes suffices
        const top = seg.values.map((v, j) => `${geom.x(seg.start + j)},${geom.y(v)}`).join(' ');
        const closing = `${geom.x(seg.start + seg.values.length - 1)},${yBase} ${geom.x(seg.start)},${yBase}`;
        return <polygon key={`a${si}`} points={`${top} ${closing}`} fill={color} fillOpacity={0.14} />;
      })}
      {lineShapes(values, geom, color, 's')}
      {tooltipTargets(points.map((p) => p.bucket), geom, kind, (i) =>
        points[i]!.value == null ? null
          : `${formatBucketTooltip(points[i]!.bucket, kind)}: ${format(points[i]!.value!)}`)}
    </svg>
  );
}

/**
 * Percentile series with spread: solid p50 line + shaded p50→p90 band (same
 * visual language as the Gantt expected-duration band). `compact` renders a
 * small fixed-size variant for table cells (no axes, no caption).
 */
export function BandSeries({ points, kind, height = 140, color = 'var(--accent)',
  format = fmt, label, compact = false }: {
  points: BandPoint[]; kind: BucketKind; height?: number; color?: string;
  format?: (v: number) => string; label?: string; compact?: boolean;
}) {
  const p50s = points.map((p) => p.p50);
  const n = p50s.filter((v) => v != null).length;
  if (n < 3) return <Placeholder n={n} compact={compact} />;
  const present = points.flatMap((p) => [p.p50, p.p90]).filter((v): v is number => v != null);
  const yMax = Math.max(...present, 0) || 1;

  const W = compact ? 120 : VB_W;
  const H = compact ? 26 : height;
  const padL = compact ? 2 : PAD_L; const padR = compact ? 2 : PAD_R;
  const padT = compact ? 3 : PAD_T; const padB = compact ? 3 : PAD_B;
  const geom: Geom = {
    x: (i) => points.length <= 1 ? padL + (W - padL - padR) / 2
      : padL + (i * (W - padL - padR)) / (points.length - 1),
    y: (v) => H - padB - (v / yMax) * (H - padT - padB),
    h: H,
  };

  // Band polygons per contiguous run where BOTH p50 and p90 are present:
  // top edge follows p90 left→right, bottom edge follows p50 right→left.
  const bandIdx = points.map((p, i) => (p.p50 != null && p.p90 != null ? i : null));
  const bandRuns: number[][] = [];
  let run: number[] = [];
  for (const i of bandIdx) {
    if (i == null) { if (run.length) { bandRuns.push(run); run = []; } continue; }
    run.push(i);
  }
  if (run.length) bandRuns.push(run);

  const svg = (
    <svg className={compact ? 'chart-svg-compact' : 'chart-svg'}
      width={compact ? W : '100%'} height={compact ? H : undefined}
      viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {!compact && (
        <GridAndAxes geom={geom} yMax={yMax} format={format}
          ticks={axisTicks(points.map((p) => p.bucket), kind)} count={points.length} />
      )}
      {bandRuns.map((idxs, bi) => {
        const top = idxs.map((i) => `${geom.x(i)},${geom.y(points[i]!.p90!)}`).join(' ');
        const back = [...idxs].reverse().map((i) => `${geom.x(i)},${geom.y(points[i]!.p50!)}`).join(' ');
        return <polygon key={`b${bi}`} points={`${top} ${back}`}
          fill={color} fillOpacity={0.18} stroke={color} strokeOpacity={0.25} strokeWidth={1} />;
      })}
      {lineShapes(p50s, geom, color, 'p')}
      {tooltipTargets(points.map((p) => p.bucket), geom, kind, (i) => {
        const pt = points[i]!;
        if (pt.p50 == null) return null;
        const spread = pt.p90 != null ? ` (p90 ${format(pt.p90)})` : '';
        return `${formatBucketTooltip(pt.bucket, kind)}: p50 ${format(pt.p50)}${spread}`;
      })}
    </svg>
  );
  if (compact) return svg;
  return (
    <div className="chart-frame">
      {svg}
      <div className="chart-caption">line = p50 · band = p50–p90</div>
    </div>
  );
}

/**
 * Signed series over time (values may be negative) — the calibration panel's
 * median-ETA-error trend. The zero gridline is the semantic anchor ("perfectly
 * calibrated") and renders emphasized (solid, full-strength stroke, marked
 * `data-zero-gridline`); the extremes get the usual dashed treatment.
 */
export function SignedLine({ points, kind, height = 140, color = 'var(--accent)',
  format = fmt, label }: {
  points: ChartPoint[]; kind: BucketKind; height?: number; color?: string;
  format?: (v: number) => string; label?: string;
}) {
  const values = points.map((p) => p.value);
  const present = values.filter((v): v is number => v != null);
  if (present.length < 3) return <Placeholder n={present.length} />;
  const yMax = Math.max(...present, 0);
  const yMin = Math.min(...present, 0);
  const span = (yMax - yMin) || 1;
  const geom: Geom = {
    x: (i) => points.length <= 1 ? PAD_L + (VB_W - PAD_L - PAD_R) / 2
      : PAD_L + (i * (VB_W - PAD_L - PAD_R)) / (points.length - 1),
    y: (v) => height - PAD_B - ((v - yMin) / span) * (height - PAD_T - PAD_B),
    h: height,
  };
  const gridline = (v: number, zero = false) => (
    <g key={`y${v}${zero ? 'z' : ''}`}>
      <line x1={PAD_L} x2={VB_W - PAD_R} y1={geom.y(v)} y2={geom.y(v)}
        stroke={zero ? 'var(--muted)' : 'var(--border)'}
        strokeDasharray={zero ? undefined : '3 4'}
        {...(zero ? { 'data-zero-gridline': 'true' } : {})} />
      <text x={PAD_L - 7} y={geom.y(v) + FONT / 2 - 1} textAnchor="end" fontSize={FONT}
        fill="var(--muted)">{format(v)}</text>
    </g>
  );
  const ticks = axisTicks(points.map((p) => p.bucket), kind);
  return (
    <div className="chart-frame">
      <svg className="chart-svg" width="100%" viewBox={`0 0 ${VB_W} ${height}`}
        role="img" aria-label={label}>
        {yMax > 0 && gridline(yMax)}
        {yMin < 0 && gridline(yMin)}
        {gridline(0, true)}
        {ticks.map((t) => (
          <text key={`x${t.index}`} x={geom.x(t.index)} y={geom.h - 6}
            textAnchor={t.index === 0 ? 'start' : t.index === points.length - 1 ? 'end' : 'middle'}
            fontSize={FONT} fill="var(--muted)">{t.text}</text>
        ))}
        {lineShapes(values, geom, color, 's')}
        {tooltipTargets(points.map((p) => p.bucket), geom, kind, (i) =>
          points[i]!.value == null ? null
            : `${formatBucketTooltip(points[i]!.bucket, kind)}: ${format(points[i]!.value!)}`)}
      </svg>
      <div className="chart-caption">0 = on target · above 0 = ran past the ETA</div>
    </div>
  );
}

export interface ScatterPoint { predicted: number; actual: number }

/**
 * Compact predicted-vs-actual scatter (calibration panel). Both axes share one
 * scale, so the diagonal (`data-diagonal`) is the perfect-calibration line —
 * points ABOVE it took longer than promised, points below finished early.
 */
export function ScatterPlot({ points, format = fmt, label, height = 200 }: {
  points: ScatterPoint[]; format?: (v: number) => string; label?: string; height?: number;
}) {
  if (points.length < 3) return <Placeholder n={points.length} />;
  const W = 380;
  const padT = 8; const padR = 12;
  const max = Math.max(...points.flatMap((p) => [p.predicted, p.actual]), 0) || 1;
  const x = (v: number): number => PAD_L + (v / max) * (W - PAD_L - padR);
  const y = (v: number): number => height - PAD_B - (v / max) * (height - padT - PAD_B);
  const axisLabel = (v: number) => (
    <g key={`a${v}`}>
      <text x={PAD_L - 7} y={y(v) + FONT / 2 - 1} textAnchor="end" fontSize={FONT}
        fill="var(--muted)">{format(v)}</text>
      <text x={x(v)} y={height - 6} textAnchor={v === 0 ? 'start' : 'end'} fontSize={FONT}
        fill="var(--muted)">{format(v)}</text>
    </g>
  );
  return (
    <div className="chart-frame">
      <svg className="chart-svg chart-scatter" width={W} height={height}
        viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label}>
        <line x1={PAD_L} x2={W - padR} y1={y(0)} y2={y(0)} stroke="var(--border)" />
        <line x1={PAD_L} x2={PAD_L} y1={padT} y2={y(0)} stroke="var(--border)" />
        {axisLabel(0)}
        {axisLabel(max)}
        <line data-diagonal="true" x1={x(0)} y1={y(0)} x2={x(max)} y2={y(max)}
          stroke="var(--muted)" strokeDasharray="4 4" />
        {points.map((p, i) => (
          <circle key={`p${i}`} cx={x(p.predicted)} cy={y(p.actual)} r={3}
            fill="var(--accent)" fillOpacity={0.55}>
            <title>{`predicted ${format(p.predicted)} → actual ${format(p.actual)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="chart-caption">x = predicted · y = actual · dashes = perfect · above = took longer</div>
    </div>
  );
}

/**
 * Several aligned series on one shared scale, with a color-chip legend —
 * the Trends panel's open/ci/queue/failed multi-line chart.
 */
export function MultiLine({ series, kind, height = 160, format = fmt, label }: {
  series: LineSeries[]; kind: BucketKind; height?: number;
  format?: (v: number) => string; label?: string;
}) {
  const count = Math.max(...series.map((s) => s.points.length), 0);
  const buckets = (series[0]?.points ?? []).map((p) => p.bucket);
  // populated = buckets where ANY series has a value
  const populated = buckets.filter((_, i) =>
    series.some((s) => s.points[i]?.value != null)).length;
  if (populated < 3) return <Placeholder n={populated} />;
  const present = series.flatMap((s) => s.points)
    .map((p) => p.value).filter((v): v is number => v != null);
  const yMax = Math.max(...present, 0) || 1;
  const geom = makeGeom(count, yMax, height);
  return (
    <div className="chart-frame">
      <svg className="chart-svg" width="100%" viewBox={`0 0 ${VB_W} ${height}`}
        role="img" aria-label={label}>
        <GridAndAxes geom={geom} yMax={yMax} format={format}
          ticks={axisTicks(buckets, kind)} count={count} />
        {series.map((s, si) => lineShapes(s.points.map((p) => p.value), geom, s.color, `s${si}`))}
        {tooltipTargets(buckets, geom, kind, (i) => {
          const parts = series.flatMap((s) =>
            s.points[i]?.value == null ? [] : [`${s.name} ${format(s.points[i]!.value!)}`]);
          return parts.length ? `${formatBucketTooltip(buckets[i]!, kind)} — ${parts.join(' · ')}` : null;
        })}
      </svg>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.name} className="legend-item">
            <i className="legend-chip" style={{ background: s.color }} aria-hidden="true" />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
