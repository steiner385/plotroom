import { describe, it, expect } from 'vitest';
import { workspaceEnabled } from '../shell/enabled';

function fakeStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), _m: m };
}

describe('workspaceEnabled (frontend flag, strangler-fig default-off)', () => {
  it('defaults to false (classic App) with no flag and nothing stored', () => {
    expect(workspaceEnabled('', fakeStore())).toBe(false);
  });
  it('?workspace=1 enables and persists', () => {
    const s = fakeStore();
    expect(workspaceEnabled('?workspace=1', s)).toBe(true);
    expect(s._m.get('workspace.enabled')).toBe('1');
  });
  it('?workspace=0 disables and persists (leave the workspace)', () => {
    const s = fakeStore({ 'workspace.enabled': '1' });
    expect(workspaceEnabled('?workspace=0', s)).toBe(false);
    expect(s._m.get('workspace.enabled')).toBe('0');
  });
  it('sticky: a prior opt-in is remembered without the query param', () => {
    expect(workspaceEnabled('', fakeStore({ 'workspace.enabled': '1' }))).toBe(true);
  });
});
