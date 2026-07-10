import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { logger } from './logger';

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
      // Electron defaults spellcheck ON; on Windows/Linux Chromium then
      // downloads hunspell dictionaries from a Google CDN. A code cockpit has
      // no prose fields worth spellchecking — disable it so the app makes no
      // default-on external requests at all.
      spellcheck: false,
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
    // Route through the logger so a diagnostics-renderer crash lands in the
    // persisted on-disk log, not just the (Dock-launch-invisible) unified log.
    logger.error(
      `diagnostics renderer gone: reason=${details.reason} exitCode=${details.exitCode}`,
      'renderer',
    );
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
  // Theme the window chrome so the dark UI extends to the frame instead of
  // sitting under a system-grey title bar:
  // - macOS: `hiddenInset` hides the title bar and insets the traffic lights
  //   over the (themed) project-tab strip, which becomes the drag region.
  // - Windows: `hidden` + a themed `titleBarOverlay` keeps native caption
  //   controls but paints them to match the theme.
  // - Linux: keep the default frame — frameless there drops window controls
  //   across desktop environments, which is worse than a plain frame.
  // TITLE_BAR_HEIGHT must match the empty title strip rendered by the renderer
  // (src/renderer/shell/AppShell.tsx) so the OS window controls vertically center
  // within it.
  const TITLE_BAR_HEIGHT = 32;
  const chrome: Pick<
    Electron.BrowserWindowConstructorOptions,
    'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'
  > =
    process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          // Center the traffic lights within the 32px title strip.
          trafficLightPosition: { x: 19, y: 9 },
        }
      : process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden',
            titleBarOverlay: {
              color: '#11141a',
              symbolColor: '#e6e6e6',
              height: TITLE_BAR_HEIGHT,
            },
          }
        : {};

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Agent Cockpit',
    backgroundColor: '#0e0f12',
    ...chrome,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // See createDiagnosticsWindow: disable the default-on spellchecker so no
      // dictionary download (Win/Linux Google CDN) can ever fire.
      spellcheck: false,
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
    // Route through the logger so a main-renderer crash lands in the persisted
    // on-disk log, not just the (Dock-launch-invisible) unified log.
    logger.error(
      `main renderer gone: reason=${details.reason} exitCode=${details.exitCode}`,
      'renderer',
    );
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
