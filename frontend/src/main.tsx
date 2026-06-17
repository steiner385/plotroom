import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WorkspaceApp } from './shell/WorkspaceApp';
import { workspaceEnabled } from './shell/enabled';
import './styles.css';

// Strangler-fig: the classic App is the default; the unified workspace is opt-in
// via ?workspace=1 (sticky). Flag off → identical to before.
const Root = workspaceEnabled(location.search, localStorage) ? WorkspaceApp : App;
createRoot(document.getElementById('root')!).render(<Root />);
