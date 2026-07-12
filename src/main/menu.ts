/**
 * Application menu — standard browser shortcuts. Without this, even
 * copy/paste don't work on macOS (no Edit menu = no key equivalents).
 */

import { app, Menu, MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  newTab(): void;
  closeTab(): void;
  reopenTab(): void;
  reload(): void;
  hardReload(): void;
  back(): void;
  forward(): void;
  home(): void;
  focusUrlBar(): void;
  find(): void;
  bookmarkToggle(): void;
  toggleBookmarksBar(): void;
  openInternal(page: string): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  nextTab(): void;
  prevTab(): void;
  selectTab(index: number): void;
  openSettings(): void;
  openProbe(): void;
  print(): void;
  clearBrowsingData(): void;
  toggleDevTools(): void;
}

export function installMenu(a: MenuActions): void {
  const tabSelects: MenuItemConstructorOptions[] = Array.from(
    { length: 9 },
    (_, i) => ({
      label: `Tab ${i + 1}`,
      accelerator: `Cmd+${i + 1}`,
      visible: false,
      acceleratorWorksWhenHidden: true,
      // Cmd+9 = last tab (browser convention), 1–8 = that index.
      click: () => a.selectTab(i === 8 ? -1 : i),
    }),
  );

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Color Settings…', accelerator: 'Cmd+,', click: a.openSettings },
        { type: 'separator' },
        {
          label: 'Clear Browsing Data…',
          click: a.clearBrowsingData,
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'Cmd+T', click: a.newTab },
        { label: 'Close Tab', accelerator: 'Cmd+W', click: a.closeTab },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'Cmd+Shift+T',
          click: a.reopenTab,
        },
        { type: 'separator' },
        { label: 'Open Location…', accelerator: 'Cmd+L', click: a.focusUrlBar },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'Cmd+P', click: a.print },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'Cmd+F', click: a.find },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Page', accelerator: 'Cmd+R', click: a.reload },
        {
          label: 'Reload Ignoring Cache',
          accelerator: 'Cmd+Shift+R',
          click: a.hardReload,
        },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'Cmd+0', click: a.zoomReset },
        { label: 'Zoom In', accelerator: 'Cmd+Plus', click: a.zoomIn },
        { label: 'Zoom Out', accelerator: 'Cmd+-', click: a.zoomOut },
        { type: 'separator' },
        { label: 'Pipeline Probe Page', click: a.openProbe },
        {
          label: 'Developer Tools',
          accelerator: 'Cmd+Alt+I',
          click: a.toggleDevTools,
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'Cmd+[', click: a.back },
        { label: 'Forward', accelerator: 'Cmd+]', click: a.forward },
        { label: 'Home', accelerator: 'Cmd+Shift+H', click: a.home },
        { type: 'separator' },
        {
          label: 'Show All History',
          accelerator: 'Cmd+Y',
          click: () => a.openInternal('history'),
        },
      ],
    },
    {
      label: 'Bookmarks',
      submenu: [
        {
          label: 'Bookmark This Page',
          accelerator: 'Cmd+D',
          click: a.bookmarkToggle,
        },
        {
          label: 'Toggle Bookmarks Bar',
          accelerator: 'Cmd+Shift+B',
          click: a.toggleBookmarksBar,
        },
        { type: 'separator' },
        {
          label: 'Show All Bookmarks',
          accelerator: 'Cmd+Alt+B',
          click: () => a.openInternal('bookmarks'),
        },
        {
          label: 'Downloads',
          accelerator: 'Cmd+Shift+J',
          click: () => a.openInternal('downloads'),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Next Tab',
          accelerator: 'Ctrl+Tab',
          click: a.nextTab,
        },
        {
          label: 'Previous Tab',
          accelerator: 'Ctrl+Shift+Tab',
          click: a.prevTab,
        },
        {
          label: 'Show Next Tab',
          accelerator: 'Cmd+Shift+]',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: a.nextTab,
        },
        {
          label: 'Show Previous Tab',
          accelerator: 'Cmd+Shift+[',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: a.prevTab,
        },
        ...tabSelects,
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
