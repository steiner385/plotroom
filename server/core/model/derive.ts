// Tier-2 of the unified-workspace data spine (spec 001, FR-024/FR-025/FR-026):
// the on-demand, SHA-pinned pipeline-model deriver. Wraps the proven
// computeProtectionMap engine and adds:
//   - derivation pinned to an explicit commit SHA (workflow blobs fetched @ref=sha),
//   - a (repo, sha) cache so re-opening the same SHA is instant,
//   - the staleness primitive (compare a pinned SHA against current HEAD)
// so the IDE/authoring path (FR-026) can pin → edit → re-check HEAD at PR-open.
//
// Pure except for the injected `deps` (fetch + head resolution) — unit-testable
// with fakes, no network. The only new I/O vs the engine is "fetch blob @ a SHA"
// and "resolve HEAD SHA", both injected.
import { computeProtectionMap } from '../../protection-map';
import type { ProtectionMapDeps } from '../../protection-map';
import type { DerivedModel } from '../../pipeline-model/derived';

/** What the deriver needs from the outside world (injected; see index.ts wiring). */
export interface ModelDeriveDeps {
  /** Resolve the current HEAD commit SHA of the repo's default branch. */
  resolveHeadSha: (repo: string) => Promise<string>;
  /** Fetch `.github/workflows/<name>` at a specific commit SHA (null if absent). */
  fetchWorkflowAtSha: (repo: string, name: string, sha: string) => Promise<string | null>;
  successStatsByRepo: ProtectionMapDeps['successStatsByRepo'];
  flakeStatsByRepo: ProtectionMapDeps['flakeStatsByRepo'];
  conditionalCallerJobs?: string[];
  /** Observed-history window start (ISO); defaults to 30d before `now`. */
  since?: string;
}

/** A model pinned to the commit it was derived from (FR-026: the optimistic-
 *  concurrency anchor carried through edit → simulate → draft-PR). */
export interface PinnedModel {
  repo: string;
  sourceSha: string;
  derivedAt: number;
  model: DerivedModel;
}

interface CacheEntry { at: number; pinned: PinnedModel }

/**
 * The deriver: a small object with a (repo, sha) cache. Not a module-level
 * singleton — index.ts owns one instance so tests get fresh state.
 */
export class ModelDeriver {
  private cache = new Map<string, CacheEntry>();
  constructor(private deps: ModelDeriveDeps, private ttlMs = 5 * 60_000, private now: () => number = () => Date.now()) {}

  private key(repo: string, sha: string): string { return `${repo}@${sha}`; }

  /** Derive the model for `repo` at an explicit SHA — cached by (repo, sha). */
  async deriveAtSha(repo: string, sha: string): Promise<PinnedModel | null> {
    const k = this.key(repo, sha);
    const hit = this.cache.get(k);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.pinned;
    const since = this.deps.since ?? new Date(this.now() - 30 * 86_400_000).toISOString();
    const model = await computeProtectionMap(repo, since, {
      fetchWorkflow: (r, name) => this.deps.fetchWorkflowAtSha(r, name, sha),
      successStatsByRepo: this.deps.successStatsByRepo,
      flakeStatsByRepo: this.deps.flakeStatsByRepo,
      conditionalCallerJobs: this.deps.conditionalCallerJobs,
    });
    if (model == null) return null; // no derivable ci.yml at this SHA
    const pinned: PinnedModel = { repo, sourceSha: sha, derivedAt: this.now(), model };
    this.cache.set(k, { at: this.now(), pinned });
    return pinned;
  }

  /** Derive at the current HEAD (resolves the SHA first, then pins to it). */
  async deriveAtHead(repo: string): Promise<PinnedModel | null> {
    const sha = await this.deps.resolveHeadSha(repo);
    return this.deriveAtSha(repo, sha);
  }

  /**
   * FR-026 optimistic-concurrency check: is `pinnedSha` still the repo's HEAD?
   * Returns the live HEAD so the caller can re-derive on drift.
   */
  async checkPin(repo: string, pinnedSha: string): Promise<{ current: boolean; headSha: string }> {
    const headSha = await this.deps.resolveHeadSha(repo);
    return { current: headSha === pinnedSha, headSha };
  }

  /** Drop a cache entry (e.g. after a known HEAD move). */
  invalidate(repo: string, sha?: string): void {
    if (sha) { this.cache.delete(this.key(repo, sha)); return; }
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${repo}@`)) this.cache.delete(k);
  }
}
