import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openLocalDb, getOrCreateDeviceId } from './db/localDb.js'
import { createUser, verifyPin, issueSessionToken, verifySessionToken } from './auth/localAuth.js'
import { startSyncServer } from './sync/syncServer.js'
import { createSyncClient } from './sync/syncClient.js'
import { advertiseHost, discoverHosts } from './sync/discovery.js'

const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_LOCKOUT_MS = 30_000
const loginAttempts = new Map()

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
  let modeChosen = false
  let mode = null
  let pendingServerUrl = null

  function wireOpApplied() {
    syncClient.onOpApplied((op) => {
      const mainWindow = getMainWindow ? getMainWindow() : null
      if (mainWindow) mainWindow.webContents.send('shoresh:op-applied', op)
    })
  }

  function chooseMode(args) {
    if (modeChosen) {
      throw new Error('mode already chosen for this session')
    }

    const { mode: requestedMode, campName, port } = args || {}
    if (requestedMode !== 'host' && requestedMode !== 'client') {
      throw new Error('mode must be "host" or "client"')
    }

    if (requestedMode === 'host') {
      startSyncServer(db, { port })
      advertiseHost({ campName, port })
      syncClient = createSyncClient(db, { device_id: deviceId, author_user_id: null })
      wireOpApplied()
    } else {
      pendingServerUrl = resolveClientServerUrl(args)
    }

    mode = requestedMode
    modeChosen = true

    return { mode: requestedMode }
  }

  function discoverHostsHandler() {
    return discoverHosts({ timeoutMs: 3000 })
  }

  function login({ name, pin } = {}) {
    if (!isNonEmptyString(name) || !isNonEmptyString(pin)) {
      throw new Error('name and pin are required')
    }

    const attempt = loginAttempts.get(name)
    if (attempt && attempt.lockedUntil && attempt.lockedUntil > Date.now()) {
      return null
    }

    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return null
    const user = db.prepare('SELECT id, role FROM users WHERE camp_id = ? AND name = ?').get(camp.id, name)
    if (!user || !verifyPin(db, user.id, pin)) {
      const current = loginAttempts.get(name) || { count: 0, lockedUntil: 0 }
      current.count += 1
      if (current.count >= LOGIN_MAX_ATTEMPTS) {
        current.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS
        current.count = 0
      }
      loginAttempts.set(name, current)
      return null
    }

    loginAttempts.delete(name)

    const token = issueSessionToken(user.id, deviceId)

    if (mode === 'client' && pendingServerUrl && !syncClient) {
      syncClient = createSyncClient(db, {
        device_id: deviceId,
        author_user_id: null,
        serverUrl: pendingServerUrl,
        token,
      })
      wireOpApplied()
    }

    return { token, userId: user.id, role: user.role }
  }

  function createUserHandler({ token, camp_id, name, pin, role } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = verifySessionToken(token)
    if (!session) throw new Error('invalid session')
    const sessionUser = db.prepare('SELECT role FROM users WHERE id = ?').get(session.userId)
    if (!sessionUser || sessionUser.role !== 'admin') {
      throw new Error('admin role required')
    }
    if (!isNonEmptyString(camp_id)) throw new Error('camp_id is required')
    if (!isNonEmptyString(name)) throw new Error('name is required')
    if (!isNonEmptyString(pin)) throw new Error('pin is required')
    if (role !== 'admin' && role !== 'staff') throw new Error('role must be "admin" or "staff"')
    return createUser(db, { camp_id, name, pin, role })
  }

  function bootstrapCamp({ campName, adminName, adminPin } = {}) {
    if (!isNonEmptyString(campName)) throw new Error('campName is required')
    if (!isNonEmptyString(adminName)) throw new Error('adminName is required')
    if (!isNonEmptyString(adminPin)) throw new Error('adminPin is required')

    const { n } = db.prepare('SELECT COUNT(*) as n FROM camps').get()
    if (n !== 0) {
      throw new Error('camp already exists')
    }

    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, campName)
    const user = createUser(db, { camp_id: campId, name: adminName, pin: adminPin, role: 'admin' })

    return { campId, userId: user.id }
  }

  function write({ token, ...writeArgs } = {}) {
    if (!isNonEmptyString(token)) {
      throw new Error('token is required')
    }
    const session = verifySessionToken(token)
    if (!session) {
      throw new Error('invalid session')
    }
    if (!syncClient) {
      throw new Error('sync not initialized — choose a mode first')
    }
    return syncClient.write({ ...writeArgs, author_user_id: session.userId })
  }

  return {
    chooseMode,
    discoverHosts: discoverHostsHandler,
    login,
    createUser: createUserHandler,
    bootstrapCamp,
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
  ipcMain.handle('shoresh:bootstrap-camp', (_event, args) => handlers.bootstrapCamp(args))
  ipcMain.handle('shoresh:write', (_event, args) => handlers.write(args))
  ipcMain.handle('shoresh:get-camp', () => db.prepare('SELECT * FROM camps LIMIT 1').get())

  app.whenReady().then(createWindow)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
