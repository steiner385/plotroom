import type { HistoryStore } from '../history';
import type { DeployConfig } from '../config';

/** Per-repo deploy snapshot attached to DashboardState.repos[] (Deploy lane,
 *  Spec 2). Advisory only — the lane is gating:false and never reds the rollup. */
export interface RepoDeployStatus {
  envs: { name: string; liveSha: string | null; reachable: boolean }[];
  /** First environment in promotion order (dc.order[0]), or null when no order. */
  firstEnv: string | null;
  /** Terminal (last) environment in promotion order (dc.order.at(-1)), or null. */
  terminalEnv: string | null;
  /** Merged PRs (in retention) not yet observed live in the firstEnv. */
  awaitingQa: number;
  /** Merged PRs live in firstEnv but not yet in terminalEnv (awaiting the terminal env). */
  awaitingProd: number;
  /** The firstEnv→terminalEnv progression chain with SHA supersession (roadmap 4.4c). */
  chain: DeployChain;
}

export type DeployStage = 'merged' | 'first' | 'terminal';
export interface DeployChainEntry {
  prNumber: number;
  sha: string | null;
  mergedAt: string;
  /** The furthest deploy stage this merge has reached. */
  stage: DeployStage;
  firstLiveAt: string | null;
  terminalLiveAt: string | null;
  /** A newer merge reached the terminal env first — this SHA was rolled up into
   *  that deploy and won't go live on its own (SHA supersession). */
  superseded: boolean;
}
export interface DeployChain {
  /** Recent merges, newest first, capped to the chain limit. */
  entries: DeployChainEntry[];
  /** The newest merge still flowing toward terminal (not yet terminal, not superseded). */
  inFlight: DeployChainEntry | null;
  /** How many in-window merges were superseded before reaching terminal. */
  supersededCount: number;
}

type ChainInput = { number: number; mergeCommitSha: string | null;
  mergedAt: string; firstLiveAt: string | null; terminalLiveAt: string | null };

/**
 * Model the first→terminal deploy chain (roadmap 4.4c). Each merge is placed at
 * the furthest stage it reached (merged → first → terminal); a merge still
 * awaiting terminal is SUPERSEDED once a strictly newer merge has already gone
 * live on the terminal env — the pipeline only advances the latest SHA, so the
 * older one was rolled up and will never deploy on its own. The front-runner
 * (newest, still flowing) is in-flight.
 */
export function deployChain(merged: readonly ChainInput[], limit = 8): DeployChain {
  const sorted = [...merged].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)); // newest first
  const newestTerminal = sorted.find((m) => m.terminalLiveAt != null) ?? null;
  const entries: DeployChainEntry[] = sorted.slice(0, limit).map((m) => {
    const stage: DeployStage = m.terminalLiveAt != null ? 'terminal' : m.firstLiveAt != null ? 'first' : 'merged';
    const superseded = m.terminalLiveAt == null && newestTerminal != null && newestTerminal.mergedAt > m.mergedAt;
    return { prNumber: m.number, sha: m.mergeCommitSha, mergedAt: m.mergedAt, stage,
      firstLiveAt: m.firstLiveAt, terminalLiveAt: m.terminalLiveAt, superseded };
  });
  const inFlight = entries.find((e) => e.stage !== 'terminal' && !e.superseded) ?? null;
  const supersededCount = entries.filter((e) => e.superseded).length;
  return { entries, inFlight, supersededCount };
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
  const order = dc.order ?? dc.environments.map((e) => e.name);
  const firstEnv = order[0] ?? null;
  const terminalEnv = order.at(-1) ?? null;

  // Build envs ordered by dc.order (not dc.environments declaration order).
  const envs = order
    .map((name) => {
      const liveSha = envShas.get(`${repo}/${name}`) ?? null;
      return { name, liveSha, reachable: liveSha != null };
    })
    // Include any environments declared but not in order (preserve backward compat).
    .concat(
      dc.environments
        .filter((env) => !order.includes(env.name))
        .map((env) => {
          const liveSha = envShas.get(`${repo}/${env.name}`) ?? null;
          return { name: env.name, liveSha, reachable: liveSha != null };
        }),
    );

  // Partition the merged-but-not-fully-deployed set by where each SHA actually
  // sits, so a PR awaiting firstEnv isn't ALSO counted as awaiting terminalEnv
  // (the two metrics must be disjoint): terminal-live → done;
  // first-live-only → awaiting terminal; neither → awaiting first.
  const repoMerged: ChainInput[] = [];
  for (const rec of history.listTrackedMerged(retentionDays, now)) {
    if (rec.repo !== repo) continue;
    // Guard: read from envLive map; null when firstEnv/terminalEnv is null or
    // the key is absent. When firstEnv===terminalEnv (single-env), both read
    // the same slot — so a merge live in that one env is immediately 'terminal'.
    const firstLiveAt = firstEnv != null ? (rec.envLive[firstEnv] ?? null) : null;
    const terminalLiveAt = terminalEnv != null ? (rec.envLive[terminalEnv] ?? null) : null;
    repoMerged.push({ number: rec.number, mergeCommitSha: rec.mergeCommitSha,
      mergedAt: rec.mergedAt, firstLiveAt, terminalLiveAt });
  }
  // The newest merge that reached the terminal env. An older merge not yet on
  // terminal is SUPERSEDED — its SHA was rolled up into that newer terminal deploy
  // and will never go live on its own (a sub-PR merged into a feature branch, or
  // a squash artifact whose recorded SHA isn't what landed on the default branch;
  // #205). Such merges must NOT be counted as 'awaiting' or they sit 'overdue'
  // forever even though their content already shipped via the newer merge.
  const newestTerminalMergedAt = repoMerged.reduce<string | null>(
    (max, m) => (m.terminalLiveAt != null && (max == null || m.mergedAt > max)) ? m.mergedAt : max, null);
  let awaitingQa = 0;
  let awaitingProd = 0;
  for (const m of repoMerged) {
    if (m.terminalLiveAt != null) continue;                                               // fully deployed
    if (newestTerminalMergedAt != null && m.mergedAt < newestTerminalMergedAt) continue;  // superseded (#205)
    if (m.firstLiveAt != null) awaitingProd += 1; // on first env, awaiting terminal
    else awaitingQa += 1;                          // not yet on first env
  }
  return { envs, firstEnv, terminalEnv, awaitingQa, awaitingProd, chain: deployChain(repoMerged) };
}
