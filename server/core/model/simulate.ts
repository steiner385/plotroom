// Server-side simulation engine (spec 001, FR-011/FR-012). The architect review
// flagged that the original simulateMove is CLIENT-side; this ports it to the
// server and binds it to the shared legality validator (one source of truth) +
// the union required-gate safety set. Pure — (model, change[, liveRequired]) in,
// projection + verdict out.
import type { DerivedModel } from '../../pipeline-model/derived';
import { validateTierChange, type LegalityVerdict } from './legality';

export type MoveDirection = 'demote' | 'promote' | 'remove' | 'none';
export interface TierMove { check: string; fromTierId: string; toTierId: string | null }
export interface SimResult {
  check: string; fromTierId: string; toTierId: string | null;
  costDeltaMinutes: number;
  gatesLost: string[];
  gatesGained: string[];
  estimated: boolean;
  direction: MoveDirection;
  legal: boolean;
  reason?: LegalityVerdict['reason'];
  note: string;
}

type Cell = DerivedModel['cells'][number];
function cellFor(m: DerivedModel, check: string, tierId: string): Cell | undefined {
  return m.cells.find((c) => c.check === check && c.tierId === tierId);
}
/** avg minutes/run for a check, pooled across tiers with observed runs */
export function perRunMinutes(m: DerivedModel, check: string): number {
  let mins = 0, runs = 0;
  for (const c of m.cells) if (c.check === check && c.observed && c.observed.runs > 0) { mins += c.observed.minutes; runs += c.observed.runs; }
  return runs ? mins / runs : 0;
}
function tierRunScale(m: DerivedModel, tierId: string): number {
  let n = 0;
  for (const c of m.cells) if (c.tierId === tierId && c.observed) n = Math.max(n, c.observed.runs);
  return n;
}
function directionOf(m: DerivedModel, fromId: string, toId: string | null): MoveDirection {
  if (toId == null) return 'remove';
  const fi = m.tiers.findIndex((t) => t.id === fromId), ti = m.tiers.findIndex((t) => t.id === toId);
  if (fi < 0 || ti < 0 || fi === ti) return 'none';
  return ti > fi ? 'demote' : 'promote';
}

/** Simulate a tier move: legality (via the shared validator) + cost/coverage delta. */
export function simulateTierMove(model: DerivedModel, move: TierMove, liveRequired?: readonly string[]): SimResult {
  const verdict = validateTierChange(model, move, liveRequired);
  const from = cellFor(model, move.check, move.fromTierId);
  const direction = directionOf(model, move.fromTierId, move.toTierId);

  const costRemoved = from?.observed?.minutes ?? 0;
  const gatesLost: string[] = [];
  const gatesGained: string[] = [];
  if (from?.intent.gates) gatesLost.push(move.fromTierId);
  let costAdded = 0, estimated = false;
  if (move.toTierId) {
    const to = cellFor(model, move.check, move.toTierId);
    if (to?.observed) costAdded = to.observed.minutes;
    else { costAdded = Math.round(perRunMinutes(model, move.check) * tierRunScale(model, move.toTierId)); estimated = true; }
    if (!to?.intent.gates) gatesGained.push(move.toTierId);
  }
  const costDeltaMinutes = costAdded - costRemoved;
  const cost = costDeltaMinutes < 0 ? `saves ${(-costDeltaMinutes).toLocaleString()} min`
    : costDeltaMinutes > 0 ? `adds ${costDeltaMinutes.toLocaleString()} min` : 'no cost change';
  const cov = gatesLost.length ? ` · loses gate at ${gatesLost.join(', ')}`
    : gatesGained.length ? ` · adds gate at ${gatesGained.join(', ')}` : '';
  const note = verdict.legal ? `${cost}${estimated ? ' (est.)' : ''}${cov}` : `not possible — ${verdict.detail ?? verdict.reason}`;

  return { check: move.check, fromTierId: move.fromTierId, toTierId: move.toTierId, costDeltaMinutes, gatesLost, gatesGained, estimated, direction, legal: verdict.legal, reason: verdict.reason, note };
}
