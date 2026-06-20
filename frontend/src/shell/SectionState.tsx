import type { ReactNode } from 'react';

export type SectionStateKind = 'loading' | 'empty' | 'error' | 'stale';

const ICON: Record<SectionStateKind, string> = {
  loading: '',   // the live region speaks; no glyph needed
  empty: '',
  error: '✕',
  stale: '◐',
};

/**
 * Shared non-data-state placeholder (#187): one consistent layout — icon +
 * headline + sub + optional action — so every section's empty / error / stale /
 * loading states read the same instead of ad-hoc one-liners. `error` uses
 * role="alert" (announced immediately); the rest use role="status" (polite).
 */
export function SectionState({ kind, headline, sub, action }: {
  kind: SectionStateKind;
  headline: string;
  sub?: ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className={`section-state section-state--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {ICON[kind] && <span className="section-state__icon" aria-hidden="true">{ICON[kind]}</span>}
      <div className="section-state__text">
        <p className="section-state__headline">{headline}</p>
        {sub != null && <p className="section-state__sub">{sub}</p>}
      </div>
      {action && (
        <button type="button" className="btn-ghost section-state__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
