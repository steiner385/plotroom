import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PromptButton } from '../PromptButton';

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

describe('PromptButton', () => {
  it('a SYNC getText copies + flips to Copied synchronously (drawer contract)', () => {
    render(<PromptButton getText={() => 'PROMPT-TEXT'} testId="b" />);
    const btn = screen.getByTestId('b');
    expect(btn.textContent).toMatch(/Copy Claude Code prompt/);
    fireEvent.click(btn);
    // synchronous flip — no await — mirrors ProtectionMap's assertion
    expect(btn.textContent).toMatch(/Copied/);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('PROMPT-TEXT');
  });

  it('renders the prompt text in a <pre> when showPrompt (default)', () => {
    render(<PromptButton getText={() => 'HELLO'} testId="b" promptTestId="p" />);
    fireEvent.click(screen.getByTestId('b'));
    expect(screen.getByTestId?.('p') ?? screen.getByTestId('p')).toHaveTextContent('HELLO');
  });

  it('does not render a <pre> when showPrompt is false', () => {
    render(<PromptButton getText={() => 'HELLO'} testId="b" promptTestId="p" showPrompt={false} />);
    fireEvent.click(screen.getByTestId('b'));
    expect(screen.queryByTestId('p')).not.toBeInTheDocument();
  });

  it('an ASYNC getText shows Building… then the resolved prompt', async () => {
    render(<PromptButton getText={async () => 'ASYNC-PROMPT'} testId="b" promptTestId="p" />);
    fireEvent.click(screen.getByTestId('b'));
    expect(screen.getByTestId('b').textContent).toMatch(/Building/);
    expect(await screen.findByTestId('p')).toHaveTextContent('ASYNC-PROMPT');
  });

  it('honours a custom label', () => {
    render(<PromptButton getText={() => 'x'} label="Copy prompt" testId="b" />);
    expect(screen.getByTestId('b').textContent).toMatch(/Copy prompt/);
  });

  it('survives a rejected async getText (shows a fallback, clears busy)', async () => {
    render(<PromptButton getText={async () => { throw new Error('nope'); }} testId="b" promptTestId="p" />);
    fireEvent.click(screen.getByTestId('b'));
    await waitFor(() => expect(screen.getByTestId('b')).not.toBeDisabled());
    expect(screen.getByTestId('p').textContent?.toLowerCase()).toContain('prompt');
  });
});
