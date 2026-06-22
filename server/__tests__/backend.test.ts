import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrDashboardBackend } from '../backend';
import { DEFAULTS, type AppConfig } from '../config';

// Inline App key (mirrors T1 / app-auth.test.ts) so the factory's App-mode token
// source builds without a key file.
let privateKey: string;
let dir: string;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prdash-backend-'));
  // Route every network call to a safe empty response. The only call the factory
  // makes during build-up is the App's installation listing (App mode); the
  // poller's refresh loops are no-ops with no repos configured.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/app/installations')) {
      return new Response(JSON.stringify([{ id: 42, account: { login: 'acme' } }]), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    // GraphQL / other REST: an empty-ish OK so any stray poller call is harmless.
    return new Response(JSON.stringify({ data: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** A complete AppConfig for App mode with one configured owner (so resolveOwners
 *  short-circuits) and no repos (so poller refresh loops are no-ops). */
function appConfig(): AppConfig {
  return {
    ...DEFAULTS,
    tokenSource: 'app',
    owners: ['acme'],
    app: { appId: 12345, privateKey },
  };
}

async function build() {
  return createPrDashboardBackend({
    config: appConfig(),
    dataDir: dir,
    githubApp: { appId: 12345, privateKey },
  });
}

describe('createPrDashboardBackend', () => {
  it('returns a mountable router (no .listen invoked) and a startPoller fn', async () => {
    const be = await build();
    expect(typeof be.router).toBe('function');           // an Express app is callable
    expect(typeof be.router.listen).toBe('function');    // .listen exists but we never called it
    expect(typeof be.startPoller).toBe('function');
    expect(be.store.history).toBeTruthy();
    expect(be.store.workspace).toBeTruthy();
  });

  it('mounts under a SUB-PATH: GET /sub/api/state responds', async () => {
    const be = await build();
    const host = express();
    host.use('/sub', be.router);
    const res = await request(host).get('/sub/api/state');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.repos)).toBe(true);
  });

  it('opens a relative SSE stream under a sub-path (/sub/api/events)', async () => {
    const be = await build();
    const host = express();
    host.use('/sub', be.router);
    const res = await request(host).get('/sub/api/events')
      .parse((r, cb) => {
        let data = '';
        r.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (data.includes('\n\n')) { (r as any).destroy(); cb(null, data); }
        });
      });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(String(res.body)).toContain('data:');
  });

  it('startPoller() returns a stop fn that stops cleanly', async () => {
    const be = await build();
    const stop = be.startPoller();
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('startup re-scans the retention merged window even on an already-backfilled DB', async () => {
    // Recovery / self-heal: merges that landed while we were down (restart,
    // outage) are otherwise never re-scanned — the routine window never looks
    // back far enough. On every boot the first sweep's merged window is widened
    // to the full retention period, regardless of the one-time `backfilled` flag.
    const be = await build();
    const h = be.store.history;
    h.setMeta('backfilled', '2026-06-01T00:00:00Z');     // NOT a fresh DB
    h.setMeta('lastSweep', new Date().toISOString());    // pretend we swept moments ago
    const stop = be.startPoller();                        // sync prefix runs before first await
    const widened = h.getMeta('lastSweep')!;
    stop();
    const ageDays = (Date.now() - new Date(widened).getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(DEFAULTS.retentionDays - 0.5);
  });

  it('default trustHostAuth: a mutating POST from a disallowed Origin is NOT 403', async () => {
    const be = await build();
    const host = express();
    host.use('/sub', be.router);
    // PUT /api/config with a cross-origin Origin would be 403 under the built-in
    // guard; with trustHostAuth (default) the guard is a pass-through, so the
    // request reaches the handler (200/400, never the origin-guard 403).
    const res = await request(host)
      .put('/sub/api/config')
      .set('Origin', 'https://evil.example.com')
      .send({ batchSize: 5 });
    expect(res.status).not.toBe(403);
  });

  it('/api/admin/restart does NOT exit the process (no-op exit)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit must not be called by the mounted backend');
    }) as never);
    try {
      const be = await build();
      const host = express();
      host.use('/sub', be.router);
      const res = await request(host).post('/sub/api/admin/restart');
      expect(res.status).toBe(202);
      // Give the (no-op) restart timer a beat; it must not call process.exit.
      await new Promise((r) => setTimeout(r, 350));
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
