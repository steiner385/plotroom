// Simulation engine for the CI/CD Designer (spec Increment 2): given the derived
// protection model and a proposed "move check X from tier A to tier B" change,
// project the cost (runtime) and coverage (gate) delta. Pure + client-side so
// what-ifs are instant — the model is already in the browser.
import type { DerivedModel } from './ProtectionMap';

type Cell = DerivedModel['cells'][number];

export interface MoveRequest {
  check: string;
  fromTierId: string;
  /** Target tier, or null to simply remove the check from `fromTierId`. */
  toTierId: string | null;
}

export interface SimResult {
  check: string;
  fromTierId: string;
  toTierId: string | null;
  /** Projected change in observed minutes over the window; negative = saved. */
  costDeltaMinutes: number;
  gatesLost: string[];
  gatesGained: string[];
  /** True when the add-side cost is estimated (no observed history at target). */
  estimated: boolean;
  note: string;
}

function cellFor(model: DerivedModel, check: string, tierId: string): Cell | undefined {
  return model.cells.find((c) => c.check === check && c.tierId === tierId);
}

/** Average minutes per run for a check, pooled across every tier where it has runs. */
export function perRunMinutes(model: DerivedModel, check: string): number {
  let mins = 0, runs = 0;
  for (const c of model.cells) {
    if (c.check === check && c.observed && c.observed.runs > 0) { mins += c.observed.minutes; runs += c.observed.runs; }
  }
  return runs ? mins / runs : 0;
}

/** A tier's cadence proxy: the busiest check's observed run count at that tier. */
export function tierRunScale(model: DerivedModel, tierId: string): number {
  let m = 0;
  for (const c of model.cells) if (c.tierId === tierId && c.observed) m = Math.max(m, c.observed.runs);
  return m;
}

export function simulateMove(model: DerivedModel, req: MoveRequest): SimResult {
  const from = cellFor(model, req.check, req.fromTierId);
  const costRemoved = from?.observed?.minutes ?? 0;
  const gatesLost: string[] = [];
  const gatesGained: string[] = [];
  if (from?.intent.gates) gatesLost.push(req.fromTierId);

  let costAdded = 0;
  let estimated = false;
  if (req.toTierId) {
    const to = cellFor(model, req.check, req.toTierId);
    if (to?.observed) {
      costAdded = to.observed.minutes; // already runs there — exact
    } else {
      costAdded = Math.round(perRunMinutes(model, req.check) * tierRunScale(model, req.toTierId));
      estimated = true;
    }
    if (!to?.intent.gates) gatesGained.push(req.toTierId);
  }

  const costDeltaMinutes = costAdded - costRemoved;
  const cost = costDeltaMinutes < 0 ? `saves ${(-costDeltaMinutes).toLocaleString()} min`
    : costDeltaMinutes > 0 ? `adds ${costDeltaMinutes.toLocaleString()} min` : 'no cost change';
  const cov = gatesLost.length ? ` · loses gate at ${gatesLost.join(', ')}`
    : gatesGained.length ? ` · adds gate at ${gatesGained.join(', ')}` : '';
  const note = `${cost}${estimated ? ' (est.)' : ''}${cov}`;

  return { check: req.check, fromTierId: req.fromTierId, toTierId: req.toTierId, costDeltaMinutes, gatesLost, gatesGained, estimated, note };
}
