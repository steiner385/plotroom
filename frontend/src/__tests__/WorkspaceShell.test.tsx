import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RouterProvider } from '../embed/RouterContext';
import { WorkspaceShell } from '../shell/WorkspaceShell';
import { sectionFromHash, hashForSection, SECTIONS, DEFAULT_SECTION } from '../shell/sections';

describe('sections routing (pure)', () => {
  it('round-trips a section id through the hash', () => {
    for (const s of SECTIONS) expect(sectionFromHash(hashForSection(s.id))).toBe(s.id);
  });
  it('returns null for an unknown hash', () => {
    expect(sectionFromHash('#nope')).toBeNull();
    expect(sectionFromHash('')).toBeNull();
  });
});

describe('WorkspaceShell', () => {
  afterEach(() => { location.hash = ''; });

  it('renders all five sections in the rail + the header', () => {
    render(
      <RouterProvider mode="hash">
        <WorkspaceShell header={<div>SPINE</div>}><p>body</p></WorkspaceShell>
      </RouterProvider>,
    );
    const nav = screen.getByRole('navigation', { name: /workspace sections/i });
    for (const s of SECTIONS) expect(within(nav).getByText(s.label)).toBeInTheDocument();
    expect(screen.getByText('SPINE')).toBeInTheDocument();
  });

  it('renders the banner, the section rail, and its children in main', () => {
    location.hash = '#health';
    render(
      <RouterProvider mode="hash">
        <WorkspaceShell header={<span>spine</span>}><p>section body</p></WorkspaceShell>
      </RouterProvider>,
    );
    expect(screen.getByRole('banner')).toHaveTextContent('spine');
    expect(screen.getByRole('navigation', { name: /workspace sections/i })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('section body');
  });

  it('defaults to Health and marks it aria-current', () => {
    render(
      <RouterProvider mode="hash">
        <WorkspaceShell header={null}><div>HEALTH</div></WorkspaceShell>
      </RouterProvider>,
    );
    expect(screen.getByText('Health')).toHaveAttribute('aria-current', 'page');
  });

  it('switching sections updates hash and aria-current', () => {
    render(
      <RouterProvider mode="hash">
        <WorkspaceShell header={null}><div>BODY</div></WorkspaceShell>
      </RouterProvider>,
    );
    fireEvent.click(screen.getByText('Model & Edit'));
    expect(location.hash).toBe('#model-edit');
    expect(screen.getByText('Model & Edit')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Health')).not.toHaveAttribute('aria-current');
  });

  it('honors a deep-link hash on mount', () => {
    location.hash = hashForSection('insights');
    render(
      <RouterProvider mode="hash">
        <WorkspaceShell header={null}><div>INSIGHTS</div></WorkspaceShell>
      </RouterProvider>,
    );
    expect(screen.getByText('Insights')).toHaveAttribute('aria-current', 'page');
    expect(DEFAULT_SECTION).toBe('health');
  });

  it('redirects retired #tune / #metrics hashes to Insights (WS3a)', () => {
    location.hash = '#tune';
    render(
      <RouterProvider mode="hash">
        <WorkspaceShell header={null}><div>BODY</div></WorkspaceShell>
      </RouterProvider>,
    );
    expect(screen.getByText('Insights')).toHaveAttribute('aria-current', 'page');
  });

  it('exposes a skip-to-content link that targets and focuses main (WCAG 2.4.1)', () => {
    render(
      <RouterProvider mode="hash">
        <WorkspaceShell header={<div>SPINE</div>}><p>body</p></WorkspaceShell>
      </RouterProvider>,
    );
    const skip = screen.getByRole('link', { name: /skip to content/i });
    // it must be the FIRST focusable element so a keyboard user hits it before the header
    const focusables = Array.from(document.querySelectorAll('a[href],button,[tabindex]'));
    expect(focusables[0]).toBe(skip);
    const main = screen.getByRole('main');
    expect(skip).toHaveAttribute('href', `#${main.id}`);
    expect(main.id).toBeTruthy();
    expect(main).toHaveAttribute('tabindex', '-1');
    // activating it moves focus into main (programmatic, so hash routing isn't disturbed)
    fireEvent.click(skip);
    expect(main).toHaveFocus();
    expect(location.hash).not.toContain(main.id);
  });

  it('main element does NOT have aria-live (no live-region flood on SSE updates)', () => {
    render(
      <RouterProvider mode="hash">
        <WorkspaceShell header={null}><div>BODY</div></WorkspaceShell>
      </RouterProvider>,
    );
    expect(screen.getByRole('main')).not.toHaveAttribute('aria-live');
  });
});
