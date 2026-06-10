import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('renderer: #root not found');

// Note: intentionally not wrapped in <StrictMode>. The cockpit holds imperative,
// stateful resources (xterm terminals bound to PTYs/tmux) whose mount/unmount
// drives real session attach/detach; StrictMode's dev-only double-mount leaves a
// stale terminal DOM node capturing input and churns sessions.
createRoot(container).render(<App />);
