import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CheckGantt, ganttScale } from '../CheckGantt';
import type { CheckView } from '../types';

const check = (over: Partial<CheckView>): CheckView => ({
  name: 'fast-checks / ESLint', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true, workflowName: null,
  elapsedSeconds: 180, expectedSeconds: 200, url: 'https://x/run1',
  waitKind: null, blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null,
  ...over,
});

describe('ganttScale', () => {
  it('is the max over the panel of max(elapsed, expected)', () => {
    expect(ganttScale([
      check({ elapsedSeconds: 180, expectedSeconds: 200 }),
      check({ elapsedSeconds: 240, expectedSeconds: 540 }), // longest: expected 540
      check({ elapsedSeconds: 300, expectedSeconds: null }),
    ])).toBe(540);
  });

  it('uses elapsed when it exceeds expected (overdue check defines the scale)', () => {
    expect(ganttScale([check({ elapsedSeconds: 3900, expectedSeconds: 600 })])).toBe(3900);
  });

  it('falls back to 60 when no check has any duration', () => {
    expect(ganttScale([check({ elapsedSeconds: null, expectedSeconds: null })])).toBe(60);
    expect(ganttScale([])).toBe(60);
  });
});

describe('CheckGantt', () => {
  it('the longest check defines 100%; others fill proportionally', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'long', elapsedSeconds: 600, expectedSeconds: null, status: 'IN_PROGRESS', conclusion: null }),
      check({ name: 'short', elapsedSeconds: 300, expectedSeconds: null, status: 'IN_PROGRESS', conclusion: null }),
    ]} />);
    const fills = container.querySelectorAll('.g-bar i') as NodeListOf<HTMLElement>;
    expect(fills[0]!.style.width).toBe('100%');
    expect(fills[1]!.style.width).toBe('50%');
  });

  it('renders the expected tick only when expectedSeconds is present, at expected/scale', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'with-exp', elapsedSeconds: 240, expectedSeconds: 540, status: 'IN_PROGRESS', conclusion: null }),
      check({ name: 'no-exp', elapsedSeconds: 540, expectedSeconds: null, status: 'IN_PROGRESS', conclusion: null }),
    ]} />);
    const rows = container.querySelectorAll('.g-row');
    const tick = rows[0]!.querySelector('.exp') as HTMLElement;
    expect(tick).not.toBeNull();
    expect(tick.style.left).toBe('calc(100% - 2px)'); // scale = 540 → expected 540 at 100%, clamped to avoid clip
    expect(rows[1]!.querySelector('.exp')).toBeNull();
  });

  it('applies a color class per status', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'ok', status: 'COMPLETED', conclusion: 'SUCCESS' }),
      check({ name: 'run', status: 'IN_PROGRESS', conclusion: null, elapsedSeconds: 100, expectedSeconds: 300 }),
      check({ name: 'late', status: 'IN_PROGRESS', conclusion: null, elapsedSeconds: 600, expectedSeconds: 300 }),
      check({ name: 'bad', status: 'COMPLETED', conclusion: 'FAILURE' }),
      check({ name: 'wait', status: 'QUEUED', conclusion: null, elapsedSeconds: null, expectedSeconds: null }),
      check({ name: 'skip', status: 'COMPLETED', conclusion: 'SKIPPED', elapsedSeconds: null }),
    ]} />);
    const rows = Array.from(container.querySelectorAll('.g-row'));
    const kinds = rows.map((r) => r.className);
    expect(kinds[0]).toContain('g-done');
    expect(kinds[1]).toContain('g-running');
    expect(kinds[2]).toContain('g-overdue');
    expect(kinds[3]).toContain('g-failed');
    expect(kinds[4]).toContain('g-queued');
    expect(kinds[5]).toContain('g-skipped');
  });

  it('renders time text per status: done ✓, running elapsed/~expected, overdue ⚠, queued —', () => {
    render(<CheckGantt stage="ci" checks={[
      check({ name: 'ok', status: 'COMPLETED', conclusion: 'SUCCESS', elapsedSeconds: 180 }),
      check({ name: 'run', status: 'IN_PROGRESS', conclusion: null, elapsedSeconds: 240, expectedSeconds: 540 }),
      check({ name: 'late', status: 'IN_PROGRESS', conclusion: null, elapsedSeconds: 3900, expectedSeconds: 600 }),
      check({ name: 'wait', status: 'QUEUED', conclusion: null, elapsedSeconds: null, expectedSeconds: null }),
      check({ name: 'bad', status: 'COMPLETED', conclusion: 'FAILURE', elapsedSeconds: 300 }),
    ]} />);
    expect(screen.getByText('3m ✓')).toBeInTheDocument();
    expect(screen.getByText('4m / ~9m')).toBeInTheDocument();
    expect(screen.getByText('1h 5m ⚠ overdue')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('5m ✗')).toBeInTheDocument();
  });

  it('gives queued checks a faint fixed fill instead of a zero-width bar', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'wait', status: 'QUEUED', conclusion: null, elapsedSeconds: null, expectedSeconds: null }),
    ]} />);
    const fill = container.querySelector('.g-bar i') as HTMLElement;
    expect(fill.style.width).toBe('15%');
  });

  it('links the check name to its run when url is present', () => {
    render(<CheckGantt stage="ci" checks={[
      check({ name: 'linked', url: 'https://x/run9' }),
      check({ name: 'plain', url: null }),
    ]} />);
    expect(screen.getByRole('link', { name: 'linked' })).toHaveAttribute('href', 'https://x/run9');
    expect(screen.queryByRole('link', { name: 'plain' })).not.toBeInTheDocument();
  });

  it('keeps the advisory divider between required and advisory checks', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'req-check', isRequired: true }),
      check({ name: 'lighthouse', isRequired: false }),
    ]} />);
    expect(screen.getByText('advisory')).toBeInTheDocument();
    // divider sits between the two rows
    const items = Array.from(container.querySelectorAll('li'));
    const names = items.map((li) => li.textContent);
    expect(names.findIndex((t) => t?.includes('req-check')))
      .toBeLessThan(names.findIndex((t) => t === 'advisory'));
    expect(names.findIndex((t) => t === 'advisory'))
      .toBeLessThan(names.findIndex((t) => t?.includes('lighthouse')));
  });

  it('omits the divider when there are no advisory checks', () => {
    render(<CheckGantt stage="ci" checks={[check({ isRequired: true })]} />);
    expect(screen.queryByText('advisory')).not.toBeInTheDocument();
  });

  it('keeps the ETA-accuracy footer below the rows', () => {
    render(<CheckGantt stage="ci" checks={[check({})]}
      accuracy={{ medianAbsErrSecs: 120, n: 14 }} />);
    const line = screen.getByText('ETA accuracy (ci): typically ±2m (n=14)');
    expect(line.className).toContain('eta-accuracy');
  });

  it('omits the accuracy footer when no accuracy data is given', () => {
    render(<CheckGantt stage="ci" checks={[check({})]} />);
    expect(screen.queryByText(/ETA accuracy/)).not.toBeInTheDocument();
  });
});

describe('CheckGantt — workflow grouping (Y2)', () => {
  const rollup = (over: Partial<CheckView>): CheckView =>
    check({ workflowName: 'CI', ...over });

  it('renders no workflow headers when every check shares one workflow identity', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'a', workflowName: null }),
      check({ name: 'b', workflowName: null, isRequired: false }),
    ]} />);
    expect(container.querySelector('.g-workflow')).toBeNull();
    // and the same for a single named workflow
    const { container: c2 } = render(<CheckGantt stage="ci" checks={[
      rollup({ name: 'a' }), rollup({ name: 'b' }),
    ]} />);
    expect(c2.querySelector('.g-workflow')).toBeNull();
  });

  it('renders a muted header row per workflow when workflows mix', () => {
    render(<CheckGantt stage="ci" checks={[
      rollup({ name: 'ci' }),
      check({ name: 'ci-gate', workflowName: 'Auto-merge PRs', isRequired: false }),
    ]} />);
    expect(screen.getByText('CI')).toBeInTheDocument();
    expect(screen.getByText('Auto-merge PRs')).toBeInTheDocument();
  });

  it('ci-gate renders under the Auto-merge PRs header, in the advisory zone', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'ci-gate', workflowName: 'Auto-merge PRs', isRequired: false }),
      rollup({ name: 'ci', isRequired: true }),
      rollup({ name: 'lighthouse', isRequired: false }),
    ]} />);
    const texts = Array.from(container.querySelectorAll('li')).map((li) => li.textContent ?? '');
    const idx = (m: (t: string) => boolean) => texts.findIndex(m);
    const ciHeader = idx((t) => t === 'CI');
    const ciRow = idx((t) => t.includes('ci') && !t.includes('ci-gate') && t !== 'CI');
    const divider = idx((t) => t === 'advisory');
    const lighthouseRow = idx((t) => t.includes('lighthouse'));
    const amHeader = idx((t) => t === 'Auto-merge PRs');
    const ciGateRow = idx((t) => t.includes('ci-gate'));
    // rollup workflow first: header, required, advisory divider, its advisory rows
    expect(ciHeader).toBeLessThan(ciRow);
    expect(ciRow).toBeLessThan(divider);
    expect(divider).toBeLessThan(lighthouseRow);
    // foreign workflow after the divider, its checks under its own header
    expect(divider).toBeLessThan(amHeader);
    expect(amHeader).toBeLessThan(ciGateRow);
  });

  it('null-workflow checks group last under an "other checks" header when mixed', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'legacy-check', workflowName: null, isRequired: false }),
      rollup({ name: 'ci', isRequired: true }),
    ]} />);
    const texts = Array.from(container.querySelectorAll('li')).map((li) => li.textContent ?? '');
    const otherIdx = texts.findIndex((t) => t === 'other checks');
    expect(otherIdx).toBeGreaterThan(texts.findIndex((t) => t === 'CI'));
    expect(otherIdx).toBeLessThan(texts.findIndex((t) => t.includes('legacy-check')));
  });

  it('keeps one shared time scale across workflow groups', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      rollup({ name: 'long', elapsedSeconds: 600, expectedSeconds: null, status: 'IN_PROGRESS', conclusion: null }),
      check({ name: 'short', workflowName: 'Auto-merge PRs', isRequired: false,
        elapsedSeconds: 300, expectedSeconds: null, status: 'IN_PROGRESS', conclusion: null }),
    ]} />);
    const fills = container.querySelectorAll('.g-bar i') as NodeListOf<HTMLElement>;
    expect(fills[0]!.style.width).toBe('100%');
    expect(fills[1]!.style.width).toBe('50%');
  });

  it('keeps the accuracy footer once at the bottom in grouped mode', () => {
    const { container } = render(<CheckGantt stage="queue" checks={[
      rollup({ name: 'ci' }),
      check({ name: 'ci-gate', workflowName: 'Auto-merge PRs', isRequired: false }),
    ]} accuracy={{ medianAbsErrSecs: 120, n: 9 }} />);
    const items = Array.from(container.querySelectorAll('li'));
    expect(items.filter((li) => /ETA accuracy/.test(li.textContent ?? ''))).toHaveLength(1);
    expect(items[items.length - 1]!.textContent).toContain('ETA accuracy (queue)');
  });
});

describe('CheckGantt — waitKind rendering', () => {
  it('blocked: shows ⊘ blocked on {blockedOn} and keeps faint gray bar', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'unit-tests', status: 'QUEUED', conclusion: null,
        elapsedSeconds: null, expectedSeconds: null,
        waitKind: 'blocked', blockedOn: 'static-checks', waitingSeconds: null, expectedRunnerWaitSeconds: null }),
    ]} />);
    expect(screen.getByText('⊘ blocked on static-checks')).toBeInTheDocument();
    // row keeps the g-queued class (faint gray bar)
    expect(container.querySelector('.g-queued')).not.toBeNull();
  });

  it('blocked: trims the reusable-workflow " /" suffix from the blockedOn display text', () => {
    render(<CheckGantt stage="ci" checks={[
      check({ name: 'unit-tests', status: 'QUEUED', conclusion: null,
        elapsedSeconds: null, expectedSeconds: null,
        waitKind: 'blocked', blockedOn: 'static-checks /', waitingSeconds: null, expectedRunnerWaitSeconds: null }),
    ]} />);
    expect(screen.getByText('⊘ blocked on static-checks')).toBeInTheDocument();
  });

  it('runner with waitingSeconds: shows ⧗ waiting for runner · {dur}', () => {
    render(<CheckGantt stage="ci" checks={[
      check({ name: 'big-tests', status: 'QUEUED', conclusion: null,
        elapsedSeconds: null, expectedSeconds: null,
        waitKind: 'runner', blockedOn: null, waitingSeconds: 90, expectedRunnerWaitSeconds: null }),
    ]} />);
    expect(screen.getByText('⧗ waiting for runner · 2m')).toBeInTheDocument();
  });

  it('runner with waitingSeconds and expectedRunnerWaitSeconds: appends (typical ~{dur})', () => {
    render(<CheckGantt stage="ci" checks={[
      check({ name: 'big-tests', status: 'QUEUED', conclusion: null,
        elapsedSeconds: null, expectedSeconds: null,
        waitKind: 'runner', blockedOn: null, waitingSeconds: 90, expectedRunnerWaitSeconds: 120 }),
    ]} />);
    expect(screen.getByText('⧗ waiting for runner · 2m (typical ~2m)')).toBeInTheDocument();
  });

  it('runner with null waitingSeconds: shows just ⧗ waiting for runner', () => {
    render(<CheckGantt stage="ci" checks={[
      check({ name: 'big-tests', status: 'QUEUED', conclusion: null,
        elapsedSeconds: null, expectedSeconds: null,
        waitKind: 'runner', blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null }),
    ]} />);
    expect(screen.getByText('⧗ waiting for runner')).toBeInTheDocument();
  });

  it('runner row gets striped bar fill (g-runner-wait class)', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'big-tests', status: 'QUEUED', conclusion: null,
        elapsedSeconds: null, expectedSeconds: null,
        waitKind: 'runner', blockedOn: null, waitingSeconds: 90, expectedRunnerWaitSeconds: null }),
    ]} />);
    expect(container.querySelector('.g-runner-wait')).not.toBeNull();
  });

  it('runner amber threshold: turns amber when waitingSeconds > 2× expected', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'big-tests', status: 'QUEUED', conclusion: null,
        elapsedSeconds: null, expectedSeconds: null,
        waitKind: 'runner', blockedOn: null, waitingSeconds: 250, expectedRunnerWaitSeconds: 120 }),
    ]} />);
    // 250 > 2×120=240 → amber
    expect(container.querySelector('.g-runner-wait-amber')).not.toBeNull();
  });

  it('runner not-amber when waitingSeconds ≤ 2× expected', () => {
    const { container } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'big-tests', status: 'QUEUED', conclusion: null,
        elapsedSeconds: null, expectedSeconds: null,
        waitKind: 'runner', blockedOn: null, waitingSeconds: 240, expectedRunnerWaitSeconds: 120 }),
    ]} />);
    // 240 = 2×120 → not over threshold (must be strictly greater)
    expect(container.querySelector('.g-runner-wait-amber')).toBeNull();
  });

  it('unknown and null waitKind: keeps the plain — dash (unchanged)', () => {
    const { getAllByText } = render(<CheckGantt stage="ci" checks={[
      check({ name: 'u', status: 'QUEUED', conclusion: null,
        elapsedSeconds: null, waitKind: 'unknown',
        blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null }),
      check({ name: 'n', status: 'QUEUED', conclusion: null,
        elapsedSeconds: null, waitKind: null,
        blockedOn: null, waitingSeconds: null, expectedRunnerWaitSeconds: null }),
    ]} />);
    expect(getAllByText('—')).toHaveLength(2);
  });
});
