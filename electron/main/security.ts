import { app, session } from 'electron';

const ALLOWED_PERMISSIONS = new Set<string>(['clipboard-read', 'clipboard-sanitized-write']);

const isDev = !!process.env['ELECTRON_RENDERER_URL'];

function buildCsp(): string {
  // The renderer is sandboxed at the process level; CSP is defense in depth.
  // Dev needs 'unsafe-inline' + 'unsafe-eval' for Vite/React HMR, plus the
  // dev server origin for connect-src / script-src.
  if (isDev) {
    return [
      "default-src 'self' http://localhost:* ws://localhost:*",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' ws://localhost:* http://localhost:*",
      "frame-src 'self' data: blob:",
    ].join('; ');
  }
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' (NOT 'unsafe-eval') permits WebAssembly instantiation —
    // required by the WASM-backed control-mode renderer (wterm's libghostty core,
    // added by the wterm migration). It is a narrow directive that allows only
    // WASM compilation, not arbitrary eval, so the sandboxed renderer's
    // defense-in-depth is preserved. The .wasm itself is a same-origin app asset
    // (default-src 'self'); no new origin is allowed.
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' data: blob:",
  ].join('; ');
}

export function setupSecurity(): void {
  // The dev CSP intentionally allows 'unsafe-eval'/'unsafe-inline' because Vite
  // HMR requires them; the production CSP (below) is strict ('self'). Electron's
  // insecure-CSP warning is therefore dev-only noise — suppress it in dev only.
  // It never fires in packaged builds, where the strict policy applies.
  if (isDev) {
    process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';
  }

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  const csp = buildCsp();
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}
