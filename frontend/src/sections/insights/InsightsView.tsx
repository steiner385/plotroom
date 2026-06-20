// Insights section (roadmap WS3a) — the analytics + retrospect home. Folds the old
// Metrics tab (cost/queue/runners/flake/lead-time + ranked tuning actions) and the
// old Tune tab (budgets/policy/outcomes/changelog) into ONE section, removing the IA
// overlap both reviewers flagged ("Tuning" lived in Metrics while "Tune" was empty).
//
// #184: the two stack as a top-level two-tab layout — Analytics (the time-series
// metrics) vs Tuning & Policy (budgets/policy/outcomes/changelog) — so the section
// reads as one coherent IA instead of one undifferentiated scroll. Both tabpanels
// stay mounted (hidden when inactive) to preserve their internal state.
//
// MetricsView is code-split: its 1 500-line bundle + the /api/metrics fetch are deferred
// until the user actually opens the Insights section (React.lazy + Suspense).
import { lazy, Suspense, useState } from 'react';
import { TuneView } from '../tune/TuneView';
import { Skeleton } from '../../shell/Skeleton';
import type { WorkspaceApi } from '../../shell/workspaceApi';

const MetricsView = lazy(() =>
  import('../../MetricsView').then((m) => ({ default: m.MetricsView })),
);

type InsightsTab = 'analytics' | 'tuning';

export function InsightsView({ repo, api }: { repo: string | null; api: WorkspaceApi }) {
  const [tab, setTab] = useState<InsightsTab>('analytics');
  const isAnalytics = tab === 'analytics';
  return (
    <div className="insights-view">
      <h2 className="sr-only">Insights</h2>
      {/* outer tabs reuse the metrics sub-tab styling (no new CSS) */}
      <div className="metrics-subtabs" role="tablist" aria-label="Insights view">
        <button type="button" role="tab" id="insights-tab-analytics"
          aria-selected={isAnalytics} aria-controls="insights-panel-analytics"
          className={`metrics-subtab${isAnalytics ? ' active' : ''}`}
          onClick={() => setTab('analytics')}>Analytics</button>
        <button type="button" role="tab" id="insights-tab-tuning"
          aria-selected={!isAnalytics} aria-controls="insights-panel-tuning"
          className={`metrics-subtab${!isAnalytics ? ' active' : ''}`}
          onClick={() => setTab('tuning')}>Tuning &amp; Policy</button>
      </div>
      <div id="insights-panel-analytics" role="tabpanel" aria-labelledby="insights-tab-analytics"
        hidden={!isAnalytics}>
        <Suspense fallback={<Skeleton height={400} />}>
          <MetricsView />
        </Suspense>
      </div>
      <div id="insights-panel-tuning" role="tabpanel" aria-labelledby="insights-tab-tuning"
        hidden={isAnalytics}>
        <TuneView repo={repo} api={api} />
      </div>
    </div>
  );
}
