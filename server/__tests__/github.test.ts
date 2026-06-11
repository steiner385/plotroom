import { describe, it, expect, vi } from 'vitest';
import { GithubClient, RateLimitError } from '../github';

const tokens = (t = 'tok') => ({ get: vi.fn(async () => t), refresh: vi.fn(async () => 'tok2') });
const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const textRes = (text: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers });

describe('GithubClient', () => {
  it('POSTs the query with bearer token + user-agent, returns data, tracks rateLimit', async () => {
    const fetchFn = vi.fn(async () => jsonRes({ data: { ok: 1, rateLimit: { remaining: 4321, resetAt: 'R' } } }));
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch);
    const data = await c.graphql<{ ok: number }>('query { ok }');
    expect(data.ok).toBe(1);
    expect(c.remaining).toBe(4321);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { headers: Record<string, string>; method: string; body: string }];
    expect(url).toBe('https://api.github.com/graphql');
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(init.headers['user-agent']).toBe('pr-dashboard');
  });

  it('a custom apiUrl is used for every request (GitHub Enterprise)', async () => {
    const fetchFn = vi.fn(async () => jsonRes({ data: { ok: 1 } }));
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch,
      { apiUrl: 'https://github.example.com/api/graphql' });
    await c.graphql('query { ok }');
    expect((fetchFn.mock.calls[0] as unknown as [string])[0])
      .toBe('https://github.example.com/api/graphql');
  });

  it('on 401 refreshes the token and retries exactly once', async () => {
    const t = tokens();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonRes({}, 401))
      .mockResolvedValueOnce(jsonRes({ data: { ok: 1 } }));
    const c = new GithubClient(t, fetchFn as unknown as typeof fetch);
    await c.graphql('query { ok }');
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('persistent double-401: second response is also 401 → plain error, fetch called exactly twice', async () => {
    const t = tokens();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonRes({}, 401))
      .mockResolvedValueOnce(jsonRes({}, 401));
    const c = new GithubClient(t, fetchFn as unknown as typeof fetch);
    await expect(c.graphql('q')).rejects.toThrow(/401/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws RateLimitError honoring retry-after on 403 with retry-after header', async () => {
    const fetchFn = vi.fn(async () => jsonRes({}, 403, { 'retry-after': '17' }));
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch);
    await expect(c.graphql('q')).rejects.toThrow(RateLimitError);
    await c.graphql('q').catch((e: RateLimitError) => expect(e.retryAfterSeconds).toBe(17));
  });

  it('throws RateLimitError on 403 with x-ratelimit-remaining=0', async () => {
    const fetchFn = vi.fn(async () => jsonRes({}, 403, { 'x-ratelimit-remaining': '0' }));
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch);
    await expect(c.graphql('q')).rejects.toThrow(RateLimitError);
  });

  it('throws permission/SSO error on 403 with no rate-limit signals', async () => {
    const fetchFn = vi.fn(async () => jsonRes({}, 403));
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch);
    await expect(c.graphql('q')).rejects.toThrow(/permission\/SSO/);
    await expect(c.graphql('q')).rejects.not.toThrow(RateLimitError);
  });

  it('throws RateLimitError on 429, uses retry-after header', async () => {
    const fetchFn = vi.fn(async () => jsonRes({}, 429, { 'retry-after': '30' }));
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch);
    const err = await c.graphql('q').catch((e: unknown) => e) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBe(30);
  });

  it('missing retry-after on 429 → defaults to 60', async () => {
    const fetchFn = vi.fn(async () => jsonRes({}, 429));
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch);
    const err = await c.graphql('q').catch((e: unknown) => e) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBe(60);
  });

  it('maps GraphQL RATE_LIMITED errors to RateLimitError, other errors to Error (no data)', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonRes({ errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] }))
      .mockResolvedValueOnce(jsonRes({ errors: [{ message: 'bad field' }] }));
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch);
    await expect(c.graphql('q')).rejects.toThrow(RateLimitError);
    await expect(c.graphql('q')).rejects.toThrow(/bad field/);
  });

  it('errors + partial data → returns data, calls onPartialErrors with messages', async () => {
    const fetchFn = vi.fn(async () => jsonRes({
      data: { repo: { name: 'widgets' }, missing: null },
      errors: [{ message: 'Node not found' }, { message: 'Permission denied' }],
    }));
    const onPartialErrors = vi.fn();
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch, { onPartialErrors });
    const data = await c.graphql<{ repo: { name: string } }>('q');
    expect(data.repo.name).toBe('widgets');
    expect(onPartialErrors).toHaveBeenCalledWith(['Node not found', 'Permission denied']);
  });

  it('errors + no usable data → throws Error', async () => {
    const fetchFn = vi.fn(async () => jsonRes({
      data: { r0: null, r1: null },
      errors: [{ message: 'inaccessible' }],
    }));
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch);
    await expect(c.graphql('q')).rejects.toThrow(/inaccessible/);
  });

  it('RATE_LIMITED + partial data → still throws RateLimitError', async () => {
    const fetchFn = vi.fn(async () => jsonRes({
      data: { r0: { name: 'x' } },
      errors: [{ type: 'RATE_LIMITED', message: 'slow down' }],
    }));
    const onPartialErrors = vi.fn();
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch, { onPartialErrors });
    await expect(c.graphql('q')).rejects.toThrow(RateLimitError);
    expect(onPartialErrors).not.toHaveBeenCalled();
  });

  it('rateLimit bookkeeping runs even when partial-data errors are present', async () => {
    const fetchFn = vi.fn(async () => jsonRes({
      data: { rateLimit: { remaining: 99, resetAt: 'T' }, r0: { name: 'x' } },
      errors: [{ message: 'Node not found' }],
    }));
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch);
    await c.graphql('q');
    expect(c.remaining).toBe(99);
    expect(c.resetAt).toBe('T');
  });

  it('wraps invalid JSON response in a clear error', async () => {
    const fetchFn = vi.fn(async () => textRes('<html>bad gateway</html>', 200));
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch);
    await expect(c.graphql('q')).rejects.toThrow(/invalid JSON response/);
  });

  it('throws a generic HTTP error for non-ok non-handled statuses', async () => {
    const fetchFn = vi.fn(async () => jsonRes({}, 500));
    const c = new GithubClient(tokens(), fetchFn as unknown as typeof fetch);
    await expect(c.graphql('q')).rejects.toThrow(/HTTP 500/);
  });
});
