// Shared MetricsView presentation primitives (#183 decomposition): the section
// lazy-render contexts and the small reusable building blocks (Panel / MetricStat /
// ChartBlock). Extracted from MetricsView.tsx so the (large) component imports these
// rather than defining them inline; the contexts live here so a panel can read the
// active section without MetricsView having to thread props through every panel.
import { createContext, useContext, useId, type ReactNode } from 'react';
import type { MetricsSection } from './metricsModel';
import { Skeleton } from './shell/Skeleton';
import { defTitle, type Definition } from './definitions';
import { TrendArrow } from './TrendArrow';
import type { Trend } from './lib/trend';

export const ActiveSectionContext = createContext<MetricsSection>('tuning');
/** Tracks which sections have ever been activated (used for lazy rendering). */
export const EverActivatedContext = createContext<ReadonlySet<MetricsSection>>(new Set(['tuning']));

export function Panel({ id, title, empty, emptyText = 'no data yet', section, children }: {
  id?: string; title: string; empty: boolean; emptyText?: string;
  /** Which metrics sub-tab this panel belongs to; hidden unless that tab is active. */
  section: MetricsSection; children: ReactNode;
}) {
  const active = useContext(ActiveSectionContext);
  const everActivated = useContext(EverActivatedContext);
  // Hide inactive sections with a CSS class (display:none) rather than the
  // `hidden` attribute — display:none hides from screen readers too (correct for
  // an inactive tab), and it keeps the panels in the DOM for one-payload data.
  //
  // Lazy rendering (issue #179): a panel that has NEVER been the active section
  // skips rendering its heavy chart content — only the <section> shell + heading
  // are emitted. Once activated, the panel stays mounted even when inactive so
  // the display:none + a11y behaviour is unchanged.
  const contentReady = section === active || everActivated.has(section);
  return (
    <section className={`metric-panel${section === active ? '' : ' metric-panel--inactive'}`}
      id={id} data-section={section}>
      <h2 tabIndex={id ? -1 : undefined}>{title}</h2>
      {empty
        ? <p className="metric-empty">{emptyText}</p>
        /* #188: a never-activated panel reserves height with a skeleton instead
           of collapsing to 0, so first activation doesn't jump the layout. */
        : (contentReady ? children : <Skeleton height={200} />)}
    </section>
  );
}

export function MetricStat({ label, value, delta, trend, def }: {
  label: string; value: string; delta?: string | null;
  /** Delta-vs-baseline trend (#258); renders the shared arrow next to the value
   *  (nothing when flat/insignificant). For stats carrying a `{value, prev}` baseline. */
  trend?: Trend;
  /** What this figure means / how it's computed (issue #66) — every headline
   *  stat must carry one; rendered as the mouse tooltip AND, for screen-reader
   *  users who can't reach a title=, an aria-describedby hidden description (UX-M1). */
  def: Definition;
}) {
  const descId = useId();
  return (
    <div className="metric-stat" title={defTitle(def)} aria-describedby={descId}>
      <b>{value}{trend && <TrendArrow trend={trend} />}</b>
      <span>{label}</span>
      {delta != null && <em className="metric-delta">{delta}</em>}
      <span id={descId} className="sr-only">{defTitle(def)}</span>
    </div>
  );
}

/** Labeled full-width chart block inside a repo sub-section. */
export function ChartBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="metric-chart-block">
      <span className="metric-label">{label}</span>
      {children}
    </div>
  );
}
