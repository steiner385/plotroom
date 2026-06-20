// Pure model logic for MetricsView (#183 decomposition): the window/bucket axis math,
// the sparse-row → full-axis alignment helpers that feed every chart, the headline /
// formatter helpers, and the section + recommendation-deep-link vocabulary. Extracted
// verbatim from MetricsView.tsx so the (large) component holds only React, and so the
// chart-alignment math — the trickiest, most regression-prone logic here — is unit
// testable in isolation.
import type { HeadlineStat, MetricsBucket, MetricsWindow } from './types';
import type { BandPoint, ChartPoint } from './charts';
import { formatDur } from './format';

export const WINDOWS = ['24h', '3d', '7d', '14d', '30d'] as const;
export const WINDOW_DAYS: Record<MetricsWindow, number> = {
  '24h': 1, '3d': 3, '7d': 7, '14d': 14, '30d': 30,
};
/** Mirrors the server clamp: hour buckets only for windows ≤ 7 days. */
export const HOUR_BUCKET_MAX_DAYS = 7;

/** The window's full bucket axis (UTC keys), oldest first. */
export function windowBuckets(window: MetricsWindow, bucket: MetricsBucket, now: Date): string[] {
  const days = WINDOW_DAYS[window];
  const out: string[] = [];
  if (bucket === 'day') {
    for (let i = days - 1; i >= 0; i--) {
      out.push(new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10));
    }
  } else {
    for (let i = days * 24 - 1; i >= 0; i--) {
      out.push(new Date(now.getTime() - i * 3600_000).toISOString().slice(0, 13));
    }
  }
  return out;
}

/** Align sparse buckets onto the full window axis; missing buckets → null gaps. */
export function align<T extends { bucket: string }>(axis: string[], rows: T[],
  pick: (r: T) => number): ChartPoint[] {
  const by = new Map(rows.map((r) => [r.bucket, pick(r)]));
  return axis.map((bucket) => ({ bucket, value: by.get(bucket) ?? null }));
}

/** Count series: missing buckets are real zeroes, not gaps. */
export function alignCounts(axis: string[], rows: { bucket: string; count: number }[]): ChartPoint[] {
  const by = new Map(rows.map((r) => [r.bucket, r.count]));
  return axis.map((bucket) => ({ bucket, value: by.get(bucket) ?? 0 }));
}

/** p50/p90 buckets onto the full axis for the band charts. */
export function alignBand(axis: string[], rows: { bucket: string; p50: number; p90?: number }[]): BandPoint[] {
  const by = new Map(rows.map((r) => [r.bucket, r]));
  return axis.map((bucket) => {
    const r = by.get(bucket);
    return { bucket, p50: r?.p50 ?? null, p90: r?.p90 ?? null };
  });
}

/** "+50% vs prev" / "≈ prev"; null when the delta isn't computable. */
export function deltaText(stat: HeadlineStat): string | null {
  if (stat.value == null || stat.prev == null || stat.prev === 0) return null;
  const pct = Math.round(((stat.value - stat.prev) / stat.prev) * 100);
  if (pct === 0) return '≈ prev';
  return `${pct > 0 ? '+' : ''}${pct}% vs prev`;
}

export const fmtHours = (h: number): string => formatDur(h * 3600);
export const fmtCount = (v: number): string => String(Math.round(v));
export const fmtPct = (v: number): string => `${Math.round(v)}%`;
/** Runner-minutes (issue #43): whole minutes ≥ 10, one decimal below. */
export const fmtMinutes = (m: number): string =>
  m >= 10 ? `${Math.round(m)}m` : `${Math.round(m * 10) / 10}m`;
export const fmtDollars = (d: number): string => `$${d.toFixed(2)}`;

/** Line colors for the per-pool cost series (cycled when pools outnumber them). */
export const POOL_COLORS = ['var(--accent)', 'var(--amber)', 'var(--purple)', 'var(--fail)', 'var(--done)'];

/**
 * Calibration headline: signed median error → plain English. POSITIVE error
 * means stages took longer than first promised (ETAs run optimistic).
 */
export function calibrationHeadline(medianErrorPct: number, n: number): string {
  const pct = Math.round(Math.abs(medianErrorPct));
  if (pct === 0) return `p50 ETAs on target (n=${n})`;
  return `p50 ETAs run ${pct}% ${medianErrorPct > 0 ? 'optimistic' : 'pessimistic'} (n=${n})`;
}

// ---- Metrics sub-tabs (page cleanup): group the 20+ panels into 5 sections,
// each rendered on its own sub-tab so the page isn't one endless scroll.
export type MetricsSection = 'tuning' | 'throughput' | 'performance' | 'reliability' | 'cost';
export const METRICS_SECTIONS: { id: MetricsSection; label: string }[] = [
  { id: 'tuning', label: 'Tuning' },
  { id: 'throughput', label: 'Throughput & queue' },
  { id: 'performance', label: 'Performance' },
  { id: 'reliability', label: 'Reliability' },
  { id: 'cost', label: 'Cost' },
];
export const SECTION_STORAGE_KEY = 'prdash.metrics.section';

/** Read + validate the persisted section from localStorage; returns 'tuning' as
 *  the default. Called by BOTH the `section` and `everActivated` useState lazy
 *  initialisers so the localStorage read is shared rather than duplicated. */
export function resolveInitialSection(): MetricsSection {
  try {
    const s = localStorage.getItem(SECTION_STORAGE_KEY);
    if (s && METRICS_SECTIONS.some((x) => x.id === s)) return s as MetricsSection;
  } catch { /* private mode */ }
  // Default to the ranked Tuning Actions — the one panel that says what to fix
  // — rather than a data section, when there's no remembered preference (UX-M3).
  return 'tuning';
}

/** Deep-link a Tuning recommendation to the panel that is its evidence (UX-M4):
 *  the section to switch to + the panel id to scroll/focus. lint:* kinds all map
 *  to the workflow-lint panel (handled by prefix in resolveRecLink). */
const REC_LINK: Record<string, { section: MetricsSection; panel: string }> = {
  'batch-size': { section: 'throughput', panel: 'metrics-batch-advisor' },
  'admin-bypass': { section: 'throughput', panel: 'metrics-queue-efficiency' },
  'advisory-in-merge-group': { section: 'throughput', panel: 'metrics-queue-efficiency' },
  'set-required-prefixes': { section: 'throughput', panel: 'metrics-queue-efficiency' },
};
export function resolveRecLink(kind: string): { section: MetricsSection; panel: string } | null {
  return REC_LINK[kind] ?? (kind.startsWith('lint:')
    ? { section: 'reliability', panel: 'metrics-workflow-lint' } : null);
}
