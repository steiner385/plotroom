import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Optional GitHub webhook receiver (round 8 Task A3) — pure parts.
 *
 * Webhooks are an out-of-band freshness signal layered on top of polling
 * (polling stays primary): a signed event nudges the poller to run the
 * matching cycle immediately instead of waiting for the next tick.
 */

/** Which poller cycle a webhook event maps to. */
export type WebhookRoute =
  | { kind: 'pr-detail'; repo: string; prNumber: number }
  | { kind: 'queue'; repo: string }
  | { kind: 'sweep' };

/**
 * Verify GitHub's `X-Hub-Signature-256` header against the raw request bytes:
 * `sha256=` + hex HMAC-SHA256 of the body. Length-checked first, then
 * constant-time compared — never throws on malformed input.
 */
export function verifySignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(signatureHeader);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** `payload.repository.full_name` when present and well-formed. */
function repoOf(payload: unknown): string | undefined {
  if (!isMapping(payload) || !isMapping(payload.repository)) return undefined;
  const full = payload.repository.full_name;
  return typeof full === 'string' && full ? full : undefined;
}

/** PR number from `pull_request.number` or `check_run.pull_requests[0].number`. */
function prNumberOf(payload: unknown): number | undefined {
  if (!isMapping(payload)) return undefined;
  if (isMapping(payload.pull_request) && typeof payload.pull_request.number === 'number') {
    return payload.pull_request.number;
  }
  if (isMapping(payload.check_run) && Array.isArray(payload.check_run.pull_requests)) {
    const first: unknown = payload.check_run.pull_requests[0];
    if (isMapping(first) && typeof first.number === 'number') return first.number;
  }
  return undefined;
}

/**
 * Map a GitHub event to the poller cycle it should nudge:
 *   pull_request / check_run / check_suite → pr-detail (repo + PR number when
 *     derivable, else sweep), merge_group → queue (repo, else sweep),
 *   workflow_run → sweep, anything else → null (ignored).
 */
export function routeEvent(eventName: string, payload: unknown): WebhookRoute | null {
  switch (eventName) {
    case 'pull_request':
    case 'check_run':
    case 'check_suite': {
      const repo = repoOf(payload);
      const prNumber = prNumberOf(payload);
      return repo !== undefined && prNumber !== undefined
        ? { kind: 'pr-detail', repo, prNumber }
        : { kind: 'sweep' };
    }
    case 'merge_group': {
      const repo = repoOf(payload);
      return repo !== undefined ? { kind: 'queue', repo } : { kind: 'sweep' };
    }
    case 'workflow_run':
      return { kind: 'sweep' };
    default:
      return null;
  }
}

/**
 * Read the shared webhook secret (written by `pnpm app:setup` to
 * `~/.config/pr-dashboard/<slug>.webhook-secret`). Throws a clear startup
 * error when the file is unreadable or empty — webhooks.enabled must never
 * silently run without signature verification.
 */
export function loadWebhookSecret(secretPath: string): string {
  let text: string;
  try {
    text = readFileSync(secretPath, 'utf8');
  } catch (e) {
    throw new Error(`webhooks: cannot read secret at ${secretPath}: `
      + `${e instanceof Error ? e.message : String(e)} — run \`pnpm app:setup\` or write the shared secret there`);
  }
  const secret = text.trim();
  if (!secret) throw new Error(`webhooks: secret file at ${secretPath} is empty`);
  return secret;
}
