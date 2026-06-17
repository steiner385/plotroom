import { describe, it, expect } from 'vitest';
import { narrowEvents } from '../narrow-events';
import type { TriggerEvent } from '../types';

const ALL: TriggerEvent[] = [{ kind: 'pull_request' }, { kind: 'merge_group' }, { kind: 'push' }];

describe('narrowEvents', () => {
  it('no if → all events, high confidence', () => {
    expect(narrowEvents(ALL, null)).toEqual({ events: ALL, confidence: 'high' });
  });

  it('== keeps only the named event', () => {
    const r = narrowEvents(ALL, "${{ github.event_name == 'merge_group' }}");
    expect(r.events).toEqual([{ kind: 'merge_group' }]);
    expect(r.confidence).toBe('high');
  });

  it('!= drops the named event', () => {
    const r = narrowEvents(ALL, "${{ github.event_name != 'pull_request' }}");
    expect(r.events).toEqual([{ kind: 'merge_group' }, { kind: 'push' }]);
    expect(r.confidence).toBe('high');
  });

  it('complex expression → keep all events, low confidence', () => {
    const r = narrowEvents(ALL, "${{ github.event_name != 'pull_request' && needs.scope.outputs.backend == 'true' }}");
    expect(r.events).toEqual(ALL);
    expect(r.confidence).toBe('low');
  });
});
