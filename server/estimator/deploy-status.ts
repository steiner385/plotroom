import type { HistoryStore } from '../history';
import type { DeployConfig } from '../config';

/** Per-repo deploy snapshot attached to DashboardState.repos[] (Deploy lane,
 *  Spec 2). Advisory only — the lane is gating:false and never reds the rollup. */
export interface RepoDeployStatus {
  envs: { name: string; liveSha: string | null; reachable: boolean }[];
  /** Merged PRs (in retention) not yet observed live in that env. */
  awaitingQa: number;
  awaitingProd: number;
}

/** Pure projection — called ONCE per deploy cycle and cached on the Poller
 *  (spec §15: never a per-buildState SQLite read). `envShas` is keyed
 *  `${repo}/${env.name}` and populated by the deploy cycle's health() call. */
export function computeRepoDeploy(
  history: HistoryStore,
  repo: string,
  dc: DeployConfig,
  envShas: Map<string, string | null>,
  retentionDays: number,
  now: Date,
): RepoDeployStatus {
  const envs = dc.environments.map((env) => {
    const liveSha = envShas.get(`${repo}/${env.name}`) ?? null;
    return { name: env.name, liveSha, reachable: liveSha != null };
  });
  let awaitingQa = 0;
  let awaitingProd = 0;
  for (const rec of history.listTrackedMerged(retentionDays, now)) {
    if (rec.repo !== repo) continue;
    if (rec.qaLiveAt == null) awaitingQa += 1;
    if (rec.prodLiveAt == null) awaitingProd += 1;
  }
  return { envs, awaitingQa, awaitingProd };
}
