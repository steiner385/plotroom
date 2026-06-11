import type { CheckRun } from './types';

export function canonicalizeCheckName(raw: string): string {
  return raw
    .replace(/\$\{\{[^}]*\}\}/g, 'shard')
    .replace(/\(\s*(?:\d+|shard)\s*\/\s*(\d+)\s*\)/g, '(shard/$1)')
    .trim();
}

export function dedupeChecks(checks: CheckRun[]): CheckRun[] {
  const byKey = new Map<string, CheckRun>();
  for (const c of checks) {
    // workflowName in the key keeps same-named jobs in different workflows apart
    // (e.g. `ci-gate` in `Auto-merge PRs` vs anything in `CI`); null/'' groups
    // old data without workflow identity exactly as before.
    const key = `${c.workflowName ?? ''}::${c.name}::${c.event}`;
    const prev = byKey.get(key);
    if (!prev || (c.startedAt ?? '') > (prev.startedAt ?? '')) byKey.set(key, c);
  }
  return [...byKey.values()];
}
