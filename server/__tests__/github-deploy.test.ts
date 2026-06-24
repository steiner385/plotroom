import { describe, it, expect } from 'vitest';
import {
  fetchEnvironments,
  fetchRecentDeployments,
  fetchDeploymentState,
  inferDeployTopology,
  type DeployClient,
  type DeploymentRec,
  type DeploymentWithState,
} from '../github-deploy';

/** Minimal fake client: restGet returns the canned value for the matching path prefix */
function makeClient(responses: Map<string, unknown>): DeployClient {
  return {
    async restGet<T = unknown>(path: string): Promise<T> {
      for (const [key, val] of responses) {
        if (path.startsWith(key) || path === key) return val as T;
      }
      throw new Error(`No canned response for path: ${path}`);
    },
  };
}

// ---------------------------------------------------------------------------
// fetchEnvironments
// ---------------------------------------------------------------------------

describe('fetchEnvironments', () => {
  it('returns environment names from a well-formed body', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/environments',
        { environments: [{ name: 'production' }, { name: 'staging' }] },
      ]]),
    );
    const envs = await fetchEnvironments(client, 'owner/repo');
    expect(envs).toEqual(['production', 'staging']);
  });

  it('returns [] when the body has no environments field', async () => {
    const client = makeClient(
      new Map([['/repos/owner/repo/environments', {}]]),
    );
    const envs = await fetchEnvironments(client, 'owner/repo');
    expect(envs).toEqual([]);
  });

  it('filters out empty-string environment names', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/environments',
        { environments: [{ name: '' }, { name: 'production' }] },
      ]]),
    );
    const envs = await fetchEnvironments(client, 'owner/repo');
    expect(envs).toEqual(['production']);
  });

  it('returns [] when the body is completely missing (undefined)', async () => {
    const client = makeClient(
      new Map([['/repos/owner/repo/environments', undefined]]),
    );
    const envs = await fetchEnvironments(client, 'owner/repo');
    expect(envs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchRecentDeployments
// ---------------------------------------------------------------------------

describe('fetchRecentDeployments', () => {
  it('maps well-formed items to DeploymentRec[]', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments',
        [
          { id: 1, environment: 'production', sha: 'abc123', created_at: '2024-01-01T00:00:00Z' },
          { id: 2, environment: 'staging',    sha: 'def456', created_at: '2024-01-02T00:00:00Z' },
        ],
      ]]),
    );
    const recs = await fetchRecentDeployments(client, 'owner/repo');
    expect(recs).toHaveLength(2);
    expect(recs[0]).toEqual<DeploymentRec>({
      id: 1,
      environment: 'production',
      sha: 'abc123',
      createdAt: '2024-01-01T00:00:00Z',
    });
    expect(recs[1]).toEqual<DeploymentRec>({
      id: 2,
      environment: 'staging',
      sha: 'def456',
      createdAt: '2024-01-02T00:00:00Z',
    });
  });

  it('skips an item missing sha', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments',
        [
          { id: 1, environment: 'production', created_at: '2024-01-01T00:00:00Z' }, // missing sha
          { id: 2, environment: 'staging', sha: 'abc', created_at: '2024-01-02T00:00:00Z' },
        ],
      ]]),
    );
    const recs = await fetchRecentDeployments(client, 'owner/repo');
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe(2);
  });

  it('skips an item missing a numeric id', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments',
        [
          { id: 'not-a-number', environment: 'production', sha: 'abc', created_at: '2024-01-01T00:00:00Z' },
          { id: 3, environment: 'staging', sha: 'def', created_at: '2024-01-02T00:00:00Z' },
        ],
      ]]),
    );
    const recs = await fetchRecentDeployments(client, 'owner/repo');
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe(3);
  });

  it('skips an item missing environment', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments',
        [
          { id: 4, sha: 'abc', created_at: '2024-01-01T00:00:00Z' }, // missing environment
          { id: 5, environment: 'staging', sha: 'def', created_at: '2024-01-02T00:00:00Z' },
        ],
      ]]),
    );
    const recs = await fetchRecentDeployments(client, 'owner/repo');
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe(5);
  });

  it('skips an item missing created_at', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments',
        [
          { id: 6, environment: 'production', sha: 'abc' }, // missing created_at
          { id: 7, environment: 'staging', sha: 'def', created_at: '2024-01-02T00:00:00Z' },
        ],
      ]]),
    );
    const recs = await fetchRecentDeployments(client, 'owner/repo');
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe(7);
  });

  it('passes the correct per_page query parameter', async () => {
    let capturedPath = '';
    const client: DeployClient = {
      async restGet<T>(path: string): Promise<T> {
        capturedPath = path;
        return [] as T;
      },
    };
    await fetchRecentDeployments(client, 'owner/repo', 50);
    expect(capturedPath).toContain('per_page=50');
  });

  it('returns [] when the response is not an array', async () => {
    const client = makeClient(
      new Map([['/repos/owner/repo/deployments', { message: 'Not Found' }]]),
    );
    const recs = await fetchRecentDeployments(client, 'owner/repo');
    expect(recs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchDeploymentState
// ---------------------------------------------------------------------------

describe('fetchDeploymentState', () => {
  it('returns the state and createdAt of the first (newest) status', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments/42/statuses',
        [{ state: 'success', created_at: '2024-01-03T00:00:00Z' }],
      ]]),
    );
    const result = await fetchDeploymentState(client, 'owner/repo', 42);
    expect(result).toEqual({ state: 'success', createdAt: '2024-01-03T00:00:00Z' });
  });

  it('returns null when the statuses array is empty', async () => {
    const client = makeClient(
      new Map([['/repos/owner/repo/deployments/42/statuses', []]]),
    );
    const result = await fetchDeploymentState(client, 'owner/repo', 42);
    expect(result).toBeNull();
  });

  it('returns null when the response is not an array', async () => {
    const client = makeClient(
      new Map([['/repos/owner/repo/deployments/42/statuses', null]]),
    );
    const result = await fetchDeploymentState(client, 'owner/repo', 42);
    expect(result).toBeNull();
  });

  it('returns null when the first item is missing state', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments/42/statuses',
        [{ created_at: '2024-01-03T00:00:00Z' }],
      ]]),
    );
    const result = await fetchDeploymentState(client, 'owner/repo', 42);
    expect(result).toBeNull();
  });

  it('returns null when the first item is missing created_at', async () => {
    const client = makeClient(
      new Map([[
        '/repos/owner/repo/deployments/42/statuses',
        [{ state: 'success' }],
      ]]),
    );
    const result = await fetchDeploymentState(client, 'owner/repo', 42);
    expect(result).toBeNull();
  });

  it('passes per_page=1 in the path', async () => {
    let capturedPath = '';
    const client: DeployClient = {
      async restGet<T>(path: string): Promise<T> {
        capturedPath = path;
        return [] as T;
      },
    };
    await fetchDeploymentState(client, 'owner/repo', 99);
    expect(capturedPath).toContain('per_page=1');
  });
});

// ---------------------------------------------------------------------------
// inferDeployTopology
// ---------------------------------------------------------------------------

/** Helper: build a DeploymentWithState */
function dws(
  environment: string,
  sha: string,
  createdAt: string,
  state: string,
): DeploymentWithState {
  return { environment, sha, createdAt, state };
}

describe('inferDeployTopology', () => {
  it('returns empty order and liveSha for empty input', () => {
    const result = inferDeployTopology([]);
    expect(result).toEqual({ order: [], liveSha: {} });
  });

  it('handles a single environment', () => {
    const result = inferDeployTopology([
      dws('production', 'sha1', '2024-01-01T10:00:00Z', 'success'),
    ]);
    expect(result.order).toEqual(['production']);
    expect(result.liveSha).toEqual({ production: 'sha1' });
  });

  it('infers staging → production order from two shas, each reaching staging earlier', () => {
    // sha1: staging at T1, production at T2 (T1 < T2)
    // sha2: staging at T3, production at T4 (T3 < T4)
    const result = inferDeployTopology([
      dws('staging',    'sha1', '2024-01-01T01:00:00Z', 'success'),
      dws('production', 'sha1', '2024-01-01T02:00:00Z', 'success'),
      dws('staging',    'sha2', '2024-01-02T01:00:00Z', 'success'),
      dws('production', 'sha2', '2024-01-02T02:00:00Z', 'success'),
    ]);
    expect(result.order).toEqual(['staging', 'production']);
    // liveSha = newest success sha per env → sha2 for both
    expect(result.liveSha).toEqual({ staging: 'sha2', production: 'sha2' });
  });

  it('liveSha reflects newest success sha per env, not earliest', () => {
    const result = inferDeployTopology([
      dws('staging',    'sha1', '2024-01-01T00:00:00Z', 'success'),
      dws('production', 'sha1', '2024-01-01T01:00:00Z', 'success'),
      dws('staging',    'sha2', '2024-01-03T00:00:00Z', 'success'),
      dws('production', 'sha2', '2024-01-03T01:00:00Z', 'success'),
    ]);
    expect(result.liveSha.staging).toBe('sha2');
    expect(result.liveSha.production).toBe('sha2');
  });

  it('no-overlap fallback: sha-A only hits staging, sha-B only hits production — orders by earliest first success', () => {
    // staging got sha-A at T1, production got sha-B at T2, T1 < T2
    const result = inferDeployTopology([
      dws('staging',    'sha-A', '2024-01-01T00:00:00Z', 'success'),
      dws('production', 'sha-B', '2024-01-02T00:00:00Z', 'success'),
    ]);
    expect(result.order).toEqual(['staging', 'production']);
    expect(result.liveSha).toEqual({ staging: 'sha-A', production: 'sha-B' });
  });

  it('non-success states are ignored for both order and liveSha', () => {
    const result = inferDeployTopology([
      // only success entry
      dws('staging',    'sha1', '2024-01-01T01:00:00Z', 'success'),
      // failure/in_progress entries that should be invisible
      dws('production', 'sha1', '2024-01-01T00:30:00Z', 'failure'),
      dws('production', 'sha1', '2024-01-01T00:45:00Z', 'in_progress'),
    ]);
    // production has no success so should not appear in liveSha
    expect(result.liveSha).toEqual({ staging: 'sha1' });
    // production has no success deployments → appears in order only if it has ≥1 success
    // (here it has none, so order should only contain staging)
    expect(result.order).toEqual(['staging']);
  });

  it('ignores non-success state entries and ranks correctly with valid successes', () => {
    // sha1: staging success at T1, production success at T2
    // sha2: production failure (should not give rank evidence), staging success at T3
    const result = inferDeployTopology([
      dws('staging',    'sha1', '2024-01-01T01:00:00Z', 'success'),
      dws('production', 'sha1', '2024-01-01T02:00:00Z', 'success'),
      dws('staging',    'sha2', '2024-01-02T01:00:00Z', 'success'),
      dws('production', 'sha2', '2024-01-02T02:00:00Z', 'failure'),
    ]);
    // Only sha1 is a multi-env success sha
    expect(result.order).toEqual(['staging', 'production']);
    // liveSha for staging: sha2 (newer). production: sha1 (only success)
    expect(result.liveSha.staging).toBe('sha2');
    expect(result.liveSha.production).toBe('sha1');
  });

  it('infers correct 3-env order: dev → staging → production', () => {
    // sha1: dev T1, staging T2, production T3
    // sha2: dev T4, staging T5, production T6
    const result = inferDeployTopology([
      dws('dev',        'sha1', '2024-01-01T01:00:00Z', 'success'),
      dws('staging',    'sha1', '2024-01-01T02:00:00Z', 'success'),
      dws('production', 'sha1', '2024-01-01T03:00:00Z', 'success'),
      dws('dev',        'sha2', '2024-01-02T01:00:00Z', 'success'),
      dws('staging',    'sha2', '2024-01-02T02:00:00Z', 'success'),
      dws('production', 'sha2', '2024-01-02T03:00:00Z', 'success'),
    ]);
    expect(result.order).toEqual(['dev', 'staging', 'production']);
    expect(result.liveSha).toEqual({ dev: 'sha2', staging: 'sha2', production: 'sha2' });
  });

  it('uses earliest (sha,env) success when an env is deployed multiple times for the same sha', () => {
    // staging gets sha1 twice — earliest used for ranking
    // production gets sha1 once, after staging's earliest
    const result = inferDeployTopology([
      dws('staging',    'sha1', '2024-01-01T01:00:00Z', 'success'), // earlier staging
      dws('staging',    'sha1', '2024-01-01T05:00:00Z', 'success'), // later staging (same sha)
      dws('production', 'sha1', '2024-01-01T03:00:00Z', 'success'), // production between the two stagings
    ]);
    // With earliest (sha1,staging) = T1 and (sha1,production) = T3: staging rank 0, production rank 1
    expect(result.order).toEqual(['staging', 'production']);
  });

  it('tie-break by earliest-ever success createdAt when mean ranks are equal', () => {
    // sha1 only hits env-A → no rank evidence for either via sha1 alone
    // sha2 only hits env-B → same
    // Both fall back to "no rank evidence" → sorted by earliest first success
    // env-A earliest: T1, env-B earliest: T2 → env-A first
    const result = inferDeployTopology([
      dws('env-A', 'sha1', '2024-01-01T00:00:00Z', 'success'),
      dws('env-B', 'sha2', '2024-01-02T00:00:00Z', 'success'),
    ]);
    expect(result.order).toEqual(['env-A', 'env-B']);
  });

  it('tie-break by env name lexicographically when createdAt is also equal', () => {
    // Both envs appear only with unique shas and have the exact same earliest success timestamp
    const result = inferDeployTopology([
      dws('z-env', 'sha1', '2024-01-01T00:00:00Z', 'success'),
      dws('a-env', 'sha2', '2024-01-01T00:00:00Z', 'success'),
    ]);
    expect(result.order).toEqual(['a-env', 'z-env']);
  });

  it('no duplicates in order and every env with ≥1 success appears exactly once', () => {
    const result = inferDeployTopology([
      dws('dev',        'sha1', '2024-01-01T01:00:00Z', 'success'),
      dws('staging',    'sha1', '2024-01-01T02:00:00Z', 'success'),
      dws('production', 'sha1', '2024-01-01T03:00:00Z', 'success'),
      dws('dev',        'sha1', '2024-01-01T04:00:00Z', 'success'), // duplicate (sha,env)
    ]);
    const unique = new Set(result.order);
    expect(unique.size).toBe(result.order.length);
    expect(unique).toContain('dev');
    expect(unique).toContain('staging');
    expect(unique).toContain('production');
  });
});
