// HTTP surface for the unified-workspace IDE/model loop (spec 001, contracts/api.md).
// A Router FACTORY taking injected deps so it's testable without the full app and
// wired in index.ts with the real GitHub client. Mutating routes are POST (the
// caller applies the same-origin guard at mount). No direct apply — the only
// write is a DRAFT PR.
import { Router, type Request, type Response } from 'express';
import { ModelDeriver } from '../model/derive';
import { simulateTierMove, type TierMove } from '../model/simulate';
import { buildPrompt, type PromptInput } from '../actions/prompt';
import { prepareDraftEdit, openDraftPr, type PrClient, type TierAssignIntent } from '../actions/draftPr';
import { auditWorkflowSecurity } from '../model/security';
import { buildSelfHealth, type ApiRateLimit } from '../model/selfHealth';

export interface WorkspaceRouterDeps {
  deriver: ModelDeriver;
  prClient: PrClient;
  /** live-ruleset required checks for a repo (FR-035a union binding); [] if unreadable. */
  liveRequired?: (repo: string) => Promise<readonly string[]>;
  /** self-observability inputs (Group O): ingestion freshness + API rate-limit budget. */
  selfHealth?: () => { ingestionFreshnessSecs: number | null; apiRateLimit: ApiRateLimit | null };
}

function repoOf(req: Request, res: Response): string | null {
  const repo = String(req.query.repo ?? req.body?.repo ?? '');
  if (!/^[^/]+\/[^/]+$/.test(repo)) { res.status(400).json({ error: 'repo must be "owner/name"' }); return null; }
  return repo;
}

export function createWorkspaceRouter(deps: WorkspaceRouterDeps): Router {
  const r = Router();
  const required = async (repo: string) => (deps.liveRequired ? deps.liveRequired(repo) : undefined);

  // GET /pipeline?repo= — Tier-2 SHA-pinned model
  r.get('/pipeline', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const pinned = await deps.deriver.deriveAtHead(repo);
    if (!pinned) return res.status(404).json({ error: 'no derivable model' });
    res.json({ repo, sourceSha: pinned.sourceSha, model: pinned.model });
  });

  // POST /simulate — { repo, move } → projection + legality
  r.post('/simulate', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const move = req.body?.move as TierMove | undefined;
    if (!move?.check || !move.fromTierId) return res.status(400).json({ error: 'move {check, fromTierId, toTierId} required' });
    const pinned = await deps.deriver.deriveAtHead(repo);
    if (!pinned) return res.status(404).json({ error: 'no derivable model' });
    res.json(simulateTierMove(pinned.model, move, await required(repo)));
  });

  // POST /prompt — { repo, finding } → a Claude Code prompt
  r.post('/prompt', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const finding = req.body?.finding as PromptInput | undefined;
    if (!finding?.goal || !finding.check) return res.status(400).json({ error: 'finding {goal, check, detail} required' });
    const pinned = await deps.deriver.deriveAtHead(repo);
    if (!pinned) return res.status(404).json({ error: 'no derivable model' });
    res.json({ prompt: buildPrompt(repo, pinned.model, finding) });
  });

  // GET /self — the tool's own health (Group O / FR-043). Always available; no repo.
  r.get('/self', (_req, res) => {
    const ext = deps.selfHealth?.() ?? { ingestionFreshnessSecs: null, apiRateLimit: null };
    res.json(buildSelfHealth({ ...ext, derivationCache: deps.deriver.cacheStats() }));
  });

  // GET /security?repo= — CI security audit (Group M) of the model's workflow
  // files at the pinned SHA. Tier-2 (SHA-pinned) per the review; per-finding
  // confidence, never a false "clean" (FR-040/SC-016).
  r.get('/security', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const pinned = await deps.deriver.deriveAtHead(repo);
    if (!pinned) return res.status(404).json({ error: 'no derivable model' });
    const files = [...new Set((pinned.model.checkMeta ?? []).flatMap((m) => m.provenance.map((p) => p.file)))];
    const findings = [];
    for (const file of files) {
      const yaml = await deps.prClient.fetchWorkflowAtSha(repo, file, pinned.sourceSha);
      if (yaml != null) findings.push(...auditWorkflowSecurity(yaml, file));
    }
    res.json({ repo, sourceSha: pinned.sourceSha, scannedFiles: files.length, findings });
  });

  // POST /draft-pr — { repo, intent, dryRun } → preview diff OR open a draft PR (FR-026)
  r.post('/draft-pr', async (req, res) => {
    const repo = repoOf(req, res); if (!repo) return;
    const intent = req.body?.intent as TierAssignIntent | undefined;
    if (intent?.kind !== 'tier' || !intent.check || !intent.jobId) return res.status(400).json({ error: 'tier intent {check, jobId, fromTierId, targetEvent} required' });
    const prep = await prepareDraftEdit(deps.deriver, deps.prClient, repo, intent, await required(repo));
    if (!prep.ok) return res.status(409).json({ error: prep.reason });
    if (req.body?.dryRun !== false) return res.json({ dryRun: true, diff: prep.prepared.diff, baseSha: prep.prepared.baseSha });
    const out = await openDraftPr(deps.deriver, deps.prClient, prep.prepared, intent.check);
    if (out.opened) return res.json({ opened: true, number: out.number, url: out.url });
    if (out.stale) return res.status(409).json({ error: 'HEAD drifted — re-derive and re-confirm', headSha: out.headSha });
    return res.status(502).json({ error: out.reason });
  });

  return r;
}
