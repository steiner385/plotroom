/** Structural client type — matches GithubClient.restGet without importing it. */
export interface DeployClient {
  restGet<T = unknown>(path: string): Promise<T>;
}

/** A single GitHub deployment record, normalised from the REST response. */
export interface DeploymentRec {
  id: number;
  environment: string;
  sha: string;
  createdAt: string;
}

/**
 * Returns the list of environment names configured for a repository.
 * Tolerates a missing/oddly-shaped body — returns [] in that case.
 * Does NOT catch RateLimitError/HttpError; let them propagate.
 */
export async function fetchEnvironments(
  client: DeployClient,
  repo: string,
): Promise<string[]> {
  const body = await client.restGet<unknown>(`/repos/${repo}/environments`);
  if (body == null || typeof body !== 'object') return [];
  const envs = (body as Record<string, unknown>).environments;
  if (!Array.isArray(envs)) return [];
  return envs
    .map((e: unknown) =>
      e != null && typeof e === 'object' ? (e as Record<string, unknown>).name : undefined,
    )
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/**
 * Returns up to `perPage` recent deployments for a repository.
 * Items that are missing a numeric id, string environment, string sha, or
 * string created_at are silently skipped.
 * Does NOT catch RateLimitError/HttpError; let them propagate.
 */
export async function fetchRecentDeployments(
  client: DeployClient,
  repo: string,
  perPage = 30,
): Promise<DeploymentRec[]> {
  const body = await client.restGet<unknown>(
    `/repos/${repo}/deployments?per_page=${perPage}`,
  );
  if (!Array.isArray(body)) return [];
  const results: DeploymentRec[] = [];
  for (const item of body) {
    if (item == null || typeof item !== 'object') continue;
    const { id, environment, sha, created_at } = item as Record<string, unknown>;
    if (typeof id !== 'number') continue;
    if (typeof environment !== 'string') continue;
    if (typeof sha !== 'string') continue;
    if (typeof created_at !== 'string') continue;
    results.push({ id, environment, sha, createdAt: created_at });
  }
  return results;
}

/**
 * A deployment record enriched with a deployment-status state and its timestamp.
 * `createdAt` here is the deployment-STATUS created_at for a SUCCESS state.
 */
export interface DeploymentWithState {
  environment: string;
  sha: string;
  /** The deployment-status created_at for a SUCCESS state (when the env went live on this sha). */
  createdAt: string;
  state: string;
}

/** The inferred promotion topology for a repository. */
export interface DeployTopology {
  /** Environments in inferred promotion order (first deployed → last deployed). */
  order: string[];
  /** Newest SUCCESS-state sha per environment. */
  liveSha: Record<string, string>;
}

/**
 * Pure function: infers the promotion order of environments from deployment history,
 * and the current live SHA per environment.
 *
 * Algorithm:
 * 1. Only `state === 'success'` entries are considered.
 * 2. `liveSha[env]` = sha of the NEWEST success deployment for that env (max createdAt).
 * 3. Order is inferred by ranking envs per multi-env sha: the env a sha reaches first
 *    gets rank 0, next gets rank 1, etc. Each env's score = mean of its ranks.
 *    Tie-break: earliest-ever success createdAt, then env name lexicographically.
 * 4. Envs with no rank evidence (never co-occur on a sha with another env) are appended
 *    after ranked envs, ordered by earliest-ever success createdAt, then name.
 */
export function inferDeployTopology(deployments: DeploymentWithState[]): DeployTopology {
  // Filter to successes only
  const successes = deployments.filter((d) => d.state === 'success');

  if (successes.length === 0) {
    return { order: [], liveSha: {} };
  }

  // --- liveSha: newest (max createdAt) success sha per env ---
  const liveSha: Record<string, string> = {};
  const liveByEnv = new Map<string, string>();
  const liveTimeByEnv = new Map<string, string>();
  for (const d of successes) {
    const prevTime = liveTimeByEnv.get(d.environment);
    if (prevTime === undefined || d.createdAt > prevTime) {
      liveTimeByEnv.set(d.environment, d.createdAt);
      liveByEnv.set(d.environment, d.sha);
    }
  }
  for (const [env, sha] of liveByEnv) {
    liveSha[env] = sha;
  }

  const allEnvs = [...liveByEnv.keys()];

  if (allEnvs.length === 1) {
    return { order: allEnvs, liveSha };
  }

  // --- Earliest-ever success createdAt per env (for tie-breaking and fallback) ---
  const earliestByEnv = new Map<string, string>();
  for (const d of successes) {
    const prev = earliestByEnv.get(d.environment);
    if (prev === undefined || d.createdAt < prev) {
      earliestByEnv.set(d.environment, d.createdAt);
    }
  }

  // --- Rank evidence: group by sha, find shas that hit ≥2 envs ---
  // For each (sha, env): use EARLIEST success createdAt for that pair (for ranking)
  const earliestForShaEnv = new Map<string, string>(); // key = `${sha}::${env}`
  for (const d of successes) {
    const key = `${d.sha}::${d.environment}`;
    const prev = earliestForShaEnv.get(key);
    if (prev === undefined || d.createdAt < prev) {
      earliestForShaEnv.set(key, d.createdAt);
    }
  }

  // Group envs by sha (only those with ≥2 envs are multi-env shas)
  const envsBySha = new Map<string, string[]>();
  for (const key of earliestForShaEnv.keys()) {
    const [sha, env] = key.split('::');
    if (!envsBySha.has(sha)) envsBySha.set(sha, []);
    envsBySha.get(sha)!.push(env);
  }

  // Accumulate ranks per env across all multi-env shas
  const rankLists = new Map<string, number[]>();
  for (const env of allEnvs) rankLists.set(env, []);

  for (const [sha, envList] of envsBySha) {
    if (envList.length < 2) continue; // single-env sha: no rank evidence

    // Sort envs by their earliest (sha,env) success createdAt ascending
    const sorted = [...envList].sort((a, b) => {
      const ta = earliestForShaEnv.get(`${sha}::${a}`)!;
      const tb = earliestForShaEnv.get(`${sha}::${b}`)!;
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a < b ? -1 : a > b ? 1 : 0; // tie-break by name
    });

    for (let i = 0; i < sorted.length; i++) {
      rankLists.get(sorted[i])!.push(i);
    }
  }

  // Separate envs with rank evidence from those without
  const ranked: string[] = [];
  const unranked: string[] = [];
  for (const env of allEnvs) {
    if (rankLists.get(env)!.length > 0) {
      ranked.push(env);
    } else {
      unranked.push(env);
    }
  }

  // Sort ranked envs by mean rank, tie-break by earliest createdAt, then name
  ranked.sort((a, b) => {
    const ranksA = rankLists.get(a)!;
    const ranksB = rankLists.get(b)!;
    const meanA = ranksA.reduce((s, r) => s + r, 0) / ranksA.length;
    const meanB = ranksB.reduce((s, r) => s + r, 0) / ranksB.length;
    if (meanA !== meanB) return meanA - meanB;
    const ea = earliestByEnv.get(a)!;
    const eb = earliestByEnv.get(b)!;
    if (ea < eb) return -1;
    if (ea > eb) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // Sort unranked envs by earliest-ever success createdAt, then name
  unranked.sort((a, b) => {
    const ea = earliestByEnv.get(a)!;
    const eb = earliestByEnv.get(b)!;
    if (ea < eb) return -1;
    if (ea > eb) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return { order: [...ranked, ...unranked], liveSha };
}

/**
 * Returns the most recent deployment status for a specific deployment, or
 * null if there are no statuses or the response is malformed.
 * Does NOT catch RateLimitError/HttpError; let them propagate.
 */
export async function fetchDeploymentState(
  client: DeployClient,
  repo: string,
  id: number,
): Promise<{ state: string; createdAt: string } | null> {
  const body = await client.restGet<unknown>(
    `/repos/${repo}/deployments/${id}/statuses?per_page=1`,
  );
  if (!Array.isArray(body) || body.length === 0) return null;
  const item = body[0];
  if (item == null || typeof item !== 'object') return null;
  const { state, created_at } = item as Record<string, unknown>;
  if (typeof state !== 'string') return null;
  if (typeof created_at !== 'string') return null;
  return { state, createdAt: created_at };
}
