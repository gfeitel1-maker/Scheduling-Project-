// The application menu. See docs/superpowers/specs/2026-09-15-licensing-and-app-menu-design.md (C4).
//
// Shoresh currently sets NO application menu and inherits Electron's default —
// which is why `buildMenuTemplate` re-declares every standard role
// (undo/redo/cut/copy/paste/selectAll/minimize/close/quit) rather than only the
// new About/Licenses items. `Menu.setApplicationMenu()` REPLACES the default
// wholesale; a template missing a role silently destroys that shortcut, and it
// ships looking correct because the new item is what gets tested and paste is
// not. electron/menu.test.js pins every one of those roles so a future trim
// fails loudly.
//
// `buildMenuTemplate` takes no Electron import and is pure — it returns plain
// data. `installMenu` is the only place that touches the Electron `Menu` API,
// and it receives `Menu` as a parameter rather than importing 'electron'
// itself, so this whole module loads under Vitest without a live Electron
// runtime.
//
// The options object carries `isMac` and `onShowLicenses` per the spec,
// PLUS optional Help-menu callbacks (`onOpenGitHub`, `onReportIssue`) so Help
// stays free of any Electron `shell` reference — the caller (main.js) supplies
// those via `shell.openExternal`. Shaped so a future File-menu item (a queued
// share-to-archive feature) can be added without changing this signature; no
// such item is built here — see the standing no-coming-soon-controls rule.
export function buildMenuTemplate({ isMac, onShowLicenses, onOpenGitHub, onReportIssue } = {}) {
  const aboutItem = { label: 'About Shoresh', role: 'about' }
  const licensesItem = { label: 'Licenses', click: () => onShowLicenses?.() }

  const editMenu = {
    label: 'Edit',
    submenu: [
      { label: 'Undo', role: 'undo' },
      { label: 'Redo', role: 'redo' },
      { type: 'separator' },
      { label: 'Cut', role: 'cut' },
      { label: 'Copy', role: 'copy' },
      { label: 'Paste', role: 'paste' },
      { label: 'Select All', role: 'selectAll' },
    ],
  }

  const viewMenu = {
    label: 'View',
    submenu: [
      { label: 'Reload', role: 'reload' },
      { label: 'Toggle Developer Tools', role: 'toggleDevTools' },
      { type: 'separator' },
      { label: 'Zoom In', role: 'zoomIn' },
      { label: 'Zoom Out', role: 'zoomOut' },
      { label: 'Reset Zoom', role: 'resetZoom' },
      { type: 'separator' },
      { label: 'Toggle Full Screen', role: 'togglefullscreen' },
    ],
  }

  const windowMenu = {
    label: 'Window',
    submenu: [
      { label: 'Minimize', role: 'minimize' },
      { label: 'Zoom', role: 'zoom' },
      { type: 'separator' },
      { label: 'Close', role: 'close' },
    ],
  }

  const helpLinks = [
    { label: 'Shoresh on GitHub', click: () => onOpenGitHub?.() },
    { label: 'Report an Issue', click: () => onReportIssue?.() },
  ]

  if (isMac) {
    return [
      {
        label: 'Shoresh',
        submenu: [
          aboutItem,
          licensesItem,
          { type: 'separator' },
          { label: 'Services', role: 'services', submenu: [] },
          { type: 'separator' },
          { label: 'Hide Shoresh', role: 'hide' },
          { label: 'Hide Others', role: 'hideOthers' },
          { label: 'Show All', role: 'unhide' },
          { type: 'separator' },
          { label: 'Quit Shoresh', role: 'quit' },
        ],
      },
      editMenu,
      viewMenu,
      windowMenu,
      { label: 'Help', submenu: helpLinks },
    ]
  }

  return [
    { label: 'File', submenu: [{ label: 'Quit', role: 'quit' }] },
    editMenu,
    viewMenu,
    windowMenu,
    {
      label: 'Help',
      submenu: [aboutItem, licensesItem, { type: 'separator' }, ...helpLinks],
    },
  ]
}

/**
 * Thin Electron-touching wrapper. `Menu` is injected (not imported) so this
 * module never requires a live Electron runtime to load.
 */
export function installMenu({ Menu, isMac, onShowLicenses, onOpenGitHub, onReportIssue }) {
  const template = buildMenuTemplate({ isMac, onShowLicenses, onOpenGitHub, onReportIssue })
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  return menu
}
