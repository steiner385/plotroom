import { useEffect, useState } from 'react';
import type { DashboardState } from './types';

export interface DashboardHook {
  state: DashboardState | null;
  connected: boolean;
}

export function useDashboard(): DashboardHook {
  const [state, setState] = useState<DashboardState | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    // No initial fetch: the SSE endpoint sends a full state frame on connect,
    // and a parallel fetch can race it and overwrite fresher data.
    const es = new EventSource('/api/events');
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => { setConnected(true); setState(JSON.parse(e.data) as DashboardState); };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);
  return { state, connected };
}
