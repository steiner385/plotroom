import type { HistoryStore } from '../history';

export interface RepoLaneHealth {
  main: 'green' | 'amber' | 'red' | 'blind' | 'idle';
  lastGreenSha?: string | null;
  lastGreenAt?: string | null;
  mainSeries?: { ok: boolean | null }[];
}

/** Pure projection from history — called ONCE per poll cycle and cached on the
 *  Poller (spec §15: never a per-buildState SQLite read). */
export function computeRepoLaneHealth(history: HistoryStore, repo: string, now: Date): RepoLaneHealth {
  const h = history.mainLaneHealth(repo, 7, now);
  const s = history.mainCommitSeries(repo, 7, now);
  return { main: h.status, lastGreenSha: s.lastGreenSha, lastGreenAt: s.lastGreenAt, mainSeries: s.points };
}
