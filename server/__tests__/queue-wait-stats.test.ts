import { describe, it, expect } from 'vitest';
import { queueWaitStatsByRepo } from '../metrics';

const row = (repo: string, at: string, waitSecs: number) => ({ repo, at, waitSecs });

describe('queueWaitStatsByRepo', () => {
  const since = '2026-06-17T00:00:00Z'; // split point (7d ago)

  it('computes p50 of cur (≥ since) vs prev (< since) per repo', () => {
    const rows = [
      row('a/x', '2026-06-12T00:00:00Z', 100), row('a/x', '2026-06-13T00:00:00Z', 100), // prev
      row('a/x', '2026-06-18T00:00:00Z', 200), row('a/x', '2026-06-19T00:00:00Z', 200), // cur
    ];
    const m = queueWaitStatsByRepo(rows, since);
    expect(m.get('a/x')).toEqual({ value: 200, prev: 100 });
  });

  it('a repo with only current-window samples → prev null', () => {
    const m = queueWaitStatsByRepo([row('b/y', '2026-06-18T00:00:00Z', 50)], since);
    expect(m.get('b/y')).toEqual({ value: 50, prev: null });
  });

  it('a repo with only prev-window samples → value null', () => {
    const m = queueWaitStatsByRepo([row('c/z', '2026-06-10T00:00:00Z', 70)], since);
    expect(m.get('c/z')).toEqual({ value: null, prev: 70 });
  });

  it('empty input → empty map', () => {
    expect(queueWaitStatsByRepo([], since).size).toBe(0);
  });
});
