import { describe, it, expect } from 'vitest';
import { deployChain } from '../deploy-status';

const m = (number: number, mergedAt: string, firstLiveAt: string | null, terminalLiveAt: string | null) =>
  ({ number, mergeCommitSha: `sha${number}`, mergedAt, firstLiveAt, terminalLiveAt });

describe('deployChain (order-driven first/terminal chain + SHA supersession)', () => {
  it('classifies each merge by the furthest stage it reached', () => {
    const c = deployChain([
      m(3, '2026-06-18T03:00:00Z', '2026-06-18T03:10:00Z', '2026-06-18T03:20:00Z'), // terminal
      m(2, '2026-06-18T02:00:00Z', '2026-06-18T02:10:00Z', null),                    // first
      m(1, '2026-06-18T01:00:00Z', null, null),                                       // merged
    ]);
    expect(c.entries.map((e) => [e.prNumber, e.stage])).toEqual([[3, 'terminal'], [2, 'first'], [1, 'merged']]);
  });

  it('marks an older awaiting-terminal SHA superseded once a NEWER one reaches terminal', () => {
    const c = deployChain([
      m(2, '2026-06-18T02:00:00Z', '2026-06-18T02:10:00Z', '2026-06-18T02:20:00Z'), // newer → terminal
      m(1, '2026-06-18T01:00:00Z', '2026-06-18T01:10:00Z', null),                    // older, awaiting terminal
    ]);
    const older = c.entries.find((e) => e.prNumber === 1)!;
    expect(older.superseded).toBe(true); // terminal jumped past it — it'll never deploy on its own
    expect(c.entries.find((e) => e.prNumber === 2)!.superseded).toBe(false);
  });

  it('does NOT supersede the front-runner (newest, still flowing toward terminal)', () => {
    const c = deployChain([
      m(3, '2026-06-18T03:00:00Z', '2026-06-18T03:10:00Z', null),                    // front-runner, awaiting terminal
      m(2, '2026-06-18T02:00:00Z', '2026-06-18T02:10:00Z', '2026-06-18T02:20:00Z'), // terminal
    ]);
    expect(c.entries.find((e) => e.prNumber === 3)!.superseded).toBe(false);
    expect(c.inFlight?.prNumber).toBe(3); // the SHA actively progressing
  });

  it('reports inFlight=null and supersededCount=0 when everything is live on terminal', () => {
    const c = deployChain([
      m(2, '2026-06-18T02:00:00Z', '2026-06-18T02:10:00Z', '2026-06-18T02:20:00Z'),
      m(1, '2026-06-18T01:00:00Z', '2026-06-18T01:10:00Z', '2026-06-18T01:20:00Z'),
    ]);
    expect(c.inFlight).toBeNull();
    expect(c.supersededCount).toBe(0);
  });

  it('orders newest-merge first and caps to the limit', () => {
    const rows = Array.from({ length: 12 }, (_, i) => m(i + 1, `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`, null, null));
    const c = deployChain(rows, 5);
    expect(c.entries).toHaveLength(5);
    expect(c.entries[0].prNumber).toBe(12); // newest
  });

  it('exposes firstLiveAt and terminalLiveAt on each entry', () => {
    const c = deployChain([
      m(1, '2026-06-18T01:00:00Z', '2026-06-18T01:10:00Z', '2026-06-18T01:20:00Z'),
    ]);
    expect(c.entries[0].firstLiveAt).toBe('2026-06-18T01:10:00Z');
    expect(c.entries[0].terminalLiveAt).toBe('2026-06-18T01:20:00Z');
  });
});
