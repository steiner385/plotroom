import { describe, it, expect } from 'vitest';
import {
  classifyQueueHealth, QUEUE_HEALTH_REMEDIATION,
  DISPATCH_STALL_MIN_AGE_SECS, CAP_BACKLOG_MIN_WAIT_SECS,
  type GroupBuildTelemetry,
} from '../queue-health';

const NOW = new Date('2026-06-12T12:00:00Z');

/** Telemetry factory: a healthy in-flight group unless overridden. */
function group(over: Partial<GroupBuildTelemetry> = {}): GroupBuildTelemetry {
  return {
    oid: 'oidA',
    runCreatedAt: '2026-06-12T11:50:00Z', // 10 min old
    runStartedAt: null,
    anyCheckStarted: true,
    runnerWaitsInProgress: 0,
    maxRunnerWaitSecs: null,
    ...over,
  };
}

describe('classifyQueueHealth — classifier matrix (issue #39)', () => {
  it('healthy: building group with started checks and no runner waits', () => {
    const h = classifyQueueHealth([group()], NOW);
    expect(h.state).toBe('healthy');
    expect(h.detail).toBe(QUEUE_HEALTH_REMEDIATION.healthy);
  });

  it('healthy: no building groups at all (waiting-only queue)', () => {
    expect(classifyQueueHealth([], NOW).state).toBe('healthy');
  });

  it('dispatch-stall: run created >5min ago, runStartedAt null, no check started', () => {
    const h = classifyQueueHealth([group({ anyCheckStarted: false })], NOW);
    expect(h.state).toBe('dispatch-stall');
    expect(h.detail).toBe(QUEUE_HEALTH_REMEDIATION['dispatch-stall']);
    expect(h.detail).toContain('do NOT admin-merge');
  });

  it('dispatch-stall: runStartedAt == createdAt (REST-shaped telemetry)', () => {
    const h = classifyQueueHealth([group({
      anyCheckStarted: false,
      runStartedAt: '2026-06-12T11:50:00Z', // == runCreatedAt
    })], NOW);
    expect(h.state).toBe('dispatch-stall');
  });

  it('NOT a stall when runStartedAt > createdAt (the run did start)', () => {
    const h = classifyQueueHealth([group({
      anyCheckStarted: false,
      runStartedAt: '2026-06-12T11:51:00Z',
    })], NOW);
    expect(h.state).toBe('healthy');
  });

  it('NOT a stall under the 5-minute threshold (exactly at the boundary)', () => {
    const createdAt = new Date(NOW.getTime() - DISPATCH_STALL_MIN_AGE_SECS * 1000).toISOString();
    const h = classifyQueueHealth([group({ anyCheckStarted: false, runCreatedAt: createdAt })], NOW);
    expect(h.state).toBe('healthy');
  });

  it('IS a stall just past the 5-minute threshold', () => {
    const createdAt = new Date(NOW.getTime() - (DISPATCH_STALL_MIN_AGE_SECS + 1) * 1000).toISOString();
    const h = classifyQueueHealth([group({ anyCheckStarted: false, runCreatedAt: createdAt })], NOW);
    expect(h.state).toBe('dispatch-stall');
  });

  it('NOT a stall when a check has started (run was picked up)', () => {
    const h = classifyQueueHealth([group({ anyCheckStarted: true })], NOW);
    expect(h.state).toBe('healthy');
  });

  it('NOT a stall without run identity (runCreatedAt null — old data)', () => {
    const h = classifyQueueHealth([group({ anyCheckStarted: false, runCreatedAt: null })], NOW);
    expect(h.state).toBe('healthy');
  });

  it('NOT a stall on unparseable runCreatedAt', () => {
    const h = classifyQueueHealth([group({ anyCheckStarted: false, runCreatedAt: 'garbage' })], NOW);
    expect(h.state).toBe('healthy');
  });

  it('cap-backlog: runner waits in progress at/above the wait floor, runs do start', () => {
    const h = classifyQueueHealth([group({
      runnerWaitsInProgress: 3, maxRunnerWaitSecs: CAP_BACKLOG_MIN_WAIT_SECS,
    })], NOW);
    expect(h.state).toBe('cap-backlog');
    expect(h.detail).toBe(QUEUE_HEALTH_REMEDIATION['cap-backlog']);
    expect(h.detail).toContain('wait or raise cap');
  });

  it('cap-backlog: unmeasurable runner wait still counts', () => {
    const h = classifyQueueHealth([group({
      runnerWaitsInProgress: 1, maxRunnerWaitSecs: null,
    })], NOW);
    expect(h.state).toBe('cap-backlog');
  });

  it('NOT backlog below the wait floor (normal pickup latency)', () => {
    const h = classifyQueueHealth([group({
      runnerWaitsInProgress: 2, maxRunnerWaitSecs: CAP_BACKLOG_MIN_WAIT_SECS - 1,
    })], NOW);
    expect(h.state).toBe('healthy');
  });

  it('dispatch-stall wins over cap-backlog (one wedged group flips the badge red)', () => {
    const stalled = group({ oid: 'wedged', anyCheckStarted: false });
    const backlogged = group({ oid: 'busy', runnerWaitsInProgress: 4, maxRunnerWaitSecs: 300 });
    const h = classifyQueueHealth([backlogged, stalled], NOW);
    expect(h.state).toBe('dispatch-stall');
  });
});
