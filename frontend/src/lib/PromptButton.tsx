// One affordance for "draft a Claude Code prompt", used next to every Draft-PR
// button and as the single home for the copy-to-clipboard + "Copied" flash that
// was previously re-implemented inline in three drawers. `getText` may be sync
// (a pure builder) or async (a server round-trip): a SYNC builder copies + flips
// to "Copied" synchronously within the click handler, which the drawer tests
// rely on (they assert the flash without awaiting).
import { useState } from 'react';

/** Best-effort clipboard write — silently no-ops where the API is unavailable
 *  (insecure context / older browser); the prompt text is shown too, to copy by hand. */
export async function copyToClipboard(text: string): Promise<void> {
  try { await navigator.clipboard?.writeText?.(text); } catch { /* unavailable — shown to copy manually */ }
}

export interface PromptButtonProps {
  /** Build the prompt text on click — string (sync) or Promise<string> (async). */
  getText: () => string | Promise<string>;
  label?: string;
  className?: string;
  testId?: string;
  /** Render the built prompt in a <pre> below the button (default true). */
  showPrompt?: boolean;
  promptClassName?: string;
  promptTestId?: string;
}

export function PromptButton({
  getText, label = 'Copy Claude Code prompt', className = 'cc-prompt-btn',
  testId, showPrompt = true, promptClassName = 'cc-prompt', promptTestId,
}: PromptButtonProps) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);

  const flash = (t: string) => {
    setText(t);
    void copyToClipboard(t);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const onClick = () => {
    const result = getText();
    if (typeof result === 'string') { flash(result); return; } // sync — keep it synchronous
    setBusy(true);
    result
      .then(flash)
      .catch(() => setText('Couldn’t build the prompt — try again.'))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <button type="button" className={className} data-testid={testId} disabled={busy} onClick={onClick}>
        {copied ? '✓ Copied' : busy ? 'Building…' : label}
      </button>
      {showPrompt && text != null && (
        <pre className={promptClassName} data-testid={promptTestId} aria-label="claude code prompt">{text}</pre>
      )}
    </>
  );
}
