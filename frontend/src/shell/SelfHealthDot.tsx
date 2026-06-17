// Self-observability indicator (spec 001, Group O / FR-043) — a small spine dot
// showing the tool's own health (ingestion freshness, derivation cache, API
// rate-limit budget). Polls /self; degraded state surfaces the reasons on hover.
// App-global per the persona IA decision (lives in the spine, not a section).
import { useEffect, useState } from 'react';
import type { WorkspaceApi, ToolHealthDto } from './workspaceApi';

export function SelfHealthDot({ api, pollMs = 30_000 }: { api: WorkspaceApi; pollMs?: number }) {
  const [health, setHealth] = useState<ToolHealthDto | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.self().then((h) => { if (alive) setHealth(h); }).catch(() => { if (alive) setHealth(null); });
    load();
    const t = setInterval(load, pollMs);
    return () => { alive = false; clearInterval(t); };
  }, [api, pollMs]);

  if (!health) return <span className="self-health unknown" title="tool health unknown">◌</span>;
  const title = health.status === 'ok'
    ? `Tool healthy · cache ${Math.round(health.derivationCache.hitRate * 100)}% hit`
    : `Tool degraded — ${health.reasons.join('; ')}`;
  return (
    <span className={`self-health ${health.status}`} role="status" title={title} aria-label={title}>
      {health.status === 'ok' ? '●' : '⚠'} tool
    </span>
  );
}
