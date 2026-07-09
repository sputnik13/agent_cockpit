import { app, BrowserWindow, crashReporter, powerMonitor } from 'electron';
import { createMainWindow, createDiagnosticsWindow } from './window';
import { setupSecurity } from './security';
import { closeDb, getDb } from './store/sqlite';
import { registerIpc } from './ipc';
import { sessionManager } from './providers';
import { startSessionReaper, type SessionReaperHandle } from './providers/sessionReaper';
import { loadSettings } from './config';
import { installApplicationMenu } from './menu';
import { bootstrapPath } from './pathBootstrap';
import { logger } from './logger';
import { initLogFileSink } from './logFileSink';
import { join } from 'node:path';

// Start the native crash reporter as the FIRST thing at module load — before
// app.whenReady and before any significant work — so a native (non-JS)
// main-process fault is captured as a minidump. The v0.1.15 crash was an
// intentional V8/cppgc fatal abort (EXC_BREAKPOINT / brk 0) that no JS handler
// (uncaughtException et al.) can ever catch; crashReporter is the only seam that
// yields a dump for that class of fault. uploadToServer stays false — dumps are
// kept locally under app.getPath('crashDumps') and never sent anywhere. This is
// a DISTINCT seam from the whenReady PATH bootstrap; it must run at module load,
// while bootstrapPath() stays the first step INSIDE whenReady (see below).
crashReporter.start({ uploadToServer: false, compress: true });

let mainWindow: BrowserWindow | null = null;
let diagnosticsWindow: BrowserWindow | null = null;
let sessionReaper: SessionReaperHandle | null = null;

// Defense in depth: a late async emit (e.g. a node-pty chunk arriving during
// window teardown) must never take down the whole process. Route through the
// logger (so it lands in the persisted on-disk log, not just the invisible
// unified log on a Dock launch) in ADDITION to console for dev. Note: this
// CANNOT catch a native brk 0 — that limitation is inherent; crashReporter above
// covers the native case.
process.on('uncaughtException', (err) => {
  logger.error(`uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, 'main');
  console.error('[main:uncaughtException]', err);
});

// An unhandled promise rejection is the async twin of uncaughtException; persist
// it the same way so a rejected provider/IPC promise leaves a breadcrumb.
process.on('unhandledRejection', (reason) => {
  logger.error(
    `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    'main',
  );
  console.error('[main:unhandledRejection]', reason);
});

// A child process (GPU, utility, pty host, network service, …) dying is often
// the leading edge of a bigger failure and otherwise leaves no JS-visible trace.
// Persist it via the logger so the next crash timeline has the breadcrumb.
app.on('child-process-gone', (_e, details) => {
  logger.error(
    `child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`,
    'child-process',
  );
  console.error('[main:child-process-gone]', details);
});

// Resolve where the persisted log file lives. Prefer Electron's per-app 'logs'
// dir; fall back to userData/logs if 'logs' is somehow unavailable. Called only
// inside whenReady (app paths are ready by then).
function resolveLogsDir(): string {
  try {
    return app.getPath('logs');
  } catch {
    return join(app.getPath('userData'), 'logs');
  }
}

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
  // Start persisting the log to disk as early as possible (right after the PATH
  // bootstrap, before any other startup work) so everything from here survives a
  // crash. The sink flushes the current in-memory buffer first, so any entry
  // logged before this point is captured too. It does not spawn, so it does not
  // violate the "no spawn before bootstrapPath" invariant.
  initLogFileSink({ dir: resolveLogsDir() });
  // Log the resolved crash-dump directory once so the next native crash is
  // findable. crashReporter.start() ran at module load; this only reports where
  // its minidumps land.
  logger.info(`crash dumps: ${app.getPath('crashDumps')}`, 'crash');
  // Power-transition breadcrumbs. The v0.1.15 crash correlated with a sleep/wake
  // cycle after ~35h uptime; a persisted wake marker lets the next crash's
  // timeline be tested against the control-mode-reattach-after-wake hypothesis
  // (see CLAUDE.md "Control-mode reconnect is epoch-driven"). powerMonitor is
  // only valid after the app is ready, hence registered here in whenReady.
  powerMonitor.on('suspend', () => logger.info('system suspend', 'power'));
  powerMonitor.on('resume', () => logger.info('system resume', 'power'));
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
