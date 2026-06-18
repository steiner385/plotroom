import { useRef, useState } from 'react';
import { PipelineSwitcher } from '../shell/PipelineSwitcher';
import { SelfHealthDot } from '../shell/SelfHealthDot';
import { LegendPanel } from '../LegendPanel';
import { liveness } from '../shell/liveness';
import type { WorkspaceApi } from '../shell/workspaceApi';

export interface StatusStripProps {
  repos: readonly string[];
  focused: string | null;
  onFocus: (repo: string) => void;
  connected: boolean;
  stale: boolean;
  api: WorkspaceApi;
}

/** Content-chrome for the embed: pipeline switcher + liveness + self-health + Legend.
 *  Re-homes the signals the dropped spine header carried (no host header to rely on). */
export function StatusStrip({ repos, focused, onFocus, connected, stale, api }: StatusStripProps) {
  const [legendOpen, setLegendOpen] = useState(false);
  const legendRef = useRef<HTMLButtonElement>(null);
  const live = liveness(connected, stale);
  return (
    <div className="prdash-status-strip">
      <span className="pipeline-strip-label" id="prdash-pipeline-label">Pipeline:</span>
      <PipelineSwitcher repos={repos} focused={focused} onFocus={onFocus} />
      <span className={`liveness ${live.cls}`} title={live.title}>{live.label}</span>
      <SelfHealthDot api={api} />
      <button type="button" ref={legendRef} className="legend-btn" aria-label="Legend"
        aria-haspopup="dialog" aria-expanded={legendOpen} onClick={() => setLegendOpen(true)}>
        <span aria-hidden="true">?</span>
      </button>
      <LegendPanel open={legendOpen} onClose={() => setLegendOpen(false)} returnFocusRef={legendRef} />
    </div>
  );
}
