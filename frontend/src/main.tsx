// frontend/src/main.tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WorkspaceApp } from './shell/WorkspaceApp';
import { workspaceEnabled } from './shell/enabled';
import { ApiBaseProvider } from './embed/ApiBaseContext';
import { RouterProvider } from './embed/RouterContext';
import './styles.css';
import './standalone.css';

// Strangler-fig (flipped): the unified workspace is the DEFAULT surface; the
// classic App stays reachable via ?legacy=1. Both wrap in ApiBaseProvider (the
// shared fetch-site components are used by both); only the workspace needs the
// section RouterProvider (hash mode = today's behavior).
const workspace = workspaceEnabled(location.search, localStorage);
const inner = workspace
  ? <RouterProvider mode="hash"><WorkspaceApp /></RouterProvider>
  : <App />;
createRoot(document.getElementById('root')!).render(
  <ApiBaseProvider><div className="prdash-root">{inner}</div></ApiBaseProvider>,
);
