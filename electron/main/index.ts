import { app, BrowserWindow } from 'electron';
import { createMainWindow, createDiagnosticsWindow } from './window';
import { setupSecurity } from './security';
import { closeDb, getDb } from './store/sqlite';
import { registerIpc } from './ipc';
import { sessionManager } from './providers';
import { startSessionReaper, type SessionReaperHandle } from './providers/sessionReaper';
import { loadSettings } from './config';
import { installApplicationMenu } from './menu';
import { bootstrapPath } from './pathBootstrap';

let mainWindow: BrowserWindow | null = null;
let diagnosticsWindow: BrowserWindow | null = null;
let sessionReaper: SessionReaperHandle | null = null;

// Defense in depth: a late async emit (e.g. a node-pty chunk arriving during
// window teardown) must never take down the whole process.
process.on('uncaughtException', (err) => {
  console.error('[main:uncaughtException]', err);
});

export function openDiagnosticsWindow(): void {
  if (diagnosticsWindow && !diagnosticsWindow.isDestroyed()) {
    diagnosticsWindow.focus();
    return;
  }
  diagnosticsWindow = createDiagnosticsWindow();
  diagnosticsWindow.on('closed', () => {
    diagnosticsWindow = null;
  });
}

app.whenReady().then(() => {
  // Restore a realistic PATH BEFORE anything spawns tmux/br by bare name. A
  // Dock/Finder launch inherits launchd's minimal PATH (no Homebrew / ~/.local/bin),
  // so without this the terminal (tmux) and task detail pane (br) fail to find
  // their tools even though they are installed. See pathBootstrap.ts.
  bootstrapPath();
  setupSecurity();
  installApplicationMenu();
  getDb(); // open + migrate app-local store
  registerIpc(() => mainWindow, openDiagnosticsWindow);
  // Start the idle session reaper (the single periodic main-process timer). It
  // ages out unused remote sessions via SessionManager.close(); the off switch
  // and threshold live in settings (read each sweep).
  sessionReaper = startSessionReaper({ sessionManager, loadSettings, now: Date.now });
  mainWindow = createMainWindow();

  mainWindow.on('closed', () => {
    // Close diagnostics window when main window closes to avoid orphans.
    if (diagnosticsWindow && !diagnosticsWindow.isDestroyed()) {
      diagnosticsWindow.close();
    }
    mainWindow = null;
  });

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow();
    }
  });
});

// Quit only when the main window has closed (diagnostics window closing alone
// should not quit the app). On macOS the existing behavior is preserved: the
// app quits when the main window is gone (single-cockpit model).
app.on('window-all-closed', () => {
  // Only quit when there is no main window left.
  if (!mainWindow || mainWindow.isDestroyed()) {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Stop the reaper BEFORE closeAll so no sweep runs during teardown (FR7).
  sessionReaper?.stop();
  sessionReaper = null;
  void sessionManager.closeAll();
  closeDb();
});
