// Client for the workspace IDE/model loop endpoints (spec 001, contracts/api.md).
// Thin typed wrappers over fetch so the Optimize/IDE UI calls the already-built
// server loop (/api/workspace/*). `fetchImpl` is injectable for tests.
import type { DerivedModelLike } from '../sections/optimize/types';

type Fetch = typeof fetch;

export interface SimResultDto {
  legal: boolean; reason?: string; note: string;
  costDeltaMinutes: number; direction: string;
  gatesLost: string[]; gatesGained: string[]; estimated: boolean;
}
export interface TierMoveDto { check: string; fromTierId: string; toTierId: string | null }
export interface SecurityFindingDto { file: string; jobId?: string; kind: string; detail: string; confidence: 'high' | 'medium' | 'low' }
export interface ToolHealthDto {
  ingestionFreshnessSecs: number | null;
  derivationCache: { hits: number; misses: number; hitRate: number; size: number };
  apiRateLimit: { remaining: number; limit: number } | null;
  status: 'ok' | 'degraded';
  reasons: string[];
}
export interface TierIntentDto { kind: 'tier'; check: string; jobId: string; fromTierId: string; targetEvent: string }

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export function makeWorkspaceApi(fetchImpl: Fetch = fetch, base = '/api/workspace') {
  const q = (repo: string) => `repo=${encodeURIComponent(repo)}`;
  return {
    getPipeline: (repo: string) =>
      fetchImpl(`${base}/pipeline?${q(repo)}`).then(json<{ repo: string; sourceSha: string; model: DerivedModelLike }>),
    simulate: (repo: string, move: TierMoveDto) =>
      fetchImpl(`${base}/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, move }) }).then(json<SimResultDto>),
    prompt: (repo: string, finding: { goal: string; check: string; detail: string; fromTierId?: string; toTierId?: string | null }) =>
      fetchImpl(`${base}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, finding }) }).then(json<{ prompt: string }>),
    draftPrDryRun: (repo: string, intent: TierIntentDto) =>
      fetchImpl(`${base}/draft-pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, dryRun: true, intent }) }).then(json<{ dryRun: true; diff: string; baseSha: string }>),
    draftPrOpen: (repo: string, intent: TierIntentDto) =>
      fetchImpl(`${base}/draft-pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, dryRun: false, intent }) }).then(json<{ opened: true; number: number; url: string }>),
    security: (repo: string) =>
      fetchImpl(`${base}/security?${q(repo)}`).then(json<{ repo: string; sourceSha: string; scannedFiles: number; findings: SecurityFindingDto[] }>),
    self: () => fetchImpl(`${base}/self`).then(json<ToolHealthDto>),
  };
}
export type WorkspaceApi = ReturnType<typeof makeWorkspaceApi>;
