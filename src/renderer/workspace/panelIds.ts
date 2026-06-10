export const PanelIds = {
  terminal: 'terminal',
  content: 'content',
  changes: 'changes',
  beads: 'beads',
  taskDetail: 'taskDetail',
  run: 'run',
  notes: 'notes',
  explorer: 'explorer',
} as const;

export type PanelId = (typeof PanelIds)[keyof typeof PanelIds];

export const PANEL_TITLES: Record<PanelId, string> = {
  terminal: 'Terminal',
  content: 'Content',
  changes: 'Changes',
  beads: 'Workgraph',
  taskDetail: 'Task',
  run: 'Run',
  notes: 'Notes',
  explorer: 'Explorer',
};
