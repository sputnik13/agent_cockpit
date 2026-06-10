import type { ILinkHandler } from '@xterm/xterm';
import { openLinkTarget } from '../links/openLinkTarget';

/**
 * xterm `linkHandler` for OSC 8 hyperlinks. Without one, clicking an OSC 8 link
 * hits xterm's built-in default; this routes every activation through the shared
 * link router instead — web URLs to the OS browser (via window.open →
 * setWindowOpenHandler → shell.openExternal), local paths to the Explorer /
 * content panel (existence-validated). `allowNonHttpProtocols` lets `file://`
 * and bare-path links through to `activate`.
 *
 * `getProjectId` is read lazily at click time so the link always routes to the
 * project the terminal belongs to.
 */
export function createOscLinkHandler(getProjectId: () => string | null): ILinkHandler {
  return {
    allowNonHttpProtocols: true,
    activate: (_event, text) => {
      void openLinkTarget(text, { projectId: getProjectId() });
    },
  };
}
