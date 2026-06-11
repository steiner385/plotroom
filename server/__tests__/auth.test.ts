import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({ execFile: (...a: unknown[]) => execFileMock(...a) }));

import { TokenSource, EnvTokenSource, createTokenSource } from '../auth';

beforeEach(() => {
  execFileMock.mockReset();
});

const respondWith = (stdout: string) =>
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, stdout, ''));

describe('TokenSource', () => {
  it('fetches via gh with GITHUB_TOKEN/GH_TOKEN stripped from env', async () => {
    respondWith('ghp_abc123\n');
    const t = await new TokenSource().get();
    expect(t).toBe('ghp_abc123');
    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args).toEqual(['auth', 'token']);
    expect(opts.env.GITHUB_TOKEN).toBeUndefined();
    expect(opts.env.GH_TOKEN).toBeUndefined();
  });

  it('caches the token; refresh() re-execs', async () => {
    respondWith('tok1\n');
    const ts = new TokenSource();
    await ts.get();
    await ts.get();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    respondWith('tok2\n');
    expect(await ts.refresh()).toBe('tok2');
    expect(await ts.get()).toBe('tok2');
  });

  it('rejects with a clear error on failure or empty output', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(new Error('boom'), '', 'not logged in'));
    await expect(new TokenSource().get()).rejects.toThrow(/gh auth token failed: not logged in/);
    respondWith('\n');
    await expect(new TokenSource().get()).rejects.toThrow(/empty/);
  });

  it('two parallel get() calls spawn exactly one gh execFile', async () => {
    // Make execFile async (resolves on next microtask) so both get() calls
    // are in-flight at the same time before the first resolves.
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      Promise.resolve().then(() => cb(null, 'parallel_tok\n', ''));
    });
    const ts = new TokenSource();
    const [t1, t2] = await Promise.all([ts.get(), ts.get()]);
    expect(t1).toBe('parallel_tok');
    expect(t2).toBe('parallel_tok');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe('EnvTokenSource', () => {
  const orig = process.env.GITHUB_TOKEN;
  afterEach(() => {
    if (orig !== undefined) process.env.GITHUB_TOKEN = orig;
    else delete process.env.GITHUB_TOKEN;
  });

  it('reads GITHUB_TOKEN at call time, never execs gh', async () => {
    process.env.GITHUB_TOKEN = 'env_tok';
    const ts = new EnvTokenSource();
    expect(await ts.get()).toBe('env_tok');
    process.env.GITHUB_TOKEN = 'env_tok2';
    expect(await ts.refresh()).toBe('env_tok2'); // refresh re-reads the env
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects with a clear error when GITHUB_TOKEN is unset or blank', async () => {
    delete process.env.GITHUB_TOKEN;
    await expect(new EnvTokenSource().get()).rejects.toThrow(/GITHUB_TOKEN is not set/);
    process.env.GITHUB_TOKEN = '  ';
    await expect(new EnvTokenSource().get()).rejects.toThrow(/GITHUB_TOKEN is not set/);
  });
});

describe('createTokenSource', () => {
  it("maps 'gh' to TokenSource and 'env' to EnvTokenSource", () => {
    expect(createTokenSource({ tokenSource: 'gh' })).toBeInstanceOf(TokenSource);
    expect(createTokenSource({ tokenSource: 'env' })).toBeInstanceOf(EnvTokenSource);
  });
});
