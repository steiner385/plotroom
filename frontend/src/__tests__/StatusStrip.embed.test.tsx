import { render, screen, fireEvent } from '@testing-library/react';
import { StatusStrip } from '../embed/StatusStrip';

const api = { self: async () => ({ ingestionFreshnessSecs: 1, derivationCache: { hits: 0, misses: 0, hitRate: 1, size: 0 }, apiRateLimit: null, status: 'ok', reasons: [] }) } as any;

it('shows the reconnecting liveness state', () => {
  render(<StatusStrip repos={['o/a']} focused="o/a" onFocus={() => {}} connected={false} stale={false} api={api} />);
  expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
});

it('opens the Legend dialog from the ? button', () => {
  render(<StatusStrip repos={['o/a']} focused="o/a" onFocus={() => {}} connected stale={false} api={api} />);
  fireEvent.click(screen.getByRole('button', { name: /legend/i }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});
