// frontend/src/embed/PrDashboard.tsx
import { ApiBaseProvider } from './ApiBaseContext';
import { RouterProvider, useSectionRoute } from './RouterContext';
import { useWorkspaceData } from '../useWorkspaceData';
import { useFocusedRepo } from '../shell/useFocusedRepo';
import { SectionContent } from '../SectionContent';
import { StatusStrip } from './StatusStrip';
import '../styles.css';
// The workspace SECTIONS the embed renders (Model & Edit, Build, Tune, Optimize, …) are
// styled in workspace.css — the protection matrix, the drill drawer, the heat overlays,
// the pipeline canvas, the tune panels. Without this import they render unstyled in the
// embed (only styles.css was bundled). The embed build scopes it to .prdash-root like the
// rest; the shell-only rules (rail/header/bottom-nav, which the embed doesn't render) are
// harmless dead CSS.
import '../shell/workspace.css';

export interface PrDashboardProps {
  /** Host proxy root for all data + the SSE. Default '/api'. Auth is the host's job. */
  apiBase?: string;
  /** URL prefix the embed lives under (path routing). Default ''. */
  basename?: string;
  /** 'path' (embedded, default) drives sections via History; 'hash' = standalone style. */
  routerMode?: 'path' | 'hash';
  /** Controlled focused repo; omit for the in-content sticky switcher. */
  focusedRepo?: string;
  onFocusChange?: (repo: string) => void;
  /** Uncontrolled only: mirror the focused pipeline in a ?pipeline= query param for
   *  shareable deep links (#191). Default true; set false if the host owns the URL. */
  allowPipelineInUrl?: boolean;
  /** Appended to the `.prdash-root` wrapper. */
  className?: string;
  /** Send credentials on the SSE (cookie-proxy hosts). Default false. */
  withCredentials?: boolean;
}

function PrDashboardInner(
  { focusedRepo, onFocusChange, allowPipelineInUrl }: Pick<PrDashboardProps, 'focusedRepo' | 'onFocusChange' | 'allowPipelineInUrl'>,
) {
  const { state, connected, stale, repos, api } = useWorkspaceData();
  const [focused, focus] = useFocusedRepo({ controlled: focusedRepo, onChange: onFocusChange, repos, allowPipelineInUrl });
  const { active } = useSectionRoute();
  return (
    <>
      <StatusStrip repos={repos} focused={focused} onFocus={focus} connected={connected} stale={stale} api={api} />
      <SectionContent active={active} state={state} connected={connected} stale={stale} api={api} focused={focused} onFocusRepo={focus} />
    </>
  );
}

/** Content-only embeddable dashboard. The host owns chrome, routing shell, and auth. */
export function PrDashboard(
  { apiBase = '/api', basename = '', routerMode = 'path', focusedRepo, onFocusChange, className, withCredentials = false, allowPipelineInUrl = true }: PrDashboardProps,
) {
  return (
    <ApiBaseProvider base={apiBase} withCredentials={withCredentials}>
      <RouterProvider mode={routerMode} basename={basename}>
        <div className={className ? `prdash-root ${className}` : 'prdash-root'}>
          <PrDashboardInner focusedRepo={focusedRepo} onFocusChange={onFocusChange} allowPipelineInUrl={allowPipelineInUrl} />
        </div>
      </RouterProvider>
    </ApiBaseProvider>
  );
}
