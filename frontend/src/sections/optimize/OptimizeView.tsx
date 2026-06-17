// Optimize section / IDE entry (spec 001, US4): the "act" surface that drives the
// already-built server loop (/api/workspace/*). For the focused pipeline it loads
// the model, lets the user simulate a tier change, and — when legal — preview a
// draft-PR diff or copy a Claude Code prompt. The server enforces every safety
// invariant (required-gate union, SHA-pin, draft-only); this UI surfaces the
// verdict. API is injected (testable without a network).
import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceApi, SimResultDto } from '../../shell/workspaceApi';
import type { DerivedModelLike } from './types';

/** first tier id where the check runs (its "home" tier to move from) */
function homeTier(model: DerivedModelLike, check: string): string | null {
  for (const t of model.tiers) {
    const cell = model.cells.find((c) => c.check === check && c.tierId === t.id);
    if (cell?.intent.runs) return t.id;
  }
  return null;
}

export interface OptimizeViewProps { repo: string | null; api: WorkspaceApi }

export function OptimizeView({ repo, api }: OptimizeViewProps) {
  const [model, setModel] = useState<DerivedModelLike | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sim, setSim] = useState<SimResultDto | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quarantine, setQuarantine] = useState<{ check: string; diff?: string; error?: string } | null>(null);
  const [planChecks, setPlanChecks] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<{ combinedCostDeltaMinutes: number; legal: boolean; reason?: string } | null>(null);

  useEffect(() => {
    if (!repo) return;
    setModel(null); setError(null); setSelected(null); setSim(null); setDiff(null);
    api.getPipeline(repo).then((r) => setModel(r.model)).catch((e: Error) => setError(e.message));
  }, [repo, api]);

  const from = useMemo(() => (model && selected ? homeTier(model, selected) : null), [model, selected]);

  async function simulate(check: string) {
    setSelected(check); setSim(null); setDiff(null);
    const tier = model ? homeTier(model, check) : null;
    if (!repo || !tier) return;
    setBusy(true);
    try { setSim(await api.simulate(repo, { check, fromTierId: tier, toTierId: null })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function preview() {
    if (!repo || !selected || !from || !model) return;
    const job = model.checkMeta.find((m) => m.check === selected)?.provenance[0]?.jobId ?? selected;
    setBusy(true);
    try { setDiff((await api.draftPrDryRun(repo, { kind: 'tier', check: selected, jobId: job, fromTierId: from, targetEvent: 'merge_group' })).diff); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function doQuarantine(check: string) {
    if (!repo || !model) return;
    const job = model.checkMeta.find((m) => m.check === check)?.provenance[0]?.jobId ?? check;
    setQuarantine({ check }); setBusy(true);
    try { setQuarantine({ check, diff: (await api.quarantineDryRun(repo, check, job)).diff }); }
    catch (e) { setQuarantine({ check, error: (e as Error).message }); } // server refuses a required gate (FR-038)
    finally { setBusy(false); }
  }

  function togglePlan(check: string) {
    setPlan(null);
    setPlanChecks((prev) => { const next = new Set(prev); next.has(check) ? next.delete(check) : next.add(check); return next; });
  }
  async function simulatePlan() {
    if (!repo || !model || planChecks.size === 0) return;
    const moves = [...planChecks].map((check) => ({ check, fromTierId: homeTier(model, check) ?? 'pr', toTierId: null }));
    setBusy(true);
    try { setPlan(await api.plan(repo, moves)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (!repo) return <div className="optimize-view empty">Select a pipeline to optimize.</div>;
  if (error) return <div className="optimize-view error" role="alert">Couldn’t load the model: {error}</div>;
  if (!model) return <div className="optimize-view" role="status">Deriving the pipeline model…</div>;

  return (
    <div className="optimize-view">
      <h2>Optimize — {repo}</h2>
      <ul className="optimize-checks" role="list">
        {model.checks.map((c) => (
          <li key={c} className={c === selected ? 'optimize-check active' : 'optimize-check'}>
            <label className="plan-toggle">
              <input type="checkbox" checked={planChecks.has(c)} onChange={() => togglePlan(c)} aria-label={`Add ${c} to plan`} />
            </label>
            <span className="optimize-check-name">{c}</span>
            <button type="button" disabled={busy} onClick={() => simulate(c)}>Simulate demote</button>
            <button type="button" className="quarantine-btn" disabled={busy} onClick={() => doQuarantine(c)}>Quarantine (flaky)</button>
          </li>
        ))}
      </ul>
      {planChecks.size > 0 && (
        <section className="optimize-plan" aria-label="Multi-change plan">
          <button type="button" disabled={busy} onClick={simulatePlan}>Simulate plan ({planChecks.size} change{planChecks.size === 1 ? '' : 's'})</button>
          {plan && (
            <p className={plan.legal ? 'plan-note legal' : 'plan-note illegal'} role="status">
              {plan.legal
                ? `Plan is safe — combined ${plan.combinedCostDeltaMinutes < 0 ? `saves ${(-plan.combinedCostDeltaMinutes).toLocaleString()}` : `adds ${plan.combinedCostDeltaMinutes.toLocaleString()}`} min`
                : `Plan blocked — ${plan.reason}`}
            </p>
          )}
        </section>
      )}
      {quarantine && (
        <section className="optimize-quarantine" aria-label={`Quarantine ${quarantine.check}`}>
          {quarantine.error
            ? <p className="quarantine-blocked" role="status">Can’t quarantine {quarantine.check}: {quarantine.error}</p>
            : quarantine.diff
              ? <><p role="status">Quarantine {quarantine.check} (adds continue-on-error):</p><pre className="quarantine-diff" aria-label="quarantine diff">{quarantine.diff}</pre></>
              : <p role="status">Preparing quarantine for {quarantine.check}…</p>}
        </section>
      )}
      {selected && sim && (
        <section className="optimize-sim" aria-label={`Simulation for ${selected}`}>
          <p className={sim.legal ? 'sim-note legal' : 'sim-note illegal'} role="status">{sim.note}</p>
          {sim.legal
            ? <button type="button" disabled={busy} onClick={preview}>Preview draft PR</button>
            : <p className="sim-blocked">This change is blocked: {sim.reason}.</p>}
          {diff && <pre className="optimize-diff" aria-label="draft PR diff">{diff}</pre>}
        </section>
      )}
    </div>
  );
}
