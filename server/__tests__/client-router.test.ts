import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppJwtSigner, InstallationRegistry } from '../auth';
import type { GithubClient } from '../github';
import { ClientRouter } from '../client-router';

// ---- fixtures ---------------------------------------------------------------

let dir: string;
let pemPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'prdash-client-router-'));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  pemPath = join(dir, 'app.private-key.pem');
  writeFileSync(pemPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T0 = 1_700_000_000_000;

function fakeSingle(remaining: number | null = null): GithubClient {
  return { remaining, resetAt: null, graphql: vi.fn(async () => ({})) } as unknown as GithubClient;
}

/**
 * Full App-mode fetch fake: serves installation discovery, per-installation
 * token mints (token = `ghs_tok<id>`), and a GraphQL endpoint that records the
 * bearer token of every query and answers with a per-token rateLimit.
 */
function makeAppFetch(remainingByToken: Record<string, number>) {
  const graphqlAuths: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const path = new URL(url).pathname;
    if (method === 'GET' && path === '/app/installations') {
      return json([{ id: 11, account: { login: 'acme' } }, { id: 22, account: { login: 'globex' } }]);
    }
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (mint && method === 'POST') {
      return json({ token: `ghs_tok${mint[1]}`, expires_at: new Date(T0 + 3600_000).toISOString() }, 201);
    }
    if (method === 'POST' && path === '/graphql') {
      const token = headers.authorization!.replace(/^Bearer /, '');
      graphqlAuths.push(token);
      return json({ data: { rateLimit: {
        remaining: remainingByToken[token] ?? 0, resetAt: '2026-06-11T00:00:00Z' } } });
    }
    return new Response('not found', { status: 404 });
  });
  return { fn: fn as unknown as typeof fetch, graphqlAuths };
}

async function loadedRouter(remainingByToken: Record<string, number> = {}) {
  const { fn, graphqlAuths } = makeAppFetch(remainingByToken);
  const signer = new AppJwtSigner({ appId: 12345, privateKeyPath: pemPath, now: () => T0 });
  const registry = new InstallationRegistry({ signer, fetchFn: fn });
  await registry.load();
  const router = ClientRouter.forRegistry(registry, { fetchFn: fn });
  return { router, graphqlAuths };
}

// ---- forSingle ----------------------------------------------------------------

describe('ClientRouter.forSingle', () => {
  it('routes every owner to the one client', () => {
    const c = fakeSingle();
    const r = ClientRouter.forSingle(c);
    expect(r.clientFor('acme')).toBe(c);
    expect(r.clientFor('anything-else')).toBe(c);
    expect(r.allClients()).toEqual([c]);
  });

  it('minRemaining mirrors the single client (null until it reports)', () => {
    const c = fakeSingle();
    const r = ClientRouter.forSingle(c);
    expect(r.minRemaining()).toBeNull();
    (c as { remaining: number | null }).remaining = 1234;
    expect(r.minRemaining()).toBe(1234);
  });
});

// ---- forRegistry ----------------------------------------------------------------

describe('ClientRouter.forRegistry', () => {
  it('each owner gets a client bound to its own installation token', async () => {
    const { router, graphqlAuths } = await loadedRouter();
    await router.clientFor('acme')!.graphql('query { x }');
    await router.clientFor('globex')!.graphql('query { x }');
    expect(graphqlAuths).toEqual(['ghs_tok11', 'ghs_tok22']);
  });

  it('clientFor is case-insensitive and returns the same cached client instance', async () => {
    const { router } = await loadedRouter();
    const a = router.clientFor('acme');
    expect(a).not.toBeNull();
    expect(router.clientFor('ACME')).toBe(a);
    expect(router.clientFor('acme')).toBe(a);
    expect(router.allClients()).toEqual([a]); // only created clients are tracked
  });

  it('unknown owner → null (caller logs once and skips)', async () => {
    const { router } = await loadedRouter();
    expect(router.clientFor('ghost')).toBeNull();
  });

  it('minRemaining is the min across reporting clients, null-safe before any call', async () => {
    const { router } = await loadedRouter({ ghs_tok11: 4000, ghs_tok22: 700 });
    expect(router.minRemaining()).toBeNull();           // no clients created yet
    const acme = router.clientFor('acme')!;
    expect(router.minRemaining()).toBeNull();           // created but not yet reported
    await acme.graphql('query { x }');
    expect(router.minRemaining()).toBe(4000);
    await router.clientFor('globex')!.graphql('query { x }');
    expect(router.minRemaining()).toBe(700);            // min across both budgets
  });
});
