import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useApiBase } from '../embed/ApiBaseContext';
import type { DerivedModel, MetricsSlice } from '../protectionModel';

export interface ProtectionData {
  repos: string[];
  repo: string | null;
  setRepo: Dispatch<SetStateAction<string | null>>;
  model: DerivedModel | null;
  metrics: MetricsSlice | null;
  loading: boolean;
  error: string | null;
}

/** Owns the Protection Map's server data: the repo list, the selected repo's derived
 *  model, and the deferred metrics slice (#183). Extracted from ProtectionMap so the
 *  component holds only view state. The three fetches keep their original ordering and
 *  cancellation: /repos once → /protection-map per repo → /metrics deferred until a
 *  model has loaded (so the heavy synchronous /metrics SQLite pass never starves the
 *  protection-map request). */
export function useProtectionData(): ProtectionData {
  const { apiUrl } = useApiBase();
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [model, setModel] = useState<DerivedModel | null>(null);
  const [metrics, setMetrics] = useState<MetricsSlice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/repos'))
      .then((r) => r.json() as Promise<{ repos: { repo: string; excluded: boolean }[] }>)
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : data?.repos ?? [];
        const names = list.filter((x) => !x.excluded).map((x) => x.repo);
        setRepos(names);
        setRepo((prev) => prev ?? names.find((n) => n.startsWith('cairnea/')) ?? names[0] ?? null);
      })
      .catch(() => { if (!cancelled) setRepos([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    setLoading(true); setError(null);
    fetch(apiUrl(`/protection-map?repo=${encodeURIComponent(repo)}`))
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        return r.json() as Promise<DerivedModel>;
      })
      .then((m) => { if (!cancelled) setModel(m); })
      .catch((e) => { if (!cancelled) { setModel(null); setError(e instanceof Error ? e.message : String(e)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repo]);

  // DEFERRED until the model has loaded: /api/metrics is a heavy synchronous SQLite
  // pass that blocks the Node event loop and would starve /api/protection-map.
  useEffect(() => {
    if (!model || metrics) return;
    let cancelled = false;
    fetch(apiUrl('/metrics?window=30d'))
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (!cancelled) setMetrics(m); })
      .catch(() => { if (!cancelled) setMetrics(null); });
    return () => { cancelled = true; };
  }, [model, metrics]);

  return { repos, repo, setRepo, model, metrics, loading, error };
}
