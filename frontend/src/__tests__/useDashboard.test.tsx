import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDashboard } from '../useDashboard';
import type { DashboardState } from '../types';

// Minimal EventSource mock installed on globalThis (test-file-scoped)
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  fireOpen() { this.onopen?.(); }
  fireMessage(data: string) { this.onmessage?.({ data }); }
  fireError() { this.onerror?.(); }
  close() {}
}

const SAMPLE_STATE: DashboardState = {
  generatedAt: '2026-06-10T12:00:00Z', staleSince: null, repos: [],
};

beforeEach(() => {
  MockEventSource.instances = [];
  // Install on globalThis so new EventSource(...) in useDashboard picks it up
  Object.defineProperty(globalThis, 'EventSource', {
    value: MockEventSource,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDashboard', () => {
  it('starts disconnected before any event', () => {
    const { result } = renderHook(() => useDashboard());
    expect(result.current.connected).toBe(false);
    expect(result.current.state).toBeNull();
  });

  it('connected becomes true on onopen', () => {
    const { result } = renderHook(() => useDashboard());
    act(() => { MockEventSource.instances[0]!.fireOpen(); });
    expect(result.current.connected).toBe(true);
  });

  it('connected becomes true + state updates on first message', () => {
    const { result } = renderHook(() => useDashboard());
    act(() => { MockEventSource.instances[0]!.fireMessage(JSON.stringify(SAMPLE_STATE)); });
    expect(result.current.connected).toBe(true);
    expect(result.current.state?.generatedAt).toBe('2026-06-10T12:00:00Z');
  });

  it('connected becomes false on onerror', () => {
    const { result } = renderHook(() => useDashboard());
    act(() => { MockEventSource.instances[0]!.fireOpen(); });
    expect(result.current.connected).toBe(true);
    act(() => { MockEventSource.instances[0]!.fireError(); });
    expect(result.current.connected).toBe(false);
  });

  it('state is retained after onerror (last known data stays visible)', () => {
    const { result } = renderHook(() => useDashboard());
    act(() => { MockEventSource.instances[0]!.fireMessage(JSON.stringify(SAMPLE_STATE)); });
    act(() => { MockEventSource.instances[0]!.fireError(); });
    expect(result.current.state).not.toBeNull();
  });
});
