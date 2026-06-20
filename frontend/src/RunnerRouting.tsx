import { useEffect, useState } from 'react';
import { useApiBase } from './embed/ApiBaseContext';
import type { RunnerPlanResponse, PlanRow } from './types';
import { formatSince } from './format';

// ---- helpers ----------------------------------------------------------------

/** Human-readable decision label (text, not color alone). */
function decisionLabel(decision: PlanRow['decision']): string {
  return decision === 'kindash-arc-spot' ? 'spot' : 'on-demand';
}

/**
 * Derive the "current state" for the three-state toggle:
 * - If the row has source 'override' and decision matches a specific choice,
 *   that override button is pressed.
 * - If source is 'auto', the "auto" button is pressed.
 */
function overrideState(row: PlanRow): 'spot' | 'ondemand' | 'auto' {
  if (row.source === 'override') {
    return row.decision === 'kindash-arc-spot' ? 'spot' : 'ondemand';
  }
  return 'auto';
}

/** Group plan rows by their owning workflow, preserving first-seen order (both
 *  of groups and of rows within a group). Rows without `workflow` metadata fall
 *  into a trailing 'other' group so nothing is silently dropped. */
export function groupByWorkflow(plan: PlanRow[]): { workflow: string; rows: PlanRow[] }[] {
  const groups: { workflow: string; rows: PlanRow[] }[] = [];
  for (const row of plan) {
    const workflow = row.workflow ?? 'other';
    let group = groups.find((g) => g.workflow === workflow);
    if (!group) { group = { workflow, rows: [] }; groups.push(group); }
    group.rows.push(row);
  }
  return groups;
}

// ---- component --------------------------------------------------------------

export function RunnerRouting() {
  const { apiUrl } = useApiBase();
  const [data, setData] = useState<RunnerPlanResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const load = () => {
    let cancelled = false;
    setFetchError(null);
    fetch(apiUrl('/runner-plan'))
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<RunnerPlanResponse>;
      })
      .then((body) => { if (!cancelled) setData(body); })
      .catch((e) => { if (!cancelled) setFetchError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  };

  useEffect(() => load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const put = async (patch: Record<string, unknown>) => {
    await fetch(apiUrl('/runner-routing'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    load();
  };

  const handleOverride = (key: string, choice: 'spot' | 'ondemand' | 'auto') => {
    if (!data) return;
    const currentOverrides: Record<string, string> = {};
    for (const row of data.plan) {
      if (row.source === 'override') {
        currentOverrides[row.key] = row.decision === 'kindash-arc-spot' ? 'spot' : 'ondemand';
      }
    }
    if (choice === 'auto') {
      const { [key]: _removed, ...rest } = currentOverrides;
      void put({ overrides: rest });
    } else {
      void put({ overrides: { ...currentOverrides, [key]: choice } });
    }
  };

  const handleShedChange = (n: number) => {
    void put({ shedThresholdMinutes: n });
  };

  const handleEnableToggle = () => {
    if (!data) return;
    void put({ enabled: !data.enabled });
  };

  if (fetchError) {
    return <p className="runner-fetch-error">Runner routing fetch failed: {fetchError}</p>;
  }
  if (!data) {
    return <p className="loading">Loading runner routing…</p>;
  }

  const plan = data.plan ?? [];
  const enabled = data.enabled ?? false;
  const lastPushedAt = data.lastPushedAt ?? null;
  const lastError = data.lastError ?? null;

  return (
    <div className="runner-routing">
      {/* Enable / kill switch */}
      <div className="runner-enable-row">
        <button
          type="button"
          className="runner-enable"
          aria-pressed={enabled}
          aria-label={
            enabled
              ? 'Runner routing enabled — pushing RUNNER_MAP; click to disable (kill switch)'
              : 'Runner routing disabled (kill switch active); click to enable'
          }
          onClick={handleEnableToggle}
        >
          {enabled ? 'Enabled' : 'Disabled (kill switch)'}
        </button>
        <span className="runner-enable-hint">
          {enabled ? 'RUNNER_MAP is being pushed' : 'RUNNER_MAP push is suppressed'}
        </span>
      </div>

      {/* Push status (live region) */}
      <p className="runner-push-status-line" role="status" data-testid="runner-push-status">
        {lastError
          ? <><strong>Push failed:</strong> {lastError}</>
          : lastPushedAt
            ? <>last pushed {formatSince(lastPushedAt)}</>
            : 'never pushed'}
      </p>

      {/* Shed threshold */}
      <div className="runner-shed-row">
        <label htmlFor="shed-threshold" className="runner-shed-label">
          Shed threshold (minutes)
        </label>
        <input
          id="shed-threshold"
          key={data.shedThresholdMinutes}
          type="number"
          className="runner-shed-input"
          min={0.1}
          step={0.1}
          defaultValue={data.shedThresholdMinutes}
          aria-valuetext={`${data.shedThresholdMinutes} minutes`}
          // commit on blur only — onChange would PUT (write the config file +
          // reconfigure) on every keystroke mid-entry
          onBlur={(e) => { const n = Number(e.target.value); if (n > 0) handleShedChange(n); }}
        />
        <span className="runner-shed-hint" aria-hidden="true">
          ← Reliability (lower) · Cost (higher) →
        </span>
      </div>

      {/* Job list — grouped by the reusable workflow that owns each job's
          runs-on, so the picker reads workflow → check rather than a flat list
          of bare keys. Group order follows first appearance in the plan. */}
      <div
        role="group"
        aria-label="Job runner assignments"
        className="runner-job-list"
      >
        {groupByWorkflow(plan).map((group) => (
          <div key={group.workflow} className="runner-job-group">
            <div className="runner-job-group-header" data-testid={`runner-group-${group.workflow}`}>
              {group.workflow}
            </div>
            {group.rows.map((row) => {
          const state = overrideState(row);
          return (
            <div key={row.key} className="runner-job-row">
              <span className="runner-job-label">
                {row.label ?? row.key}
                {row.label && <span className="runner-job-key-sub">{row.key}</span>}
              </span>

              <span
                data-testid={`runner-decision-${row.key}`}
                className="runner-job-decision"
              >
                {row.collecting ? 'collecting' : decisionLabel(row.decision)}
              </span>

              <span
                className={`source-tag ${row.source === 'override' ? 'source-override' : 'source-default'}`}
                title={row.source === 'override' ? 'manual override' : 'auto-computed'}
              >
                {row.source}
              </span>

              <span className="runner-job-p90">
                {row.collecting
                  ? 'collecting'
                  : `p90 ${Math.round(row.p90Secs)}s`}
              </span>

              {/* Three-state override buttons */}
              <div className="runner-override-group" role="group" aria-label={`${row.key} runner override`}>
                <button
                  type="button"
                  className="btn-ghost runner-override"
                  data-testid={`override-${row.key}-spot`}
                  aria-pressed={state === 'spot'}
                  aria-label={`${row.key}: force spot`}
                  onClick={() => handleOverride(row.key, 'spot')}
                >
                  spot
                </button>
                <button
                  type="button"
                  className="btn-ghost runner-override"
                  data-testid={`override-${row.key}-ondemand`}
                  aria-pressed={state === 'ondemand'}
                  aria-label={`${row.key}: force on-demand`}
                  onClick={() => handleOverride(row.key, 'ondemand')}
                >
                  on-demand
                </button>
                <button
                  type="button"
                  className="btn-ghost runner-override"
                  data-testid={`override-${row.key}-auto`}
                  aria-pressed={state === 'auto'}
                  aria-label={`${row.key}: clear to auto`}
                  onClick={() => handleOverride(row.key, 'auto')}
                >
                  auto
                </button>
              </div>

              {row.reason && (
                <span className="runner-job-reason">{row.reason}</span>
              )}
            </div>
          );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
