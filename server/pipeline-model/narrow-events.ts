import type { Confidence, TriggerEvent } from './types';

// Matches a WHOLE expression that is exactly one event_name comparison, e.g.
//   ${{ github.event_name == 'merge_group' }}   or   github.event_name != 'pull_request'
const SIMPLE = /^\s*(?:\$\{\{)?\s*github\.event_name\s*(==|!=)\s*'([a-z_]+)'\s*(?:\}\})?\s*$/;

export function narrowEvents(
  events: TriggerEvent[], ifExpr: string | null,
): { events: TriggerEvent[]; confidence: Confidence } {
  if (ifExpr == null) return { events, confidence: 'high' };
  const m = ifExpr.match(SIMPLE);
  if (!m) return { events, confidence: 'low' }; // conservative: keep all, flag low
  const [, op, name] = m;
  const keep = op === '=='
    ? events.filter((e) => e.kind === name)
    : events.filter((e) => e.kind !== name);
  return { events: keep, confidence: 'high' };
}
