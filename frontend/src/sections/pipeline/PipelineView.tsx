// Pipeline section — the original PR pipeline view, ported into the unified
// workspace IA. Reuses the existing PrRow / QueueTrain / StatusStrip verbatim so
// the rich per-PR rows (stage, queue, checks, ready+auto-merge actions) and the
// status filter are identical to the classic dashboard; only the framing (focused
// repo first, no kiosk branch) is workspace-native. Data is the live Tier-1 state.
import { useState } from 'react';
import type { DashboardState, PrView } from '../../types';
import { PrRow } from '../../PrRow';
import { QueueTrain } from '../../QueueTrain';
import { StatusStrip, bucketPr, type Bucket } from '../../StatusStrip';

function isActive(pr: PrView): boolean {
  const { stage } = pr.stage;
  return stage === 'ci' || stage === 'queue' || stage === 'qa-deploy';
}
function isFailed(pr: PrView): boolean {
  const { stage, substate } = pr.stage;
  return (stage === 'parked' && substate === 'ci-failed') || (stage === 'queue' && substate === 'group-failed');
}

export function PipelineView({ state, focusedRepo }: { state: DashboardState | null; focusedRepo: string | null }) {
  const [activeFilter, setActiveFilter] = useState<Bucket | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (!state) return <div className="pipeline-view" role="status">Loading pipeline…</div>;

  // focused repo first (stable otherwise) — the workspace's "current pipeline" lead
  const repos = [...state.repos].sort((a, b) => (a.repo === focusedRepo ? -1 : b.repo === focusedRepo ? 1 : 0));
  const allPrs = repos.flatMap((r) => r.prs);
  const toggle = (repo: string) => setCollapsed((p) => { const n = new Set(p); n.has(repo) ? n.delete(repo) : n.add(repo); return n; });

  return (
    <div className="pipeline-view">
      <StatusStrip prs={allPrs} activeFilter={activeFilter} onFilter={setActiveFilter} />
      {repos.map((r) => {
        const isCollapsed = collapsed.has(r.repo);
        const visiblePrs = activeFilter ? r.prs.filter((pr) => bucketPr(pr) === activeFilter) : r.prs;
        const hiddenCount = r.prs.length - visiblePrs.length;
        const activeCount = r.prs.filter(isActive).length;
        const failedCount = r.prs.filter(isFailed).length;
        return (
          <section key={r.repo}>
            <h2 className="repo-header">
              <button type="button" className="repo-header-btn" aria-expanded={!isCollapsed} onClick={() => toggle(r.repo)}>
                <span aria-hidden="true" className="repo-chevron">{isCollapsed ? '▸' : '▾'}</span>
                {r.repo}
                {!isCollapsed && hiddenCount > 0 && <span className="hidden-count"> ({hiddenCount} hidden)</span>}
                {isCollapsed && (
                  <span className="repo-summary">
                    <span className="repo-summary-prs">{r.prs.length} PRs</span>
                    {activeCount > 0 && <span className="repo-summary-active"> · {activeCount} active</span>}
                    {failedCount > 0 && <span className="repo-summary-failed"> · {failedCount} failed</span>}
                  </span>
                )}
              </button>
            </h2>
            {!isCollapsed && (
              <>
                <QueueTrain queue={r.queue} />
                {visiblePrs.length === 0 && hiddenCount === 0 && <p className="empty">no active PRs</p>}
                {visiblePrs.map((pr) => (
                  <PrRow key={pr.number} pr={pr} hasDeploy={r.hasDeploy}
                    queueCulprit={r.queue?.unmergeableCulprit ?? null} expandable />
                ))}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
