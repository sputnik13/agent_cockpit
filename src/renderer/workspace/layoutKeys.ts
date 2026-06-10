import type { PresetName } from './presets';

// Bump when the key format or preset structure changes so stale saved layouts
// don't mask the new defaults (old keys are simply ignored).
// v7: Sessions moved from a dock panel to a modal.
// v8: layout is keyed per project AND per view (Edit/Review).
export const LAYOUT_VERSION = 8;

/** localStorage key for a project's saved layout in a specific view. */
export const layoutKey = (projectId: string, view: PresetName): string =>
  `agent-cockpit:layout:v${LAYOUT_VERSION}:${projectId}:${view}`;

/** localStorage key for a project's last active view. */
export const activeViewKey = (projectId: string): string =>
  `agent-cockpit:view:${projectId}`;
