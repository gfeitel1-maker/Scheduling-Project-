import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { openLocalDb, getOrCreateDeviceId } from './db/localDb.js'
import { createUser, verifyPin, issueSessionToken, verifySessionToken } from './auth/localAuth.js'
import { startSyncServer } from './sync/syncServer.js'
import { createSyncClient } from './sync/syncClient.js'
import { advertiseHost, discoverHosts } from './sync/discovery.js'

const HOST_PATTERN = /^[a-zA-Z0-9.\-:]+$/

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

function ensureDeviceRow(db, deviceId) {
  db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(deviceId, os.hostname())
}

function resolveClientServerUrl({ hostAddress, host, port }) {
  if (isNonEmptyString(hostAddress)) return hostAddress
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid port for host connection')
  }
  if (!isNonEmptyString(host) || !HOST_PATTERN.test(host)) {
    throw new Error('Invalid host for host connection')
  }
  return `ws://${host}:${port}`
}

export function makeHandlers(db, deviceId, { getMainWindow } = {}) {
  ensureDeviceRow(db, deviceId)

  let syncClient = null

  function chooseMode(args) {
    const { mode, campName, port } = args || {}
    if (mode !== 'host' && mode !== 'client') {
      throw new Error('mode must be "host" or "client"')
    }

    if (mode === 'host') {
      startSyncServer(db, { port })
      advertiseHost({ campName, port })
      syncClient = createSyncClient(db, { device_id: deviceId, author_user_id: null })
    } else {
      const serverUrl = resolveClientServerUrl(args)
      syncClient = createSyncClient(db, {
        device_id: deviceId,
        author_user_id: null,
        serverUrl,
      })
    }

    syncClient.onOpApplied((op) => {
      const mainWindow = getMainWindow ? getMainWindow() : null
      if (mainWindow) mainWindow.webContents.send('shoresh:op-applied', op)
    })

    return { mode }
  }

  function discoverHostsHandler() {
    return discoverHosts({ timeoutMs: 3000 })
  }

  function login({ name, pin } = {}) {
    if (!isNonEmptyString(name) || !isNonEmptyString(pin)) {
      throw new Error('name and pin are required')
    }
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return null
    const user = db.prepare('SELECT id, role FROM users WHERE camp_id = ? AND name = ?').get(camp.id, name)
    if (!user || !verifyPin(db, user.id, pin)) return null
    const token = issueSessionToken(user.id, deviceId)
    return { token, userId: user.id, role: user.role }
  }

  function createUserHandler({ camp_id, name, pin, role } = {}) {
    if (!isNonEmptyString(camp_id)) throw new Error('camp_id is required')
    if (!isNonEmptyString(name)) throw new Error('name is required')
    if (!isNonEmptyString(pin)) throw new Error('pin is required')
    if (role !== 'admin' && role !== 'staff') throw new Error('role must be "admin" or "staff"')
    return createUser(db, { camp_id, name, pin, role })
  }

  function write({ token, ...writeArgs } = {}) {
    if (!isNonEmptyString(token)) {
      throw new Error('token is required')
    }
    const session = verifySessionToken(token)
    if (!session) {
      throw new Error('invalid session')
    }
    return syncClient.write({ ...writeArgs, author_user_id: session.userId })
  }

  return {
    chooseMode,
    discoverHosts: discoverHostsHandler,
    login,
    createUser: createUserHandler,
    write,
    getSyncClient: () => syncClient,
  }
}

function isElectronEntryPoint() {
  return !process.env.VITEST && typeof app !== 'undefined' && app && typeof app.whenReady === 'function'
}

if (isElectronEntryPoint()) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const dbPath = path.join(app.getPath('userData'), 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  const deviceId = getOrCreateDeviceId(db)

  let mainWindow = null

  const handlers = makeHandlers(db, deviceId, { getMainWindow: () => mainWindow })

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
      },
    })
    const devServerUrl = process.env.VITE_DEV_SERVER_URL
    if (devServerUrl) {
      mainWindow.loadURL(devServerUrl)
    } else {
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
    }
  }

  ipcMain.handle('shoresh:choose-mode', (_event, args) => handlers.chooseMode(args))
  ipcMain.handle('shoresh:discover-hosts', () => handlers.discoverHosts())
  ipcMain.handle('shoresh:login', (_event, args) => handlers.login(args))
  ipcMain.handle('shoresh:create-user', (_event, args) => handlers.createUser(args))
  ipcMain.handle('shoresh:write', (_event, args) => handlers.write(args))
  ipcMain.handle('shoresh:get-camp', () => db.prepare('SELECT * FROM camps LIMIT 1').get())

  app.whenReady().then(createWindow)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
