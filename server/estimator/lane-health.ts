import type { HistoryStore } from '../history';

export interface RepoLaneHealth { main: 'green' | 'amber' | 'red' | 'blind' | 'idle'; }

/** Pure projection from history — called ONCE per poll cycle and cached on the
 *  Poller (spec §15: never a per-buildState SQLite read). */
export function computeRepoLaneHealth(history: HistoryStore, repo: string, now: Date): RepoLaneHealth {
  return { main: history.mainLaneHealth(repo, 7, now).status };
}
