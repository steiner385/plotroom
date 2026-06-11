import { Fragment } from 'react';
import type { CheckView, StageAccuracy } from './types';
import { formatDur } from './format';

type RowKind = 'done' | 'running' | 'overdue' | 'failed' | 'queued' | 'skipped';

/** Bar scale for the panel: the longest check (elapsed, expected, or its p90
 *  upper bound) defines 100% — so the p10–p90 band never overflows a bar. */
export function ganttScale(checks: CheckView[]): number {
  const max = checks.reduce(
    (acc, c) => Math.max(acc, c.elapsedSeconds ?? 0, c.expectedSeconds ?? 0, c.expectedHighSeconds ?? 0), 0);
  return max > 0 ? max : 60;
}

function rowKind(c: CheckView): RowKind {
  if (c.status !== 'COMPLETED') {
    if (c.elapsedSeconds == null) return 'queued';
    return c.expectedSeconds != null && c.elapsedSeconds > c.expectedSeconds ? 'overdue' : 'running';
  }
  if (c.conclusion === 'SUCCESS') return 'done';
  if (c.conclusion === 'SKIPPED') return 'skipped';
  return 'failed';
}

function timeText(c: CheckView, kind: RowKind): string {
  const elapsed = c.elapsedSeconds != null ? formatDur(c.elapsedSeconds) : '';
  switch (kind) {
    case 'done': return elapsed ? `${elapsed} ✓` : '✓';
    case 'failed': return elapsed ? `${elapsed} ✗` : '✗';
    case 'skipped': return '–';
    case 'queued': {
      if (c.waitKind === 'blocked') {
        // graph nodes for reusable workflows carry a ' /' suffix — cosmetic-trim it
        return `⊘ blocked on ${(c.blockedOn ?? '?').replace(/ \/$/, '')}`;
      }
      if (c.waitKind === 'runner') {
        if (c.waitingSeconds == null) return '⧗ waiting for runner';
        const dur = formatDur(c.waitingSeconds);
        const typical = c.expectedRunnerWaitSeconds != null
          ? ` (typical ~${formatDur(c.expectedRunnerWaitSeconds)})` : '';
        return `⧗ waiting for runner · ${dur}${typical}`;
      }
      return '—';
    }
    case 'overdue': return `${elapsed} ⚠ overdue`;
    case 'running':
      return c.expectedSeconds != null ? `${elapsed} / ~${formatDur(c.expectedSeconds)}` : elapsed;
  }
}

function GanttRow({ c, scale }: { c: CheckView; scale: number }) {
  const kind = rowKind(c);
  const fillPct = kind === 'queued'
    ? 15
    : Math.min(100, ((c.elapsedSeconds ?? 0) / scale) * 100);

  // For runner-wait queued rows, determine extra CSS class
  const isRunnerWait = kind === 'queued' && c.waitKind === 'runner';
  const isAmber = isRunnerWait
    && c.waitingSeconds != null
    && c.expectedRunnerWaitSeconds != null
    && c.waitingSeconds > 2 * c.expectedRunnerWaitSeconds;
  const extraClass = isRunnerWait ? (isAmber ? ' g-runner-wait g-runner-wait-amber' : ' g-runner-wait') : '';

  // p10–p90 expected-duration band: only when both bounds are known
  const hasBand = c.expectedLowSeconds != null && c.expectedHighSeconds != null;
  const barTitle = hasBand && c.expectedSeconds != null
    ? `expected ~${formatDur(c.expectedSeconds)} (p10 ${formatDur(c.expectedLowSeconds!)} – p90 ${formatDur(c.expectedHighSeconds!)})`
    : undefined;

  return (
    <li className={`g-row g-${kind}${extraClass}`}>
      <span className="g-name">
        {c.url
          ? <a href={c.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{c.name}</a>
          : <span>{c.name}</span>}
      </span>
      <span className="g-bar" title={barTitle}>
        {hasBand && (() => {
          const lowPct = Math.min(100, (c.expectedLowSeconds! / scale) * 100);
          const highPct = Math.min(100, (c.expectedHighSeconds! / scale) * 100);
          return <span className="band" style={{ left: `${lowPct}%`, width: `${highPct - lowPct}%` }} />;
        })()}
        <i style={{ width: `${fillPct}%` }} />
        {c.expectedSeconds != null && (() => {
          const pct = Math.min(100, (c.expectedSeconds / scale) * 100);
          return <span className="exp" style={{ left: pct >= 100 ? 'calc(100% - 2px)' : `${pct}%` }} />;
        })()}
      </span>
      <span className="g-t">{timeText(c, kind)}</span>
    </li>
  );
}

interface WorkflowGroup { name: string | null; checks: CheckView[] }

/**
 * Group checks by workflowName, preserving first-seen order within a rank:
 * workflows that carry required checks first (the rollup workflow — required
 * status is workflow-scoped server-side), then foreign workflows (inherently
 * advisory), with the null-workflow group last ('other checks': old data
 * without workflow identity).
 */
export function groupByWorkflow(checks: CheckView[]): WorkflowGroup[] {
  const order: (string | null)[] = [];
  const byName = new Map<string | null, CheckView[]>();
  for (const c of checks) {
    if (!byName.has(c.workflowName)) { byName.set(c.workflowName, []); order.push(c.workflowName); }
    byName.get(c.workflowName)!.push(c);
  }
  const rank = (g: WorkflowGroup) =>
    (g.checks.some((c) => c.isRequired) ? 0 : 2) + (g.name === null ? 1 : 0);
  return order.map((name) => ({ name, checks: byName.get(name)! }))
    .sort((a, b) => rank(a) - rank(b)); // stable: first-seen order within a rank
}

/** Expanded-panel check list as horizontal Gantt bars (required, advisory below
 *  the divider) with the ETA-accuracy footer retained at the bottom.
 *
 *  When checks span multiple workflows, rows group under a muted header per
 *  workflow (null last as 'other checks'); the required→advisory ordering is
 *  kept within the leading (rollup) workflow and foreign workflows render in
 *  the advisory zone under their own headers. One shared time scale spans the
 *  whole panel. A single-workflow panel renders exactly as before (no headers). */
export function CheckGantt({ checks, stage, accuracy }: {
  checks: CheckView[]; stage: string; accuracy?: StageAccuracy;
}) {
  const scale = ganttScale(checks);
  const groups = groupByWorkflow(checks);
  const grouped = groups.length > 1;
  const anyAdvisory = checks.some((c) => !c.isRequired);
  return (
    <ul className="checks gantt">
      {groups.map((g, gi) => {
        const required = g.checks.filter((c) => c.isRequired);
        const advisory = g.checks.filter((c) => !c.isRequired);
        return (
          <Fragment key={`wf-${gi}`}>
            {grouped && <li className="divider g-workflow">{g.name ?? 'other checks'}</li>}
            {required.map((c, i) => <GanttRow key={`${c.name}-${i}`} c={c} scale={scale} />)}
            {gi === 0 && anyAdvisory && <li className="divider">advisory</li>}
            {advisory.map((c, i) => <GanttRow key={`${c.name}-${i}`} c={c} scale={scale} />)}
          </Fragment>
        );
      })}
      {accuracy && (
        <li className="eta-accuracy">
          ETA accuracy ({stage}): typically {formatAbsErr(accuracy.medianAbsErrSecs)} (n={accuracy.n})
        </li>
      )}
    </ul>
  );
}

/** Sub-minute errors render in seconds (`±45s`) — `±0m` reads as "perfect". */
export function formatAbsErr(secs: number): string {
  return secs < 60 ? `±${Math.round(secs)}s` : `±${Math.round(secs / 60)}m`;
}
