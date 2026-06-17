// Frontend flag for the unified workspace (spec 001, strangler-fig). The classic
// App stays the default; the workspace is opt-in via `?workspace=1` (sticky,
// persisted) or `?workspace=0` to leave. Pure + testable; main.tsx just calls it.
const KEY = 'workspace.enabled';

export function workspaceEnabled(search: string, store: Pick<Storage, 'getItem' | 'setItem'>): boolean {
  const params = new URLSearchParams(search);
  const q = params.get('workspace');
  if (q === '1' || q === 'true') { try { store.setItem(KEY, '1'); } catch { /* ignore */ } return true; }
  if (q === '0' || q === 'false') { try { store.setItem(KEY, '0'); } catch { /* ignore */ } return false; }
  try { return store.getItem(KEY) === '1'; } catch { return false; }
}
