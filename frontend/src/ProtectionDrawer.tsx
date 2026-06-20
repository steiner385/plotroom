import { type RefObject } from 'react';
import { simulateMove, legalFromTiers, legalToTargets } from './protectionSimulate';
import { buildClaudePrompt } from './protectionPrompt';
import {
  type Cell, type DerivedModel, type Goal,
  GOAL_ICON, GOAL_LABEL, STATE_GLYPH, STATE_WORD,
  cellKey, displayName, fmtMin,
} from './protectionModel';

export interface Drill { check: string; goal: Goal; detail: string }
export interface SimMove { check: string; from: string; to: string }

/** The drill-down drawer: per-tier evidence, the constrained what-if simulator, and
 *  the "copy Claude Code prompt" action. Extracted from ProtectionMap's inline IIFE
 *  (#183) so the grid component holds only the map; the drawer owns its own render.
 *  State (the selected move, the copied flash) stays lifted in ProtectionMap so the
 *  drawer is a controlled view. */
export function ProtectionDrawer({
  drill, model, repo, byCell, sim, setSim, copied, setCopied, drawerRef, onClose,
}: {
  drill: Drill;
  model: DerivedModel;
  repo: string | null;
  byCell: Map<string, Cell>;
  sim: SimMove | null;
  setSim: (s: SimMove) => void;
  copied: boolean;
  setCopied: (c: boolean) => void;
  drawerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const dcheck = drill.check;
  const meta = model.checkMeta?.find((m) => m.check === dcheck);
  const s = sim && sim.check === dcheck
    ? sim
    : { check: dcheck, from: legalFromTiers(model, dcheck)[0]?.id ?? model.tiers[0]?.id ?? '', to: '__remove__' };
  const fromOpts = legalFromTiers(model, dcheck);
  const toOpts = legalToTargets(model, dcheck, s.from);
  const res = simulateMove(model, { check: dcheck, fromTierId: s.from, toTierId: s.to === '__remove__' ? null : s.to });
  const setFrom = (from: string) => {
    const next = legalToTargets(model, dcheck, from);
    const keep = next.some((o) => (o.tierId ?? '__remove__') === s.to);
    setSim({ check: dcheck, from, to: keep ? s.to : (next.find((o) => o.tierId !== null)?.tierId ?? '__remove__') });
  };
  const onCopy = () => {
    const text = buildClaudePrompt(repo ?? '', model, { goal: drill.goal, check: dcheck, detail: drill.detail, suggestedTierId: s.to === '__remove__' ? null : s.to });
    void navigator.clipboard?.writeText?.(text);
    setCopied(true); window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      {/* #182: pm-drawer previously had no backdrop (unlike settings-overlay);
          add one so click-outside dismisses + content behind is dimmed. */}
      <div className="pm-drawer-backdrop" data-testid="pm-drawer-backdrop"
        onClick={onClose} aria-hidden="true" />
      <aside
        className="pm-drawer"
        data-testid="pm-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Action for ${displayName(dcheck)}`}
        ref={drawerRef}
        tabIndex={-1}
      >
        <div className="pm-drawer-head">
          <span className={`pm-drawer-goal pm-fgroup-${drill.goal}`}>{GOAL_ICON[drill.goal]} {GOAL_LABEL[drill.goal]}</span>
          <strong className="pm-drawer-check" title={dcheck}>{displayName(dcheck)}</strong>
          <button type="button" className="pm-drawer-x" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <p className="pm-drawer-prov">
          {meta?.provenance?.length ? `defined in ${meta.provenance.map((p) => `${p.file} › ${p.jobId}`).join(', ')}` : 'workflow source unknown'}
          {meta?.isRequiredMergeGate && <span className="pm-drawer-gate"> · required merge gate</span>}
          {meta?.confidence === 'low' && <span className="pm-drawer-low"> · low parse confidence</span>}
        </p>
        <p className="pm-drawer-why">{drill.detail}</p>

        <table className="pm-evidence" data-testid="pm-evidence" aria-label="Per-tier evidence">
          <thead><tr><th scope="col">tier</th><th scope="col">state</th><th scope="col">runs</th><th scope="col">fail%</th><th scope="col">min</th></tr></thead>
          <tbody>
            {model.tiers.map((t) => {
              const c = byCell.get(cellKey(dcheck, t.id));
              const o = c?.observed;
              const st = c?.state ?? 'absent';
              return (
                <tr key={t.id} className={c?.drift ? 'pm-ev-drift' : ''}>
                  <td>{t.label}</td>
                  <td className={`pm-${st}`}>{STATE_GLYPH[st]} {STATE_WORD[st]}{c?.drift ? ' ⚠' : ''}</td>
                  <td>{o ? o.runs.toLocaleString() : '—'}</td>
                  <td>{o && o.runs ? `${o.failRatePct}%` : '—'}</td>
                  <td>{o ? fmtMin(o.minutes) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="pm-drawer-sim" data-testid="pm-sim">
          <div className="pm-sim-label">What-if</div>
          <div className="pm-sim-controls">
            <label>move from
              <select data-testid="pm-sim-from" value={s.from} onChange={(e) => setFrom(e.target.value)}>
                {fromOpts.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            <label>to
              <select data-testid="pm-sim-to" value={s.to} onChange={(e) => setSim({ check: dcheck, from: s.from, to: e.target.value })} disabled={toOpts.length === 0}>
                {toOpts.length === 0 && <option value="">— no legal move —</option>}
                {toOpts.map((o) => <option key={o.tierId ?? '__remove__'} value={o.tierId ?? '__remove__'}>{o.label}</option>)}
              </select>
            </label>
          </div>
          <p className={`pm-sim-result ${!res.legal ? 'bad' : res.costDeltaMinutes < 0 ? 'good' : res.costDeltaMinutes > 0 ? 'bad' : ''}`}
            data-testid="pm-sim-result" data-cost-delta={res.costDeltaMinutes} data-legal={res.legal ? '1' : '0'}>{res.note}</p>
        </div>

        <div className="pm-drawer-actions">
          <button type="button" className="pm-action-primary" data-testid="pm-copy-prompt" onClick={onCopy}>
            {copied ? '✓ Copied' : 'Copy Claude Code prompt'}
          </button>
        </div>
      </aside>
    </>
  );
}
