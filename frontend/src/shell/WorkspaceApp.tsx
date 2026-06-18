// The unified-workspace entry composition (spec 001, Increment 1 MVP): wires the
// shell + the spine (pipeline switcher + liveness) + section views via the shared
// core (useWorkspaceData + SectionContent). Mounted behind the workspace flag; the
// classic App stays the default until parity.
import { useEffect, useRef, useState } from 'react';
import './workspace.css';
import { WorkspaceShell } from './WorkspaceShell';
import { PipelineSwitcher } from './PipelineSwitcher';
import { useWorkspaceData } from '../useWorkspaceData';
import { useFocusedRepo } from './useFocusedRepo';
import { SectionContent } from '../SectionContent';
import { useSectionRoute } from '../embed/RouterContext';
import { SettingsPanel } from '../SettingsPanel';
import { LegendPanel } from '../LegendPanel';
import { SelfHealthDot } from './SelfHealthDot';
import { CommandPalette } from './CommandPalette';

export function WorkspaceApp() {
  const { state, connected, stale, repos, api, notifySupported, notifyEnabled, toggleNotify } = useWorkspaceData();
  const [focused, focus] = useFocusedRepo({ repos });
  const { active } = useSectionRoute();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);
  const legendRef = useRef<HTMLButtonElement>(null);

  // Global ⌘K / Ctrl-K opens the command palette (the shell owns the shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const header = (
    <div className="workspace-spine">
      <span className="workspace-brand">CI/CD Workspace</span>
      <PipelineSwitcher repos={repos} focused={focused} onFocus={focus} />
      {(() => {
        // Three-state spine indicator (roadmap 5.6): live (fresh frames) · stale
        // (socket up but feed quiet) · reconnecting (socket down).
        const liveness = !connected ? { cls: 'down', label: '○ reconnecting', title: 'reconnecting' }
          : stale ? { cls: 'stale', label: '◐ stale', title: 'connected, but no fresh data in 90s — feed may be stalled' }
          : { cls: 'live', label: '● live', title: 'live' };
        return <span className={`liveness ${liveness.cls}`} title={liveness.title}>{liveness.label}</span>;
      })()}
      <SelfHealthDot api={api} />
      <button type="button" className="cmdk-trigger" aria-label="Command palette (⌘K)"
        title="Command palette — jump to any section or pipeline (⌘K)" onClick={() => setPaletteOpen(true)}>
        <span aria-hidden="true">⌘K</span>
      </button>
      <button type="button" ref={legendRef} className="legend-btn" aria-label="Legend"
        title="Legend — what every shape, color, and term on the board means"
        aria-haspopup="dialog" aria-expanded={legendOpen} onClick={() => setLegendOpen(true)}>
        <span aria-hidden="true">?</span>
      </button>
      {notifySupported && (
        <button type="button" className="notify-bell" aria-pressed={notifyEnabled}
          aria-label="Browser notifications (this tab)"
          title={notifyEnabled
            ? 'Browser notifications on (this tab only — tab must stay open). Desktop notifications are toggled in Settings.'
            : 'Enable browser notifications (this tab only — tab must stay open). Desktop notifications are toggled in Settings.'}
          onClick={toggleNotify}>
          <span aria-hidden="true">{notifyEnabled ? '🔔' : '🔕'}</span>
        </button>
      )}
      <button type="button" ref={gearRef} className="settings-gear" aria-label="Settings"
        title="Settings — watched repos, tuning, notifications, per-repo config"
        aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}>
        <span aria-hidden="true">⚙</span>
      </button>
      <a className="classic-link" href="?legacy=1"
        title="Switch to the classic dashboard (sticky — return with ?workspace=1)">Classic ↩</a>
    </div>
  );

  const modals = (
    <>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} returnFocusRef={gearRef} connected={connected} />
      <LegendPanel open={legendOpen} onClose={() => setLegendOpen(false)} returnFocusRef={legendRef} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} repos={repos} onFocusRepo={focus} />
    </>
  );

  return (
    <>
      <WorkspaceShell header={header}>
        <SectionContent
          active={active}
          state={state}
          connected={connected}
          api={api}
          focused={focused}
          onFocusRepo={focus}
        />
      </WorkspaceShell>
      {modals}
    </>
  );
}
