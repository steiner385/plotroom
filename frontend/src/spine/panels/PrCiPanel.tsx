import type { DashboardState } from '../../types';
import { PrRow } from '../../PrRow';

/** Condensed drill-down for the PR CI lane: every PR currently in the `ci`
 *  stage, failed ones first, rendered with the existing PrRow (read-only). */
export function PrCiPanel({ repos }: { repos: DashboardState['repos'] }) {
  const rows = repos.flatMap((r) => r.prs
    .filter((p) => p.stage?.stage === 'ci')
    .map((p) => ({ pr: p, hasDeploy: r.hasDeploy })));
  if (rows.length === 0) return <p className="spine-panel-empty">No PRs in CI.</p>;
  rows.sort((a, b) =>
    (a.pr.stage?.substate === 'ci-failed' ? 0 : 1) - (b.pr.stage?.substate === 'ci-failed' ? 0 : 1));
  return (
    <div className="spine-prci-list">
      {rows.map(({ pr, hasDeploy }) => (
        <div key={`${pr.repo}#${pr.number}`} data-testid={`spine-prci-row-${pr.number}`}>
          <PrRow pr={pr} hasDeploy={hasDeploy} expandable={false} />
        </div>
      ))}
    </div>
  );
}
