import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SectionState } from '../shell/SectionState';

describe('SectionState (#187)', () => {
  it('error kind is an alert with headline, sub, and a working action button', () => {
    const onClick = vi.fn();
    render(<SectionState kind="error" headline="Broke" sub="what happened"
      action={{ label: 'Refresh page', onClick }} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Broke');
    expect(alert).toHaveTextContent('what happened');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh page' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('non-error kinds announce politely via role=status', () => {
    render(<SectionState kind="stale" headline="Data may be out of date" />);
    expect(screen.getByRole('status')).toHaveTextContent('Data may be out of date');
  });

  it('omits the action when none is given', () => {
    render(<SectionState kind="empty" headline="Nothing here" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
