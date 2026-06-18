import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { applyMutation, type Mutation } from '../edit/mutation';

const WF = `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`;

describe('applyMutation (1:1 mutation → renderer dispatch)', () => {
  it('dispatches each op to its renderer', () => {
    const timeout = applyMutation(WF, { op: 'timeout', jobId: 'a', minutes: 15 });
    expect(timeout.ok).toBe(true);
    if (timeout.ok) expect(parse(timeout.newText).jobs.a['timeout-minutes']).toBe(15);

    const runner = applyMutation(WF, { op: 'runner', jobId: 'a', runsOn: 'self-hosted' });
    expect(runner.ok).toBe(true);
    if (runner.ok) expect(parse(runner.newText).jobs.a['runs-on']).toBe('self-hosted');

    const pin = applyMutation(WF, { op: 'pin-action', usesRef: 'actions/checkout@v4', sha: '1'.repeat(40) });
    expect(pin.ok).toBe(true);
    if (pin.ok) expect(parse(pin.newText).jobs.a.steps[0].uses).toBe(`actions/checkout@${'1'.repeat(40)}`);

    const conc = applyMutation(WF, { op: 'concurrency', group: 'g' });
    expect(conc.ok).toBe(true);
    if (conc.ok) expect(parse(conc.newText).concurrency.group).toBe('g');
  });

  it('propagates a renderer refusal unchanged', () => {
    const r = applyMutation(WF, { op: 'timeout', jobId: 'nope', minutes: 5 });
    expect(r.ok).toBe(false);
  });
});
