export class RateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`rate limited; retry after ${retryAfterSeconds}s`);
  }
}

/** Non-OK REST response. The status is preserved so callers can branch on it
 *  (e.g. the compare-API ancestry check maps 404 → 'missing'). */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Derive the REST base URL from the configured GraphQL endpoint.
 * 'https://api.github.com/graphql' → 'https://api.github.com';
 * GitHub Enterprise 'https://ghe.example.com/api/graphql' → '…/api/v3'.
 */
export function deriveRestBase(apiUrl: string): string {
  const base = apiUrl.replace(/\/graphql\/?$/, '');
  return base.endsWith('/api') ? `${base}/v3` : base;
}

interface TokenProvider { get(): Promise<string>; refresh(): Promise<string>; }

export interface GithubClientOptions {
  /** Called when the response contains GraphQL errors alongside usable partial data. */
  onPartialErrors?: (messages: string[]) => void;
  /** GraphQL endpoint (override for GitHub Enterprise). */
  apiUrl?: string;
}

export class GithubClient {
  remaining: number | null = null;
  resetAt: string | null = null;

  private readonly onPartialErrors: (messages: string[]) => void;
  private readonly apiUrl: string;
  private readonly restBase: string;

  constructor(
    private tokens: TokenProvider,
    private fetchFn: typeof fetch = fetch,
    options: GithubClientOptions = {},
  ) {
    this.onPartialErrors = options.onPartialErrors ?? (() => { /* no-op */ });
    this.apiUrl = options.apiUrl ?? 'https://api.github.com/graphql';
    this.restBase = deriveRestBase(this.apiUrl);
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.request(query, variables, false) as Promise<T>;
  }

  /**
   * Authenticated REST GET against the same token + endpoint family as
   * graphql() (REST base derived from apiUrl). Shares the 401-refresh-retry
   * and rate-limit mapping; every other non-OK status throws HttpError with
   * the status preserved. The path must start with '/'.
   */
  async restGet<T = unknown>(path: string): Promise<T> {
    return this.restRequest(path, false) as Promise<T>;
  }

  private async restRequest(path: string, retried: boolean): Promise<unknown> {
    const token = await this.tokens.get();
    const res = await this.fetchFn(`${this.restBase}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'pr-dashboard',
      },
    });
    if (res.status === 401 && !retried) {
      void res.text().catch(() => { /* consume body */ });
      await this.tokens.refresh();
      return this.restRequest(path, true);
    }
    if (res.status === 429 || res.status === 403) {
      void res.text().catch(() => { /* consume body */ });
      const retryAfterHeader = res.headers.get('retry-after');
      if (res.status === 429 || retryAfterHeader !== null || res.headers.get('x-ratelimit-remaining') === '0') {
        const ra = Number(retryAfterHeader ?? '60');
        throw new RateLimitError(Number.isFinite(ra) ? ra : 60);
      }
      throw new HttpError(403, `GitHub REST GET ${path}: HTTP 403 (permission/SSO?)`);
    }
    if (!res.ok) {
      void res.text().catch(() => { /* consume body */ });
      throw new HttpError(res.status, `GitHub REST GET ${path}: HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new Error(`GitHub REST GET ${path}: invalid JSON response`);
    }
  }

  private async request(query: string, variables: Record<string, unknown>, retried: boolean): Promise<unknown> {
    const token = await this.tokens.get();
    const res = await this.fetchFn(this.apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'pr-dashboard',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401 && !retried) {
      void res.text().catch(() => { /* consume body */ });
      await this.tokens.refresh();
      return this.request(query, variables, true);
    }

    if (res.status === 429) {
      void res.text().catch(() => { /* consume body */ });
      const ra = Number(res.headers.get('retry-after') ?? '60');
      throw new RateLimitError(Number.isFinite(ra) ? ra : 60);
    }

    if (res.status === 403) {
      void res.text().catch(() => { /* consume body */ });
      const retryAfterHeader = res.headers.get('retry-after');
      const remainingHeader = res.headers.get('x-ratelimit-remaining');
      if (retryAfterHeader !== null || remainingHeader === '0') {
        const ra = Number(retryAfterHeader ?? '60');
        throw new RateLimitError(Number.isFinite(ra) ? ra : 60);
      }
      throw new Error('GitHub GraphQL HTTP 403 (permission/SSO?)');
    }

    if (!res.ok) {
      void res.text().catch(() => { /* consume body */ });
      throw new Error(`GitHub GraphQL HTTP ${res.status}`);
    }

    let body: { data?: Record<string, unknown>; errors?: { type?: string; message: string }[] };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new Error('GitHub GraphQL: invalid JSON response');
    }

    // Always book-keep rateLimit before deciding whether to throw.
    const rl = body.data?.rateLimit as { remaining: number; resetAt: string } | undefined;
    if (rl) { this.remaining = rl.remaining; this.resetAt = rl.resetAt; }

    if (body.errors?.length) {
      if (body.errors.some((e) => e.type === 'RATE_LIMITED')) throw new RateLimitError(60);

      // Partial data: if at least one top-level value is non-null, return it.
      const hasData = body.data != null && Object.values(body.data).some((v) => v != null);
      if (hasData) {
        this.onPartialErrors(body.errors.map((e) => e.message));
        return body.data;
      }

      throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
    }

    return body.data;
  }
}
