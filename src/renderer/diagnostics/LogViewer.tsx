/**
 * LogViewer: re-exports the presentational LogViewerBody for use in the
 * dedicated diagnostics pop-out window. The in-app Dialog modal has been
 * removed; the ⬡ button and Cmd/Ctrl+Shift+L now open an OS BrowserWindow.
 */
export { LogViewerBody } from './LogViewerBody';
export { LogRow } from './LogViewerBody';
