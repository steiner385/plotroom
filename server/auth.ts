import { execFile } from 'node:child_process';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AppAuthConfig } from './config';

function fetchGhToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.GITHUB_TOKEN; // a stale env token shadows the gh keyring — for gh itself too
    delete env.GH_TOKEN;
    execFile('gh', ['auth', 'token'], { env }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`gh auth token failed: ${String(stderr).trim() || err.message}`));
      const token = String(stdout).trim();
      if (!token) return reject(new Error('gh auth token returned empty output'));
      resolve(token);
    });
  });
}

export interface TokenProvider {
  get(): Promise<string>;
  refresh(): Promise<string>;
}

export class TokenSource implements TokenProvider {
  private token: string | null = null;
  /** In-flight fetch promise, shared across concurrent callers so gh is exec'd only once. */
  private inflight: Promise<string> | null = null;

  async get(): Promise<string> {
    if (this.token) return this.token;
    if (!this.inflight) {
      this.inflight = fetchGhToken().then((t) => {
        this.token = t;
        this.inflight = null;
        return t;
      }, (err) => {
        this.inflight = null;
        throw err;
      });
    }
    return this.inflight;
  }

  async refresh(): Promise<string> {
    this.token = null;
    this.inflight = null;
    return this.get();
  }
}

/** `tokenSource: 'env'` — read the token from GITHUB_TOKEN at call time. */
export class EnvTokenSource implements TokenProvider {
  async get(): Promise<string> {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) throw new Error('tokenSource "env": GITHUB_TOKEN is not set');
    return token;
  }

  async refresh(): Promise<string> {
    return this.get();
  }
}

// ---- tokenSource 'app': GitHub App installation tokens -----------------------

/**
 * Derive the REST base URL from the configured GraphQL endpoint — App-auth
 * endpoints are REST-only. 'https://api.github.com/graphql' → 'https://api.github.com';
 * GitHub Enterprise 'https://ghe.example.com/api/graphql' → '…/api/v3'.
 */
export function deriveRestBase(apiUrl: string): string {
  const base = apiUrl.replace(/\/graphql\/?$/, '');
  return base.endsWith('/api') ? `${base}/v3` : base;
}

export interface AppTokenSourceOptions extends AppAuthConfig {
  /** GraphQL endpoint the dashboard is configured with; REST base is derived. */
  apiUrl?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Injectable clock (ms since epoch) for tests. */
  now?: () => number;
}

/** Refresh the installation token when less than this remains before expiry. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** App JWT claims: backdate iat 60s (clock drift), expire in 9 min (max 10). */
const JWT_BACKDATE_S = 60;
const JWT_TTL_S = 540;

/**
 * `tokenSource: 'app'` — GitHub App installation tokens. Mints a short-lived
 * RS256 App JWT with node:crypto, exchanges it for an installation token via
 * REST, and caches the result until close to expiry. Same TokenProvider
 * contract as the other sources: the token value is never logged and never
 * embedded in error messages.
 */
export class AppTokenSource implements TokenProvider {
  private readonly appId: number;
  private readonly key: KeyObject;
  private readonly restBase: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private installationId: number | undefined;
  private cached: { token: string; expiresAt: number } | null = null;
  /** In-flight mint, shared across concurrent callers. */
  private inflight: Promise<string> | null = null;

  constructor(opts: AppTokenSourceOptions) {
    this.appId = opts.appId;
    let pem: string;
    try {
      pem = readFileSync(opts.privateKeyPath, 'utf8');
    } catch (e) {
      throw new Error(`tokenSource "app": cannot read private key at ${opts.privateKeyPath}: `
        + (e instanceof Error ? e.message : String(e)));
    }
    try {
      this.key = createPrivateKey(pem);
    } catch {
      throw new Error(`tokenSource "app": ${opts.privateKeyPath} is not a valid PEM private key`);
    }
    this.restBase = deriveRestBase(opts.apiUrl ?? 'https://api.github.com/graphql');
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.installationId = opts.installationId;
  }

  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.now() > TOKEN_REFRESH_MARGIN_MS) {
      return this.cached.token;
    }
    return this.mintShared();
  }

  async refresh(): Promise<string> {
    this.cached = null; // an in-flight mint is already fresh — share it
    return this.mintShared();
  }

  private mintShared(): Promise<string> {
    if (!this.inflight) {
      this.inflight = this.mintInstallationToken().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  /** RS256 App JWT over base64url(header).base64url(payload) — node:crypto only. */
  private mintJwt(): string {
    const nowS = Math.floor(this.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b64({ alg: 'RS256', typ: 'JWT' });
    const payload = b64({ iat: nowS - JWT_BACKDATE_S, exp: nowS + JWT_TTL_S, iss: String(this.appId) });
    const sig = sign('RSA-SHA256', Buffer.from(`${head}.${payload}`), this.key).toString('base64url');
    return `${head}.${payload}.${sig}`;
  }

  /** JWT-authenticated REST call. Errors carry status + path, never any token. */
  private async rest(method: string, path: string, jwt: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.restBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'pr-dashboard',
      },
    });
    if (!res.ok) {
      void res.text().catch(() => { /* consume body */ });
      throw new Error(`GitHub App REST ${method} ${path}: HTTP ${res.status}`);
    }
    return res.json();
  }

  private async resolveInstallationId(jwt: string): Promise<number> {
    if (this.installationId !== undefined) return this.installationId;
    const list = (await this.rest('GET', '/app/installations', jwt)) as
      { id: number; account?: { login?: string } }[];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`tokenSource "app": App ${this.appId} has no installations — `
        + 'install the app first (App settings → Install App), then restart');
    }
    if (list.length > 1) {
      const desc = list.map((i) => `${i.id} (${i.account?.login ?? 'unknown'})`).join(', ');
      throw new Error(`tokenSource "app": App ${this.appId} has ${list.length} installations `
        + `[${desc}] — set app.installationId in the config file to pick one`);
    }
    this.installationId = list[0].id;
    return this.installationId;
  }

  private async mintInstallationToken(): Promise<string> {
    const jwt = this.mintJwt();
    const id = await this.resolveInstallationId(jwt);
    const body = (await this.rest('POST', `/app/installations/${id}/access_tokens`, jwt)) as
      { token?: string; expires_at?: string };
    if (!body?.token || !body.expires_at) {
      throw new Error('GitHub App: access_tokens response missing token/expires_at');
    }
    this.cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  }
}

export function createTokenSource(config: {
  tokenSource: 'gh' | 'env' | 'app';
  apiUrl?: string;
  app?: AppAuthConfig;
}): TokenProvider {
  if (config.tokenSource === 'env') return new EnvTokenSource();
  if (config.tokenSource === 'app') {
    if (!config.app) throw new Error('tokenSource "app": missing the "app" config block');
    return new AppTokenSource({ ...config.app, apiUrl: config.apiUrl });
  }
  return new TokenSource();
}
