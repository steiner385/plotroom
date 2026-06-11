import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeployWatcher } from '../deploy-watcher';

let work: string;
let srcRepo: string;
let shas: { first: string; second: string; orphan: string };

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'prdash-test-'));
  srcRepo = join(work, 'src');
  execFileSync('git', ['init', '-b', 'main', srcRepo]);
  git(srcRepo, 'config', 'user.email', 't@t'); git(srcRepo, 'config', 'user.name', 't');
  git(srcRepo, 'commit', '--allow-empty', '-m', 'first');
  const first = git(srcRepo, 'rev-parse', 'HEAD');
  git(srcRepo, 'commit', '--allow-empty', '-m', 'second');
  const second = git(srcRepo, 'rev-parse', 'HEAD');
  // an orphan commit on a side branch, never merged
  git(srcRepo, 'checkout', '-b', 'side', first);
  git(srcRepo, 'commit', '--allow-empty', '-m', 'orphan');
  const orphan = git(srcRepo, 'rev-parse', 'HEAD');
  git(srcRepo, 'checkout', 'main');
  shas = { first, second, orphan };
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('DeployWatcher', () => {
  it('clones bare, answers ancestry yes/no, and "missing" for unknown shas', async () => {
    const w = new DeployWatcher(join(work, 'clones'));
    await w.ensureClone('a/b', srcRepo);
    expect(await w.isAncestor('a/b', shas.first, shas.second)).toBe('yes');
    expect(await w.isAncestor('a/b', shas.second, shas.first)).toBe('no');
    expect(await w.isAncestor('a/b', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', shas.second)).toBe('missing');
  });

  it('answers no for an orphan commit never merged to main', async () => {
    const w = new DeployWatcher(join(work, 'clones'));
    await w.ensureClone('a/b', srcRepo);
    expect(await w.isAncestor('a/b', shas.orphan, shas.second)).toBe('no');
  });

  it('fetches to pick up new commits before declaring missing', async () => {
    const w = new DeployWatcher(join(work, 'clones2'));
    await w.ensureClone('a/b', srcRepo);
    git(srcRepo, 'commit', '--allow-empty', '-m', 'third');
    const third = git(srcRepo, 'rev-parse', 'HEAD');
    expect(await w.isAncestor('a/b', shas.second, third)).toBe('yes'); // triggers fetch internally
  });

  it('readFileAtHead reads a committed file from the branch tip, null when missing', async () => {
    writeFileSync(join(srcRepo, 'ci.yml'), 'jobs: {}\n');
    git(srcRepo, 'add', 'ci.yml');
    git(srcRepo, 'commit', '-m', 'add ci.yml');
    const w = new DeployWatcher(join(work, 'clones-read'));
    await w.ensureClone('a/b', srcRepo);
    expect(await w.readFileAtHead('a/b', 'ci.yml')).toBe('jobs: {}\n');
    expect(await w.readFileAtHead('a/b', 'no/such/file.yml')).toBeNull();
    expect(await w.readFileAtHead('a/b', 'ci.yml', 'no-such-branch')).toBeNull();
  });

  it('readFileAtHead sees new content after fetchClone (branch ref advances, not bare HEAD)', async () => {
    const w = new DeployWatcher(join(work, 'clones-read2'));
    writeFileSync(join(srcRepo, 'ci.yml'), 'jobs: { lint: {} }\n');
    git(srcRepo, 'add', 'ci.yml');
    git(srcRepo, 'commit', '-m', 'pre-clone ci.yml');
    await w.ensureClone('a/b', srcRepo);
    expect(await w.readFileAtHead('a/b', 'ci.yml')).toBe('jobs: { lint: {} }\n');
    writeFileSync(join(srcRepo, 'ci.yml'), 'jobs: { ci: {} }\n');
    git(srcRepo, 'add', 'ci.yml');
    git(srcRepo, 'commit', '-m', 'update ci.yml');
    await w.fetchClone('a/b');
    expect(await w.readFileAtHead('a/b', 'ci.yml')).toBe('jobs: { ci: {} }\n');
  });

  it('health() returns commitSha or null on failure', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ commitSha: 'abc' }), { status: 200 }));
    const bad = vi.fn(async () => new Response('nope', { status: 503 }));
    expect(await new DeployWatcher(work, ok as unknown as typeof fetch).health('http://x/health')).toBe('abc');
    expect(await new DeployWatcher(work, bad as unknown as typeof fetch).health('http://x/health')).toBeNull();
  });

  it('health() extracts a custom shaKey; null when the key is absent or non-string', async () => {
    const body = vi.fn(async () => new Response(JSON.stringify({ gitSha: 'xyz', commitSha: 42 }), { status: 200 }));
    const w = new DeployWatcher(work, body as unknown as typeof fetch);
    expect(await w.health('http://x/health', 'gitSha')).toBe('xyz');
    expect(await w.health('http://x/health', 'commitSha')).toBeNull(); // non-string value
    expect(await w.health('http://x/health', 'missingKey')).toBeNull();
  });

  it('health() returns null on network error or missing commitSha', async () => {
    const boom = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const empty = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    expect(await new DeployWatcher(work, boom as unknown as typeof fetch).health('http://x/health')).toBeNull();
    expect(await new DeployWatcher(work, empty as unknown as typeof fetch).health('http://x/health')).toBeNull();
  });
});
