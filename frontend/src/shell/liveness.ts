export interface Liveness { cls: 'down' | 'stale' | 'live'; label: string; title: string }

/** The spine/embed three-state liveness indicator — single source of truth so the
 *  standalone header and the embed StatusStrip can't drift. */
export function liveness(connected: boolean, stale: boolean): Liveness {
  if (!connected) return { cls: 'down', label: '○ reconnecting', title: 'reconnecting' };
  if (stale) return { cls: 'stale', label: '◐ stale', title: 'connected, but no fresh data in 90s — feed may be stalled' };
  return { cls: 'live', label: '● live', title: 'live' };
}
