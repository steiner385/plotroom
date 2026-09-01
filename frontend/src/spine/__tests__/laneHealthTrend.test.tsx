import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { buildLaneHealth } from '../laneHealth';
import { SpineLane } from '../SpineLane';
import type { DashboardState, Lane } from '../../types';

const degrading = [{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: false }, { ok: true }, { ok: false }];

const state = (mainSeries: { ok: boolean | null }[]): DashboardState =>
  ({ generatedAt: '', staleSince: null,
    repos: [{ repo: 'acme/widgets', hasDeploy: false, prs: [], queue: null,
      laneHealth: { main: 'green', mainSeries } }] } as unknown as DashboardState);

describe('buildLaneHealth main-lane trend (#258)', () => {
  it('attaches a degrading-green trend to the main lane only', () => {
    const lanes = buildLaneHealth(state(degrading));
    const main = lanes.find((l) => l.id === 'main')!;
    expect(main.trend).toMatchObject({ direction: 'down', polarity: 'bad', significant: true });
    // other lanes carry no trend
    expect(lanes.find((l) => l.id === 'pr-ci')!.trend).toBeUndefined();
  });
  it('leaves the main lane without a trend when the series is stable/short', () => {
    const lanes = buildLaneHealth(state([{ ok: true }, { ok: true }, { ok: true }]));
    const main = lanes.find((l) => l.id === 'main')!;
    expect(main.trend?.significant ?? false).toBe(false);
  });
});

describe('SpineLane renders the trend arrow (#258)', () => {
  const base: Lane = { id: 'main', title: 'main', status: 'green', summary: 'green',
    glyphPosition: 'dot', wiredness: 'wired', gating: true, renderExpanded: () => null } as unknown as Lane;
  it('shows the arrow when the lane carries a significant trend', () => {
    const lane = { ...base, trend: { deltaPct: -50, direction: 'down' as const, polarity: 'bad' as const, significant: true } };
    render(<ul><SpineLane lane={lane} expanded={false} onToggle={() => {}} /></ul>);
    expect(screen.getByLabelText('-50% vs earlier').textContent).toBe('▼');
  });
  it('shows no arrow when the lane has no trend', () => {
    render(<ul><SpineLane lane={base} expanded={false} onToggle={() => {}} /></ul>);
    expect(document.querySelector('.trend-arrow')).toBeNull();
  });
});
