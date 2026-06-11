import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySignature, routeEvent, loadWebhookSecret } from '../webhooks';

const SECRET = 'shhh-test-secret';
const sign = (secret: string, body: Buffer | string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifySignature', () => {
  const body = Buffer.from(JSON.stringify({ action: 'completed' }));

  it('accepts a valid sha256= signature', () => {
    expect(verifySignature(SECRET, body, sign(SECRET, body))).toBe(true);
  });

  it('rejects a signature minted with the wrong secret', () => {
    expect(verifySignature(SECRET, body, sign('other-secret', body))).toBe(false);
  });

  it('rejects when the body was tampered with after signing', () => {
    const sig = sign(SECRET, body);
    expect(verifySignature(SECRET, Buffer.from('{"evil":1}'), sig)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
    expect(verifySignature(SECRET, body, '')).toBe(false);
  });

  it('rejects a header without the sha256= prefix (e.g. legacy sha1=)', () => {
    const hex = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(SECRET, body, hex)).toBe(false);
    expect(verifySignature(SECRET, body, `sha1=${hex}`)).toBe(false);
  });

  it('rejects a length-mismatched signature without throwing (timingSafeEqual guard)', () => {
    expect(verifySignature(SECRET, body, 'sha256=abc123')).toBe(false);
    expect(verifySignature(SECRET, body, `${sign(SECRET, body)}00`)).toBe(false);
  });
});

describe('routeEvent', () => {
  const REPO = { repository: { full_name: 'acme/widgets' } };

  it('pull_request with a PR number → pr-detail', () => {
    expect(routeEvent('pull_request', { ...REPO, pull_request: { number: 8962 } }))
      .toEqual({ kind: 'pr-detail', repo: 'acme/widgets', prNumber: 8962 });
  });

  it('check_run with an attached PR → pr-detail', () => {
    expect(routeEvent('check_run', { ...REPO, check_run: { pull_requests: [{ number: 41 }] } }))
      .toEqual({ kind: 'pr-detail', repo: 'acme/widgets', prNumber: 41 });
  });

  it('check_run with no attached PRs → sweep (underivable)', () => {
    expect(routeEvent('check_run', { ...REPO, check_run: { pull_requests: [] } }))
      .toEqual({ kind: 'sweep' });
  });

  it('check_suite (no PR derivation path) → sweep', () => {
    expect(routeEvent('check_suite', { ...REPO, check_suite: { head_branch: 'main' } }))
      .toEqual({ kind: 'sweep' });
  });

  it('pull_request without a repository → sweep (underivable)', () => {
    expect(routeEvent('pull_request', { pull_request: { number: 8962 } }))
      .toEqual({ kind: 'sweep' });
  });

  it('merge_group → queue for the payload repo', () => {
    expect(routeEvent('merge_group', { ...REPO, merge_group: { head_sha: 'abc' } }))
      .toEqual({ kind: 'queue', repo: 'acme/widgets' });
  });

  it('merge_group without a repository → sweep (underivable)', () => {
    expect(routeEvent('merge_group', { merge_group: {} })).toEqual({ kind: 'sweep' });
  });

  it('workflow_run → sweep', () => {
    expect(routeEvent('workflow_run', { ...REPO, workflow_run: { id: 1 } }))
      .toEqual({ kind: 'sweep' });
  });

  it('unknown events → null (ignored, no cycle)', () => {
    expect(routeEvent('ping', { zen: 'Design for failure.' })).toBeNull();
    expect(routeEvent('issues', REPO)).toBeNull();
    expect(routeEvent('push', REPO)).toBeNull();
  });

  it('tolerates malformed payloads (null / non-object) without throwing', () => {
    expect(routeEvent('pull_request', null)).toEqual({ kind: 'sweep' });
    expect(routeEvent('merge_group', 'garbage')).toEqual({ kind: 'sweep' });
    expect(routeEvent('ping', null)).toBeNull();
  });
});

describe('loadWebhookSecret', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function secretFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'prdash-hook-'));
    dirs.push(dir);
    const path = join(dir, 'x.webhook-secret');
    writeFileSync(path, content);
    return path;
  }

  it('reads the secret and trims surrounding whitespace/newline', () => {
    expect(loadWebhookSecret(secretFile('s3cret\n'))).toBe('s3cret');
  });

  it('unreadable file → clear startup error naming the path', () => {
    expect(() => loadWebhookSecret('/nonexistent/x.webhook-secret'))
      .toThrow(/webhooks.*\/nonexistent\/x\.webhook-secret/);
  });

  it('empty secret file → clear error', () => {
    const path = secretFile('  \n');
    expect(() => loadWebhookSecret(path)).toThrow(/empty/);
  });
});
