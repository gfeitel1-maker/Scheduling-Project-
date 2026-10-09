// A no-op stand-in for the `electron` module, for a plain-node script that needs
// electron/main.js's REAL handlers without an Electron process.
//
// T251. scripts/fixtures/electiveAcceptanceCamp.mjs is the only caller; see its
// header for why a script needs makeHandlers at all.
//
// This is the SAME surface every T251 vitest file already declares in its
// `vi.mock('electron', ...)` — nothing here is new behaviour, only the same
// stub in a form a `node` process can resolve. Every member is inert: the
// fixture never opens a window, never registers an IPC channel, and never
// crosses the contextBridge.
const noop = () => {}
// `exit`/`quit` are no-ops rather than real exits, and that is the same
// behaviour the vitest files get from their own `vi.fn()` mock: importing
// electron/main.js runs its top-level startup, that startup cannot complete
// without a real Electron runtime, and it reports the failure through
// app.exit(). The failure is expected and inert — `makeHandlers` is a pure
// export and does not depend on the startup having run.
export const app = {
  getPath: () => process.env.TMPDIR || '/tmp',
  whenReady: () => Promise.resolve(),
  on: noop,
  exit: noop,
  quit: noop,
  isReady: () => true,
  setName: noop,
  setAboutPanelOptions: noop,
  setPath: noop,
  getName: () => 'shoresh-dev',
  getVersion: () => '0.0.0-fixture',
  requestSingleInstanceLock: () => true,
}
export const BrowserWindow = function BrowserWindow() {}
export const ipcMain = { handle: noop, on: noop, removeHandler: noop }
export const contextBridge = { exposeInMainWorld: noop }
export const ipcRenderer = { invoke: () => Promise.resolve(), on: noop }
export const dialog = { showOpenDialog: () => Promise.resolve({ canceled: true }), showSaveDialog: () => Promise.resolve({ canceled: true }) }
export const shell = { openPath: () => Promise.resolve(''), openExternal: () => Promise.resolve() }
// `isEncryptionAvailable() === false` is the honest answer for a process with
// no Electron keychain, and it is also the SAFE one: electron/db/atRestEncryption.js
// treats an unavailable safeStorage as "not encrypted", which is what this
// database genuinely is.
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('safeStorage is unavailable outside Electron') },
  decryptString: () => { throw new Error('safeStorage is unavailable outside Electron') },
}
export const Menu = { setApplicationMenu: noop, buildFromTemplate: () => ({}) }
export const powerMonitor = { on: noop }
export default { app, BrowserWindow, ipcMain, contextBridge, ipcRenderer, dialog, shell, safeStorage, Menu, powerMonitor }
