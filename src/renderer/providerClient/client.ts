import type { RendererApi } from '@shared/ipc/api';

/**
 * Typed accessor for the preload bridge. Panels and stores use `cockpit`
 * instead of touching `window.api` directly, keeping the IPC boundary in one
 * place and making it easy to swap for a fake in tests.
 */
export const agentCockpit: RendererApi = window.api;
