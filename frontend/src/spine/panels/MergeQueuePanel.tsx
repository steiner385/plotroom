import type { DashboardState } from '../../types';
import { QueueTrain } from '../../QueueTrain';

/** Drill-down for the Merge queue lane: the existing QueueTrain, one per repo
 *  that currently has a queue. Pure reuse — no reimplementation. */
export function MergeQueuePanel({ repos }: { repos: DashboardState['repos'] }) {
  const active = repos.filter((r) => r.queue);
  if (active.length === 0) return <p className="spine-panel-empty">Queue is empty.</p>;
  return (
    <div className="spine-queue-list">
      {active.map((r) => (
        <div key={r.repo} data-testid={`spine-queue-${r.repo}`}>
          {active.length > 1 && <div className="spine-panel-label">{r.repo}</div>}
          <QueueTrain queue={r.queue} />
        </div>
      ))}
    </div>
  );
}
