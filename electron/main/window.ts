import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'];

export function createDiagnosticsWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    show: false,
    title: 'Diagnostics',
    backgroundColor: '#0e0f12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const levels = ['debug', 'info', 'warning', 'error'];
    const tag = levels[level] ?? 'log';
    console.log(`[diagnostics-renderer:${tag}] ${message} (${sourceId}:${line})`);
  });
  window.webContents.on('render-process-gone', (_e, details) => {
    console.error('[diagnostics-renderer:crash]', details);
  });

  if (DEV_SERVER_URL && process.env['AC_OPEN_DEVTOOLS'] === '1') {
    window.webContents.openDevTools({ mode: 'detach' });
  }

  window.webContents.on('will-navigate', (event, url) => {
    if (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)) return;
    event.preventDefault();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_SERVER_URL) {
    void window.loadURL(`${DEV_SERVER_URL}/diagnostics.html`);
  } else {
    void window.loadFile(join(__dirname, '../renderer/diagnostics.html'));
  }

  return window;
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Agent Cockpit',
    backgroundColor: '#0e0f12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const levels = ['debug', 'info', 'warning', 'error'];
    const tag = levels[level] ?? 'log';

    console.log(`[renderer:${tag}] ${message} (${sourceId}:${line})`);
  });
  window.webContents.on('render-process-gone', (_e, details) => {
     
    console.error('[renderer:crash]', details);
  });
  // Don't auto-open DevTools in dev — the app should start like a normal app.
  // Opt in by launching with AC_OPEN_DEVTOOLS=1; DevTools is still available
  // manually (View menu / ⌥⌘I) regardless.
  if (DEV_SERVER_URL && process.env['AC_OPEN_DEVTOOLS'] === '1') {
    window.webContents.openDevTools({ mode: 'detach' });
  }

  // Reject in-window navigation to anything other than the dev server / app file.
  window.webContents.on('will-navigate', (event, url) => {
    if (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)) return;
    event.preventDefault();
  });

  // Force window.open requests to the default browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}
