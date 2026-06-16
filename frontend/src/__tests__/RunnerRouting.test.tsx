import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RunnerRouting, groupByWorkflow } from '../RunnerRouting';
import type { PlanRow } from '../types';

const planResp = {
  enabled: false, shedCount: 1, shedThresholdMinutes: 1.5, reclaimRatePct: 2.3,
  lastError: null, lastPushedAt: null, lastVerifiedAt: null, lastPushedHash: null,
  map: { integration: 'kindash-arc' },
  plan: [
    { key: 'unit', p90Secs: 480, scoreMinutes: 0.7, decision: 'kindash-arc-spot', source: 'auto', reason: 'spot', collecting: false, label: 'test: unit', workflow: '_static-checks.yml' },
    { key: 'server', p90Secs: 200, scoreMinutes: 0.3, decision: 'kindash-arc-spot', source: 'auto', reason: 'spot', collecting: false, label: 'test: server', workflow: '_static-checks.yml' },
    { key: 'integration', p90Secs: 720, scoreMinutes: 1.1, decision: 'kindash-arc', source: 'auto', reason: 'on-demand', collecting: false, label: 'test: integration', workflow: '_integration-tests.yml' },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('RunnerRouting panel', () => {
  it('renders each job with a non-color decision label and aria-pressed override controls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => planResp }));
    render(<RunnerRouting />);
    await screen.findByText('integration');
    expect(screen.getByTestId('runner-decision-integration').textContent).toMatch(/on-demand/i);
    expect(screen.getByTestId('override-integration-ondemand')).toHaveAttribute('aria-pressed');
    expect(screen.getByTestId('override-integration-spot')).toBeInTheDocument();
    expect(screen.getByTestId('override-integration-auto')).toBeInTheDocument();
  });

  it('PUTs an override and re-fetches the plan', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => planResp })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ applied: ['overrides'] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => planResp });
    vi.stubGlobal('fetch', fetchMock);
    render(<RunnerRouting />);
    fireEvent.click(await screen.findByTestId('override-unit-ondemand'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/runner-routing', expect.objectContaining({ method: 'PUT' })));
  });

  it('groups jobs under their workflow header and shows the real check name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => planResp }));
    render(<RunnerRouting />);
    // Workflow group headers present
    expect(await screen.findByTestId('runner-group-_static-checks.yml')).toBeInTheDocument();
    expect(screen.getByTestId('runner-group-_integration-tests.yml')).toBeInTheDocument();
    // Real check names shown as the primary label (bare key kept as secondary)
    expect(screen.getByText('test: unit')).toBeInTheDocument();
    expect(screen.getByText('test: integration')).toBeInTheDocument();
    // Override controls still keyed by the job key
    expect(screen.getByTestId('override-unit-spot')).toBeInTheDocument();
  });

  it('shows a non-color failure prefix when lastError is set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...planResp, lastError: 'rate limited' }) }));
    render(<RunnerRouting />);
    expect((await screen.findByTestId('runner-push-status')).textContent).toMatch(/Push failed:/);
  });

  it('shows the current shedThresholdMinutes and PUTs it on blur (the knob)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => planResp })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ applied: ['shedThresholdMinutes'] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => planResp });
    vi.stubGlobal('fetch', fetchMock);
    render(<RunnerRouting />);
    const knob = await screen.findByLabelText(/shed threshold/i) as HTMLInputElement;
    expect(knob.value).toBe('1.5'); // the live threshold, NOT shedCount
    fireEvent.change(knob, { target: { value: '3' } });
    fireEvent.blur(knob);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/runner-routing',
      expect.objectContaining({ method: 'PUT', body: expect.stringContaining('shedThresholdMinutes') })));
    expect(JSON.parse((fetchMock.mock.calls.find((c) => c[0] === '/api/runner-routing')![1] as RequestInit).body as string))
      .toEqual({ shedThresholdMinutes: 3 });
  });
});

describe('groupByWorkflow', () => {
  const row = (key: string, workflow?: string): PlanRow => ({
    key, p90Secs: 1, scoreMinutes: 0, decision: 'kindash-arc-spot',
    reason: '', source: 'auto', collecting: false, workflow,
  });

  it('groups by workflow preserving first-seen order of groups and rows', () => {
    const groups = groupByWorkflow([
      row('tsc', '_static-checks.yml'),
      row('integration', '_integration-tests.yml'),
      row('unit', '_static-checks.yml'),
    ]);
    expect(groups.map((g) => g.workflow)).toEqual(['_static-checks.yml', '_integration-tests.yml']);
    expect(groups[0]!.rows.map((r) => r.key)).toEqual(['tsc', 'unit']);
  });

  it('puts rows without workflow metadata into a trailing "other" group', () => {
    const groups = groupByWorkflow([row('tsc', '_static-checks.yml'), row('mystery')]);
    expect(groups.map((g) => g.workflow)).toEqual(['_static-checks.yml', 'other']);
    expect(groups[1]!.rows.map((r) => r.key)).toEqual(['mystery']);
  });
});
