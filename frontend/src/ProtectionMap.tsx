import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { legalFromTiers, legalToTargets } from './protectionSimulate';
import { useFocusTrap } from './hooks/useFocusTrap';
import { useProtectionData } from './hooks/useProtectionData';
import { ProtectionDrawer } from './ProtectionDrawer';
// Pure model logic (types, goal vocabulary, cell/format helpers) lives in
// protectionModel.ts (#183) so this file holds only the React component.
import {
  type Cell, type CellState, type Goal, type Overlay, type Finding,
  STATE_RANK, ABSENT_META, STATE_GLYPH, GOALS, GOAL_ICON, GOAL_LABEL, OVERLAYS,
  buildFindings, cellKey, groupOf, leafOf, displayName, fmtMin, cellHeat, cellTitle,
} from './protectionModel';
// Re-exported for back-compat: protectionSimulate / protectionPrompt and the
// ProtectionMap tests import these types from here.
export type { CheckMeta, DerivedModel, Finding } from './protectionModel';

// ---- component --------------------------------------------------------------

export function ProtectionMap() {
  // Server data (repo list, selected model, deferred metrics) lives in a hook (#183);
  // this component owns only view state.
  const { repos, repo, setRepo, model, metrics, loading, error } = useProtectionData();
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [sim, setSim] = useState<{ check: string; from: string; to: string } | null>(null);
  const [drilled, setDrilled] = useState<{ check: string; goal: Goal; detail: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expandedGoals, setExpandedGoals] = useState<Set<Goal>>(new Set());
  const [showAbsent, setShowAbsent] = useState(false);

  // ---- a11y: drawer focus management (mirrors LegendPanel/SettingsPanel pattern) ----
  const drawerRef = useRef<HTMLElement>(null);
  /** Ref to the button that last opened the drawer — focus returns here on close. */
  const drawerTriggerRef = useRef<HTMLElement | null>(null);

  // default-collapse groups with no gates and no drift (pure advisory/absent noise);
  // re-seeded whenever the model changes (repo switch). User toggles adjust from there.
  useEffect(() => {
    if (!model) return;
    const problem = new Set<string>();
    for (const c of model.cells) if (c.state === 'gate' || c.drift) problem.add(groupOf(c.check));
    const clean = [...new Set(model.checks.map(groupOf))].filter((g) => !problem.has(g));
    setCollapsed(new Set(clean));
  }, [model]);

  // Esc to close the drawer + focus management + focus trap (via shared hook).
  useFocusTrap(drawerRef, !!drilled, {
    onClose: () => setDrilled(null),
    returnFocusRef: drawerTriggerRef,
  });

  const findings = useMemo(() => buildFindings(repo ?? '', model, metrics), [repo, model, metrics]);
  const byCell = useMemo(() => {
    const m = new Map<string, Cell>();
    for (const c of model?.cells ?? []) m.set(cellKey(c.check, c.tierId), c);
    return m;
  }, [model]);
  const summary = useMemo(() => {
    const s = { gate: 0, conditional: 0, advisory: 0, absent: 0, drift: 0 };
    for (const c of model?.cells ?? []) { s[c.state]++; if (c.drift) s.drift++; }
    return s;
  }, [model]);
  const maxima = useMemo(() => {
    let minutes = 0, fail = 0;
    for (const c of model?.cells ?? []) if (c.observed) { minutes = Math.max(minutes, c.observed.minutes); fail = Math.max(fail, c.observed.failRatePct); }
    return { minutes, fail };
  }, [model]);

  // per-check rollup: dominant role, drift, cost, the tiers it hard-gates at
  const checkMeta = useMemo(() => {
    const m = new Map<string, { role: CellState; drift: boolean; minutes: number; gateTiers: string[] }>();
    for (const check of model?.checks ?? []) {
      let role: CellState = 'absent', drift = false, minutes = 0; const gateTiers: string[] = [];
      for (const t of model!.tiers) {
        const c = byCell.get(cellKey(check, t.id));
        if (!c) continue;
        if (STATE_RANK[c.state] > STATE_RANK[role]) role = c.state;
        if (c.drift) drift = true;
        if (c.observed) minutes += c.observed.minutes;
        if (c.state === 'gate') gateTiers.push(t.id);
      }
      m.set(check, { role, drift, minutes, gateTiers });
    }
    return m;
  }, [model, byCell]);

  // group rows by owning workflow; sort checks problem-first, groups problem-first.
  // Also precomputes per-(group,tier) best CellState for the group header mini-cells
  // so the render loop doesn't re-run the nested byCell lookup on every reconciliation.
  const grouped = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const check of model?.checks ?? []) {
      const g = groupOf(check);
      const arr = groups.get(g) ?? []; arr.push(check); groups.set(g, arr);
    }
    const getMeta = (c: string) => checkMeta.get(c) ?? ABSENT_META;
    const rank = (c: string) => { const m = getMeta(c); return (m.drift ? 100 : 0) + STATE_RANK[m.role] * 10; };
    const tiers = model?.tiers ?? [];
    return [...groups.entries()].map(([name, checks]) => {
      checks.sort((a, b) => rank(b) - rank(a) || (getMeta(b).minutes - getMeta(a).minutes) || leafOf(a).localeCompare(leafOf(b)));
      const drift = checks.some((c) => getMeta(c).drift);
      const gates = checks.filter((c) => getMeta(c).role === 'gate').length;
      const visible = checks.filter((c) => showAbsent || getMeta(c).role !== 'absent');
      // Precompute the best CellState per tier for this group's header row mini-cells.
      const tierBest = new Map<string, CellState>();
      for (const t of tiers) {
        let best: CellState = 'absent';
        for (const c of checks) {
          // byCell is from the outer useMemo and is stable when model is stable
          const cell = byCell.get(cellKey(c, t.id));
          if (cell && STATE_RANK[cell.state] > STATE_RANK[best]) best = cell.state;
        }
        tierBest.set(t.id, best);
      }
      return { name, checks, visible, drift, gates, hiddenAbsent: checks.length - visible.length, tierBest };
    }).sort((a, b) => Number(b.drift) - Number(a.drift) || b.gates - a.gates || a.name.localeCompare(b.name));
  }, [model, checkMeta, showAbsent, byCell]);

  // per-tier rollup (cost + gate count) for the column headers
  const tierStats = useMemo(() => {
    const m = new Map<string, { minutes: number; gates: number }>();
    for (const t of model?.tiers ?? []) {
      let minutes = 0, gates = 0;
      for (const c of model!.cells) if (c.tierId === t.id) { if (c.observed) minutes += c.observed.minutes; if (c.state === 'gate') gates++; }
      m.set(t.id, { minutes, gates });
    }
    return m;
  }, [model]);

  // the merge contract: checks that hard-gate at the queue (merge_group) tier
  const queueTierId = model?.tiers.find((t) => t.event === 'merge_group')?.id;
  const mergeBlockers = useMemo(
    () => (queueTierId ? (model?.checks ?? []).filter((c) => byCell.get(cellKey(c, queueTierId))?.state === 'gate') : []),
    [model, byCell, queueTierId]);
  const redundantGates = useMemo(
    () => (model?.checks ?? []).filter((c) => (checkMeta.get(c)?.gateTiers.length ?? 0) >= 2).length,
    [model, checkMeta]);
  const reclaimable = useMemo(() => {
    const demo = metrics?.demotionCandidates?.find((d) => d.repo === (repo ?? ''))?.candidates ?? [];
    return demo.reduce((s, c) => s + (c.minutesInWindow || 0), 0);
  }, [metrics, repo]);

  const findingsByGoal = useMemo(() => {
    const m: Record<Goal, Finding[]> = { drift: [], cost: [], quality: [] };
    for (const f of findings) m[f.goal].push(f);
    for (const g of GOALS) m[g].sort((a, b) => b.weight - a.weight);
    return m;
  }, [findings]);

  const verdict = summary.drift > 0
    ? { cls: 'warn', text: `${summary.drift} drift` }
    : mergeBlockers.length === 0
      ? { cls: 'bad', text: 'no merge gate' }
      : { cls: 'ok', text: 'protected' };

  const toggleGroup = (n: string) => setCollapsed((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  const toggleGoal = (g: Goal) => setExpandedGoals((s) => { const x = new Set(s); if (x.has(g)) x.delete(g); else x.add(g); return x; });
  // open the drill-down drawer for a check, seeding the simulator with the
  // recommended (legal) move so the user lands on the suggested action.
  // `trigger` is the element that opened the drawer — focus returns to it on close.
  const openDrill = (check: string, goal: Goal, detail: string, trigger?: HTMLElement | null) => {
    if (!model) return;
    if (trigger) drawerTriggerRef.current = trigger;
    const fromOpts = legalFromTiers(model, check);
    const from = fromOpts[0]?.id ?? model.tiers[0]?.id ?? '';
    const toOpts = legalToTargets(model, check, from);
    const to = toOpts.find((o) => o.tierId !== null)?.tierId ?? '__remove__';
    setSim({ check, from, to });
    setDrilled({ check, goal, detail });
  };

  return (
    <div className="protection-map">
      {loading && <p className="loading" data-testid="pm-loading">Deriving the protection map…</p>}
      {error && <p className="pm-error" data-testid="pm-error">Couldn’t derive the map: {error}</p>}

      {model && (
        <>
          {/* ── HEALTH STRIP: the answer, first ─────────────────────────── */}
          <div className="pm-health" data-testid="pm-summary">
            <div className="pm-health-id">
              <span className={`pm-verdict pm-verdict-${verdict.cls}`}>{verdict.text}</span>
              {repos.length > 1 ? (
                <select className="pm-repo" aria-label="Pipeline repository" value={repo ?? ''} onChange={(e) => setRepo(e.target.value)}>
                  {repos.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              ) : <span className="pm-repo-name">{repo}</span>}
            </div>
            <div className="pm-stats">
              <span className="pm-stat"><b>{summary.gate}</b><i>gates</i></span>
              <span className="pm-stat pm-stat-warn"><b>{summary.drift}</b><i>drift</i></span>
              <span className="pm-stat"><b>{findings.length}</b><i>actions</i></span>
              {reclaimable > 0 && <span className="pm-stat"><b>~{fmtMin(reclaimable)}</b><i>/wk reclaimable</i></span>}
              {redundantGates > 0 && <span className="pm-stat"><b>{redundantGates}</b><i>multi-tier gates</i></span>}
            </div>
            <div className="pm-overlay-toggle" role="group" aria-label="Matrix overlay">
              {OVERLAYS.map((o) => (
                <button key={o.id} type="button" className={overlay === o.id ? 'pm-ov active' : 'pm-ov'}
                  aria-pressed={overlay === o.id} data-testid={`pm-overlay-${o.id}`} onClick={() => setOverlay(o.id)}>{o.label}</button>
              ))}
            </div>
          </div>

          {/* the merge contract, stated plainly */}
          <p className="pm-contract" data-testid="pm-contract">
            <b>Blocks merge ({mergeBlockers.length}):</b>{' '}
            {mergeBlockers.length ? mergeBlockers.map(leafOf).slice(0, 8).join(' · ') : 'nothing gates the merge queue'}
            {mergeBlockers.length > 8 && ` · +${mergeBlockers.length - 8} more`}
          </p>

          <div className="pm-body">
            {/* ── ACTIONS rail ──────────────────────────────────────────── */}
            <aside className="pm-findings" data-testid="pm-findings" aria-label="Actions">
              <h3>Actions <span className="pm-findings-count">{findings.length}</span></h3>
              {findings.length === 0 && <p className="pm-findings-empty">No actions — the pipeline reads clean.</p>}
              {GOALS.map((goal) => {
                const items = findingsByGoal[goal];
                if (!items.length) return null;
                const open = expandedGoals.has(goal);
                const shown = open ? items : items.slice(0, 3);
                const total = goal === 'cost' ? items.reduce((s, f) => s + f.weight, 0) : 0;
                return (
                  <div key={goal} className={`pm-fgroup pm-fgroup-${goal}`} data-goal={goal}>
                    <div className="pm-fgroup-head">
                      <span>{GOAL_ICON[goal]} {GOAL_LABEL[goal]}</span>
                      <span className="pm-fgroup-meta">{items.length}{total ? ` · ~${fmtMin(total)}/wk` : ''}</span>
                    </div>
                    <ul>
                      {shown.map((f, i) => (
                        <li key={`${f.check}-${i}`} className="pm-finding" data-goal={goal}>
                          <button type="button" className="pm-finding-btn"
                            onClick={(e) => openDrill(f.check, goal, f.detail, e.currentTarget)}
                            aria-label={`Details for ${displayName(f.check)}`}>
                            <span className="pm-finding-check" title={f.check}>{displayName(f.check)}</span>
                            <span className="pm-finding-detail">{f.detail}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {items.length > 3 && (
                      <button type="button" className="pm-show-more" onClick={() => toggleGoal(goal)}>
                        {open ? 'show less' : `show all ${items.length}`}
                      </button>
                    )}
                  </div>
                );
              })}
            </aside>

            {/* ── MATRIX (reference) ────────────────────────────────────── */}
            <div className="pm-grid-wrap">
              <table className="pm-grid" data-testid="pm-grid" aria-label="Protection check matrix">
                <thead>
                  <tr>
                    <th scope="col" className="pm-check-h">
                      check
                      <label className="pm-show-absent">
                        <input type="checkbox" checked={showAbsent} onChange={(e) => setShowAbsent(e.target.checked)} /> absent
                      </label>
                    </th>
                    {model.tiers.map((t) => {
                      const st = tierStats.get(t.id)!;
                      return (
                        <th scope="col" key={t.id} className="pm-tier-h" title={`trigger: ${t.event}`}>
                          {t.label}<i>{st.gates}g · {fmtMin(st.minutes)}</i>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((g) => {
                    const open = !collapsed.has(g.name);
                    return (
                      <Fragment key={g.name}>
                        <tr key={`h-${g.name}`} className="pm-group-row" onClick={() => toggleGroup(g.name)}>
                          <th scope="rowgroup" className="pm-group-name">
                            <button
                              type="button"
                              className="pm-group-btn"
                              aria-expanded={open}
                              aria-label={`Toggle group ${g.name}`}
                              onClick={(e) => { e.stopPropagation(); toggleGroup(g.name); }}
                            >
                              <span className="pm-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                              {' '}{g.name}
                              <span className="pm-group-meta">{g.checks.length}{g.gates ? ` · ${g.gates}g` : ''}{g.drift ? ' · ⚠' : ''}</span>
                            </button>
                          </th>
                          {model.tiers.map((t) => {
                            const best = g.tierBest.get(t.id) ?? 'absent';
                            return <td key={t.id} className={`pm-mini pm-${best}`}>{STATE_GLYPH[best]}</td>;
                          })}
                        </tr>
                        {open && g.visible.map((check) => (
                          <tr key={check} data-testid={`pm-row-${check}`} className="pm-check-row">
                            <td className="pm-check" title={check}>{displayName(check)}</td>
                            {model.tiers.map((t) => {
                              const c = byCell.get(cellKey(check, t.id));
                              const state = c?.state ?? 'absent';
                              const heat = cellHeat(c, overlay, maxima);
                              return (
                                <td key={t.id}
                                  className={`pm-cell pm-${state}${c?.drift ? ' pm-has-drift' : ''}${overlay !== 'none' ? ' pm-overlaid' : ''}`}
                                  data-testid={`pm-cell-${check}-${t.id}`} data-state={state} data-drift={c?.drift ? '1' : '0'}
                                  style={heat ? { background: heat } : undefined} title={c ? cellTitle(c) : undefined}>
                                  <span className="pm-glyph">{STATE_GLYPH[state]}</span>{c?.drift && <span className="pm-drift-badge">⚠</span>}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                        {open && g.hiddenAbsent > 0 && (
                          <tr key={`a-${g.name}`} className="pm-absent-note"><td colSpan={model.tiers.length + 1}>+{g.hiddenAbsent} absent-only checks hidden</td></tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <p className="pm-legend">
                <span><b className="pm-gate">● gate</b> blocks merge</span>
                <span><b className="pm-cond">◐ conditional</b> runs-when-touched</span>
                <span><b className="pm-adv">○ advisory</b> non-blocking</span>
                <span><span className="pm-absent">· absent</span></span>
                <span><b className="pm-drift">⚠ drift</b> config ≠ observed</span>
              </p>
            </div>
          </div>

          {/* ── Drill-down drawer: evidence + constrained simulator + action ── */}
          {drilled && (
            <ProtectionDrawer
              drill={drilled}
              model={model}
              repo={repo}
              byCell={byCell}
              sim={sim}
              setSim={setSim}
              drawerRef={drawerRef}
              onClose={() => setDrilled(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
