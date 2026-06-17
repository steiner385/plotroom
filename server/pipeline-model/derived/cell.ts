import type { ObservedCell } from './observed';

/** The static-derived intent for a (check, tier). */
export interface CellIntent {
  /** Configured to run at this tier's event. */
  runs: boolean;
  /** Gates the merge/deploy at this tier (in the rollup needs-closure for this event). */
  gates: boolean;
  /** Runs only conditionally here: low-confidence static resolution, or a
   *  conditionally-required (skipped==pass) caller. */
  conditional: boolean;
}

export type CellState = 'gate' | 'advisory' | 'conditional' | 'absent';

export interface Cell {
  check: string;
  tierId: string;
  intent: CellIntent;
  /** Observed facts at this tier, or null when the check has no history here. */
  observed: ObservedCell | null;
  drift: boolean;
  state: CellState;
}

/** Derive the display state from intent. `conditional` precedes `gate` because a
 *  conditional gate runs only sometimes — the matrix shows it as conditional. */
export function cellState(intent: CellIntent): CellState {
  if (!intent.runs) return 'absent';
  if (intent.conditional) return 'conditional';
  if (intent.gates) return 'gate';
  return 'advisory';
}
