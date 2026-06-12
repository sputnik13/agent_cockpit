import { app, Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * Builds and installs a custom application menu based on Electron's default
 * template, with the plain Reload (Cmd/Ctrl+R) accelerator removed.
 *
 * Force Reload (Cmd/Ctrl+Shift+R) is retained so developers can still hard-
 * reload the renderer when needed. All other default menu roles and items are
 * preserved unchanged.
 *
 * This is required so the renderer-side Cmd/Ctrl+R view-switch handler is not
 * pre-empted by the menu's reload action (FR9).
 */
export function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' },
            { type: 'separator' },
            {
              label: 'Speech',
              submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
            },
          ] as MenuItemConstructorOptions[])
        : ([
            { role: 'delete' },
            { type: 'separator' },
            { role: 'selectAll' },
          ] as MenuItemConstructorOptions[])),
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      // role:'reload' is intentionally omitted — Cmd/Ctrl+R is reserved for
      // the renderer's Review view-switch shortcut (FR9).
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac
        ? ([
            { type: 'separator' },
            { role: 'front' },
            { type: 'separator' },
            { role: 'window' },
          ] as MenuItemConstructorOptions[])
        : ([{ role: 'close' }] as MenuItemConstructorOptions[])),
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    editMenu,
    viewMenu,
    windowMenu,
    {
      role: 'help',
      submenu: [
        {
          label: 'Learn More',
          click: async () => {
            const { shell } = await import('electron');
            await shell.openExternal('https://electronjs.org');
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
