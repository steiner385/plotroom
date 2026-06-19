import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppJwtSigner, AppTokenSource, InstallationRegistry, createTokenSource, deriveRestBase } from '../auth';

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

// ---- AppJwtSigner --------------------------------------------------------------

describe('AppJwtSigner', () => {
  it('one signer is shareable across N token sources (no per-source PEM read)', async () => {
    const signer = new AppJwtSigner({ appId: 999, privateKeyPath: pemPath, now: () => T0 });
    const { fn, calls } = makeFetch({
      'POST /app/installations/11/access_tokens': () => okToken('ghs_tok11', T0 + 3600_000),
      'POST /app/installations/22/access_tokens': () => okToken('ghs_tok22', T0 + 3600_000),
    });
    // Built from the signer alone — the options carry no privateKeyPath, so a
    // per-source PEM re-read is impossible by construction.
    const a = new AppTokenSource({ signer, installationId: 11, fetchFn: fn, now: () => T0 });
    const b = new AppTokenSource({ signer, installationId: 22, fetchFn: fn, now: () => T0 });
    expect(await a.get()).toBe('ghs_tok11');
    expect(await b.get()).toBe('ghs_tok22');
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/app/installations/11/access_tokens',
      'https://api.github.com/app/installations/22/access_tokens',
    ]);
    // both JWTs come from the shared signer: same iss claim, verify against the key
    for (const call of calls) {
      const jwt = call.auth!.replace(/^Bearer /, '');
      const [h, p, s] = jwt.split('.');
      expect(cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
      expect(JSON.parse(Buffer.from(p!, 'base64url').toString()).iss).toBe('999');
    }
  });

  it('missing key file → clear construction error naming the path', () => {
    expect(() => new AppJwtSigner({ appId: 1, privateKeyPath: join(dir, 'nope.pem') }))
      .toThrow(/tokenSource "app".*nope\.pem/);
  });

  // ---- R1: inline privateKey string -------------------------------------------

  it('inline privateKey string: constructs without reading a file and mints a valid JWT', () => {
    const { privateKey: privKeyObj, publicKey: pubKeyObj } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pemStr = privKeyObj.export({ type: 'pkcs8', format: 'pem' }) as string;
    const signer = new AppJwtSigner({ appId: 42, privateKey: pemStr, now: () => T0 });
    const jwt = signer.mint();
    const [h, p, s] = jwt.split('.');
    expect(cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), pubKeyObj, Buffer.from(s!, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(claims.iss).toBe('42');
  });

  it('privateKeyPath still works (regression)', () => {
    const signer = new AppJwtSigner({ appId: 999, privateKeyPath: pemPath, now: () => T0 });
    const jwt = signer.mint();
    const [h, p, s] = jwt.split('.');
    expect(cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
  });

  it('neither privateKey nor privateKeyPath → clear error', () => {
    expect(() => new AppJwtSigner({ appId: 1 } as never))
      .toThrow(/tokenSource "app": requires privateKey or privateKeyPath/);
  });

  it('invalid inline PEM → clear error without a file path', () => {
    expect(() => new AppJwtSigner({ appId: 1, privateKey: 'not-a-pem' }))
      .toThrow(/the provided privateKey is not a valid PEM private key/);
  });

  it('AppTokenSource accepts inline privateKey and mints a valid JWT', async () => {
    const { privateKey: privKeyObj } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pemStr = privKeyObj.export({ type: 'pkcs8', format: 'pem' }) as string;
    const { fn } = makeFetch({
      'POST /app/installations/77/access_tokens': () => okToken('ghs_inlinekey', T0 + 3600_000),
    });
    const ts = new AppTokenSource({
      appId: 99, privateKey: pemStr, installationId: 77, fetchFn: fn, now: () => T0,
    });
    expect(await ts.get()).toBe('ghs_inlinekey');
  });
});

// ---- InstallationRegistry ------------------------------------------------------

describe('InstallationRegistry', () => {
  const signer = () => new AppJwtSigner({ appId: 12345, privateKeyPath: pemPath, now: () => T0 });

  it('load() maps installation accounts; installationFor is case-insensitive', async () => {
    const { fn } = makeFetch({
      'GET /app/installations': () => ({ status: 200,
        body: [{ id: 11, account: { login: 'Acme' } }, { id: 22, account: { login: 'globex' } }] }),
    });
    const reg = new InstallationRegistry({ signer: signer(), fetchFn: fn });
    await reg.load();
    expect(reg.accounts()).toEqual([{ id: 11, login: 'Acme' }, { id: 22, login: 'globex' }]);
    expect(reg.installationFor('acme')).toBe(11);
    expect(reg.installationFor('ACME')).toBe(11);
    expect(reg.installationFor('globex')).toBe(22);
    expect(reg.installationFor('ghost')).toBeNull();
  });

  it('refresh() picks up newly added installations', async () => {
    let n = 0;
    const { fn } = makeFetch({
      'GET /app/installations': () => ({ status: 200,
        body: ++n === 1
          ? [{ id: 11, account: { login: 'acme' } }]
          : [{ id: 11, account: { login: 'acme' } }, { id: 33, account: { login: 'newco' } }] }),
    });
    const reg = new InstallationRegistry({ signer: signer(), fetchFn: fn });
    await reg.load();
    expect(reg.installationFor('newco')).toBeNull();
    await reg.refresh();
    expect(reg.installationFor('newco')).toBe(33);
    expect(reg.installationFor('acme')).toBe(11);
  });

  it('app.installationId restricts the registry to that one installation', async () => {
    const { fn, calls } = makeFetch({
      'GET /app/installations/22': () => ({ status: 200, body: { id: 22, account: { login: 'globex' } } }),
    });
    const reg = new InstallationRegistry({ signer: signer(), fetchFn: fn, installationId: 22 });
    await reg.load();
    expect(reg.accounts()).toEqual([{ id: 22, login: 'globex' }]);
    expect(reg.installationFor('globex')).toBe(22);
    expect(reg.installationFor('acme')).toBeNull();
    // login resolved via GET /app/installations/{id} — never the full list
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/app/installations/22']);
  });

  it('zero installations → clear "install the app first" error', async () => {
    const { fn } = makeFetch({ 'GET /app/installations': () => ({ status: 200, body: [] }) });
    const reg = new InstallationRegistry({ signer: signer(), fetchFn: fn });
    await expect(reg.load()).rejects.toThrow(/install the app first/i);
  });

  it('uses the REST base derived from a GitHub Enterprise apiUrl', async () => {
    const { fn, calls } = makeFetch({
      'GET /api/v3/app/installations': () => ({ status: 200, body: [{ id: 11, account: { login: 'acme' } }] }),
    });
    const reg = new InstallationRegistry({
      signer: signer(), fetchFn: fn, apiUrl: 'https://ghe.example.com/api/graphql' });
    await reg.load();
    expect(calls[0]!.url).toBe('https://ghe.example.com/api/v3/app/installations');
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
