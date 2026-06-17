import { describe, it, expect } from 'vitest';
import { cellState } from '../cell';
import type { CellIntent } from '../cell';

const intent = (o: Partial<CellIntent>): CellIntent => ({ runs: true, gates: false, conditional: false, ...o });

describe('cellState', () => {
  it('absent when it does not run', () => {
    expect(cellState(intent({ runs: false, gates: true }))).toBe('absent');
  });
  it('conditional takes precedence over gate (a conditional gate runs only sometimes)', () => {
    expect(cellState(intent({ gates: true, conditional: true }))).toBe('conditional');
  });
  it('gate when it runs, gates, and is not conditional', () => {
    expect(cellState(intent({ gates: true }))).toBe('gate');
  });
  it('advisory when it runs but does not gate', () => {
    expect(cellState(intent({}))).toBe('advisory');
  });
});
