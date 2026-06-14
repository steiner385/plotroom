import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SpineLane } from '../SpineLane';
import type { Lane } from '../../types';

const lane = (p: Partial<Lane>): Lane => ({
  id: 'queue', title: 'Merge queue', status: 'amber', summary: '2 trains · ~11m left',
  wiredness: 'wired', gating: true, glyphPosition: 'dot',
  renderExpanded: () => <div data-testid="panel">detail</div>, ...p,
});

describe('SpineLane', () => {
  it('renders status word + summary in the accessible name (color-independent)', () => {
    render(<SpineLane lane={lane({})} expanded={false} onToggle={() => {}} />);
    const btn = screen.getByRole('button', { name: /Merge queue.*watch.*2 trains/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
  it('keeps the expanded panel in the DOM (hidden) so aria-controls always resolves', () => {
    render(<SpineLane lane={lane({})} expanded={false} onToggle={() => {}} />);
    const panel = screen.getByTestId('panel').closest('[id]')!;
    expect(panel).toHaveAttribute('hidden');
    expect(screen.getByRole('button').getAttribute('aria-controls')).toBe(panel.id);
  });
  it('toggles on click', () => {
    const onToggle = vi.fn();
    render(<SpineLane lane={lane({})} expanded={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
  it('a not-wired lane is not a button and exposes no expand', () => {
    render(<SpineLane lane={lane({ wiredness: 'not-wired', summary: 'not wired — no deploy envs' })}
      expanded={false} onToggle={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('spine-lane-queue')).toBeInTheDocument();
  });
});
