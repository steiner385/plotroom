import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppTokenSource, createTokenSource, deriveRestBase } from '../auth';

// ---- fixtures ---------------------------------------------------------------

let dir: string;
let pemPath: string;
let publicKey: KeyObject;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'prdash-app-auth-'));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  publicKey = pair.publicKey;
  pemPath = join(dir, 'app.private-key.pem');
  writeFileSync(pemPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T0 = 1_700_000_000_000; // fixed epoch ms for the injectable clock

interface FetchCall { url: string; method: string; auth: string | undefined }

/** Routing fetch mock: handlers keyed by `METHOD path`; records every call. */
function makeFetch(handlers: Record<string, (call: FetchCall) => { status: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: FetchCall = { url, method, auth: headers.authorization };
    calls.push(call);
    const key = `${method} ${new URL(url).pathname}`;
    const handler = handlers[key];
    if (!handler) return new Response('not found', { status: 404 });
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const okToken = (token: string, expiresAtMs: number) =>
  ({ status: 201, body: { token, expires_at: new Date(expiresAtMs).toISOString() } });

function source(opts: {
  fetchFn: typeof fetch; now?: () => number; installationId?: number; apiUrl?: string;
  appId?: number; privateKeyPath?: string;
}) {
  return new AppTokenSource({
    appId: opts.appId ?? 12345,
    privateKeyPath: opts.privateKeyPath ?? pemPath,
    installationId: opts.installationId,
    apiUrl: opts.apiUrl,
    fetchFn: opts.fetchFn,
    now: opts.now ?? (() => T0),
  });
}

// ---- deriveRestBase ----------------------------------------------------------

describe('deriveRestBase', () => {
  it('maps the default GraphQL endpoint to api.github.com', () => {
    expect(deriveRestBase('https://api.github.com/graphql')).toBe('https://api.github.com');
  });

  it('maps a GitHub Enterprise /api/graphql endpoint to /api/v3', () => {
    expect(deriveRestBase('https://ghe.example.com/api/graphql')).toBe('https://ghe.example.com/api/v3');
  });
});

// ---- AppTokenSource ----------------------------------------------------------

describe('AppTokenSource', () => {
  it('mints an RS256 app JWT that verifies against the public key, with correct claims', async () => {
    const { fn, calls } = makeFetch({
      'POST /app/installations/77/access_tokens': () => okToken('ghs_tok1', T0 + 3600_000),
    });
    await source({ fetchFn: fn, installationId: 77 }).get();

    const jwt = calls[0].auth?.replace(/^Bearer /, '');
    expect(jwt).toBeTruthy();
    const [h, p, s] = jwt!.split('.');
    expect(cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toEqual({ iat: T0 / 1000 - 60, exp: T0 / 1000 + 540, iss: '12345' });
  });

  it('POSTs to the configured installation id, returns the token, and caches it', async () => {
    const { fn, calls } = makeFetch({
      'POST /app/installations/77/access_tokens': () => okToken('ghs_tok1', T0 + 3600_000),
    });
    const ts = source({ fetchFn: fn, installationId: 77 });
    expect(await ts.get()).toBe('ghs_tok1');
    expect(await ts.get()).toBe('ghs_tok1');
    expect(calls).toHaveLength(1); // cached — no second mint, no discovery call
    expect(calls[0].url).toBe('https://api.github.com/app/installations/77/access_tokens');
  });

  it('re-mints when the cached token is within 5 minutes of expiry', async () => {
    let nowMs = T0;
    let n = 0;
    const { fn, calls } = makeFetch({
      'POST /app/installations/77/access_tokens':
        () => okToken(`ghs_tok${++n}`, nowMs + 3600_000),
    });
    const ts = source({ fetchFn: fn, installationId: 77, now: () => nowMs });
    expect(await ts.get()).toBe('ghs_tok1');

    nowMs = T0 + 3600_000 - 10 * 60_000; // 10 min left → still fresh
    expect(await ts.get()).toBe('ghs_tok1');
    expect(calls).toHaveLength(1);

    nowMs = T0 + 3600_000 - 4 * 60_000; // 4 min left → re-mint
    expect(await ts.get()).toBe('ghs_tok2');
    expect(calls).toHaveLength(2);
  });

  it('refresh() forces a re-mint even when the cached token is fresh', async () => {
    let n = 0;
    const { fn, calls } = makeFetch({
      'POST /app/installations/77/access_tokens': () => okToken(`ghs_tok${++n}`, T0 + 3600_000),
    });
    const ts = source({ fetchFn: fn, installationId: 77 });
    expect(await ts.get()).toBe('ghs_tok1');
    expect(await ts.refresh()).toBe('ghs_tok2');
    expect(await ts.get()).toBe('ghs_tok2');
    expect(calls).toHaveLength(2);
  });

  it('concurrent get() calls share one mint', async () => {
    const { fn, calls } = makeFetch({
      'POST /app/installations/77/access_tokens': () => okToken('ghs_tok1', T0 + 3600_000),
    });
    const ts = source({ fetchFn: fn, installationId: 77 });
    const [a, b] = await Promise.all([ts.get(), ts.get()]);
    expect(a).toBe('ghs_tok1');
    expect(b).toBe('ghs_tok1');
    expect(calls).toHaveLength(1);
  });

  it('auto-discovers a single installation when installationId is absent', async () => {
    const { fn, calls } = makeFetch({
      'GET /app/installations': () => ({ status: 200, body: [{ id: 88, account: { login: 'acme' } }] }),
      'POST /app/installations/88/access_tokens': () => okToken('ghs_tok1', T0 + 3600_000),
    });
    const ts = source({ fetchFn: fn });
    expect(await ts.get()).toBe('ghs_tok1');
    // discovery result is remembered — a later refresh skips the list call
    await ts.refresh();
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('zero installations → clear "install the app first" error', async () => {
    const { fn } = makeFetch({ 'GET /app/installations': () => ({ status: 200, body: [] }) });
    await expect(source({ fetchFn: fn }).get()).rejects.toThrow(/install the app first/i);
  });

  it('multiple installations → error lists ids + account logins and points at app.installationId', async () => {
    const { fn } = makeFetch({
      'GET /app/installations': () => ({
        status: 200,
        body: [{ id: 11, account: { login: 'acme' } }, { id: 22, account: { login: 'globex' } }],
      }),
    });
    const err = await source({ fetchFn: fn }).get().catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/11 \(acme\)/);
    expect((err as Error).message).toMatch(/22 \(globex\)/);
    expect((err as Error).message).toMatch(/app\.installationId/);
  });

  it('uses the REST base derived from a GitHub Enterprise apiUrl', async () => {
    const { fn, calls } = makeFetch({
      'POST /api/v3/app/installations/77/access_tokens': () => okToken('ghs_tok1', T0 + 3600_000),
    });
    await source({ fetchFn: fn, installationId: 77, apiUrl: 'https://ghe.example.com/api/graphql' }).get();
    expect(calls[0].url).toBe('https://ghe.example.com/api/v3/app/installations/77/access_tokens');
  });

  it('missing key file → clear construction error naming the path', () => {
    expect(() => source({ fetchFn: fetch, privateKeyPath: join(dir, 'nope.pem') }))
      .toThrow(/tokenSource "app".*nope\.pem/);
  });

  it('bad PEM content → clear construction error', () => {
    const bad = join(dir, 'bad.pem');
    writeFileSync(bad, 'this is not a key');
    expect(() => source({ fetchFn: fetch, privateKeyPath: bad }))
      .toThrow(/not a valid PEM private key/);
  });

  it('HTTP failures produce errors that never embed the JWT or a token', async () => {
    let n = 0;
    const { fn } = makeFetch({
      'POST /app/installations/77/access_tokens': () =>
        ++n === 1 ? okToken('ghs_secret_tok', T0 + 3600_000) : { status: 500, body: { message: 'boom' } },
    });
    const ts = source({ fetchFn: fn, installationId: 77 });
    await ts.get();
    const err = await ts.refresh().catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 500/);
    expect((err as Error).message).not.toMatch(/ghs_/); // no installation token
    expect((err as Error).message).not.toMatch(/eyJ/);  // no JWT material
  });

  it('access_tokens response missing fields → clear error', async () => {
    const { fn } = makeFetch({
      'POST /app/installations/77/access_tokens': () => ({ status: 201, body: { nope: true } }),
    });
    await expect(source({ fetchFn: fn, installationId: 77 }).get())
      .rejects.toThrow(/missing token/);
  });
});

// ---- createTokenSource('app') -------------------------------------------------

describe("createTokenSource tokenSource 'app'", () => {
  it('maps to AppTokenSource using the app block + apiUrl', () => {
    const ts = createTokenSource({
      tokenSource: 'app',
      apiUrl: 'https://api.github.com/graphql',
      app: { appId: 12345, privateKeyPath: pemPath },
    });
    expect(ts).toBeInstanceOf(AppTokenSource);
  });

  it('throws a clear error when the app block is missing', () => {
    expect(() => createTokenSource({ tokenSource: 'app' })).toThrow(/"app" config block/);
  });
});
