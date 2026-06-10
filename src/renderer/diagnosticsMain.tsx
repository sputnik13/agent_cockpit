import { createRoot } from 'react-dom/client';
import { initLogsSync } from './providerClient/logsStore';
import { LogViewerBody } from './diagnostics/LogViewerBody';

// Seed ring buffer + subscribe to live entries. No cockpit/provider/session/
// tmux stores are imported or initialised here — this renderer only handles logs.
initLogsSync();

const container = document.getElementById('root');
if (!container) throw new Error('diagnostics-renderer: #root not found');

createRoot(container).render(<LogViewerBody />);
