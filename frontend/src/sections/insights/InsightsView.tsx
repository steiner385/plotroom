// Insights section (roadmap WS3a) — the analytics + retrospect home. Folds the old
// Metrics tab (cost/queue/runners/flake/lead-time + ranked tuning actions) and the
// old Tune tab (budgets/policy/outcomes/changelog) into ONE section, removing the IA
// overlap both reviewers flagged ("Tuning" lived in Metrics while "Tune" was empty).
// Pure composition of the two existing, already-tested surfaces.
//
// MetricsView is code-split: its 1 500-line bundle + the /api/metrics fetch are deferred
// until the user actually opens the Insights section (React.lazy + Suspense).
import { lazy, Suspense } from 'react';
import { TuneView } from '../tune/TuneView';
import type { WorkspaceApi } from '../../shell/workspaceApi';

const MetricsView = lazy(() =>
  import('../../MetricsView').then((m) => ({ default: m.MetricsView })),
);

export function InsightsView({ repo, api }: { repo: string | null; api: WorkspaceApi }) {
  return (
    <div className="insights-view">
      <Suspense fallback={<div role="status">Loading metrics…</div>}>
        <MetricsView />
      </Suspense>
      <TuneView repo={repo} api={api} />
    </div>
  );
}
