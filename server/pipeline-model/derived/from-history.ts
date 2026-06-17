import type { StaticGraph, GatingResult } from '../types';
import type { SuccessStat, FlakeStat } from '../../history';
import { joinObserved } from './observed';
import { assembleDerivedModel, type DerivedModel } from './assemble';
import { KINDASH_TIERS, type TierDef } from './tiers';

/** Narrow read-seam over HistoryStore — only what the adapter needs. */
export interface DerivedModelDeps {
  repo: string;
  since: string;
  graph: StaticGraph;
  gating: GatingResult;
  successStatsByRepo: (since: string) => Map<string, SuccessStat[]>;
  flakeStatsByRepo: (since: string) => Map<string, FlakeStat[]>;
  tiers?: TierDef[];
}

export function derivedModelForRepo(deps: DerivedModelDeps): DerivedModel {
  const success = deps.successStatsByRepo(deps.since).get(deps.repo) ?? [];
  const flake = deps.flakeStatsByRepo(deps.since).get(deps.repo) ?? [];
  const observed = joinObserved(success, flake);
  return assembleDerivedModel(deps.graph, deps.gating, observed, deps.tiers ?? KINDASH_TIERS);
}
