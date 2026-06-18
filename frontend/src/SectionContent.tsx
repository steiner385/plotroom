import { ForecastBanner } from './shell/ForecastBanner';
import { HealthView } from './sections/health/HealthView';
import { PipelineView } from './sections/pipeline/PipelineView';
import { DiagnoseView } from './sections/diagnose/DiagnoseView';
import { ModelEditView } from './sections/modelEdit/ModelEditView';
import { InsightsView } from './sections/insights/InsightsView';
import { useSectionRoute } from './embed/RouterContext';
import { laneToSection, type SectionId } from './shell/sections';
import type { WorkspaceApi } from './shell/workspaceApi';
import type { DashboardState } from './types';

export interface SectionContentProps {
  active: SectionId;
  state: DashboardState | null;
  connected: boolean;
  api: WorkspaceApi;
  focused: string | null;
  onFocusRepo: (repo: string) => void;
}

/** Render the active section view. No landmark (the host/standalone shell owns <main>). */
export function SectionContent({ active, state, connected, api, focused, onFocusRepo }: SectionContentProps) {
  const { go } = useSectionRoute();
  if (!state) {
    return <div className="workspace-loading" role="status">Connecting to the live feed…</div>;
  }
  switch (active) {
    case 'health':
      return (
        <>
          <ForecastBanner api={api} repo={focused} />
          <HealthView state={state} connected={connected} onFocusRepo={onFocusRepo}
            onJumpToLane={(laneId) => go(laneToSection(laneId))} />
        </>
      );
    case 'pipeline': return <PipelineView state={state} focusedRepo={focused} />;
    case 'diagnose': return <DiagnoseView state={state} focusedRepo={focused} api={api} />;
    case 'model-edit': return <ModelEditView repo={focused} api={api} />;
    case 'insights': return <InsightsView repo={focused} api={api} />;
  }
}
