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
import { listPendingConflicts } from './ops/operations.js'

const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_LOCKOUT_MS = 30_000

const HOST_PATTERN = /^[a-zA-Z0-9.\-:]+$/

// Fields whose raw op.value must never cross the IPC boundary into the
// renderer — this is the actual security boundary. The renderer's own
// sanitizeSide (usePendingConflicts.js) is defense-in-depth only; by the
// time it runs, an unfiltered value would already be sitting in the
// renderer's JS heap as the IPC event argument, readable by any
// renderer-side code (devtools, extensions, a compromised dependency).
const IPC_PIN_FIELDS = new Set(['pin_hash', 'pin_salt'])

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

function sanitizeOpForIpc(op) {
  if (!op) return op
  if (op.entity === 'users' && IPC_PIN_FIELDS.has(op.field)) {
    const { value, ...rest } = op
    return rest
  }
  return op
}

// Strips PIN values from an op_conflict message BEFORE it is ever handed to
// webContents.send. This must run in the main process — sanitizing only in
// the renderer (as a pure defense-in-depth measure) is too late, since the
// raw scrypt digest + salt would already have landed in the renderer's heap
// as the IPC event argument by the time renderer code runs.
export function sanitizeConflictForIpc(msg) {
  if (!msg) return msg
  return {
    ...msg,
    incomingOp: sanitizeOpForIpc(msg.incomingOp),
    existingOp: sanitizeOpForIpc(msg.existingOp),
  }
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

  function attemptsRow(name) {
    return db.prepare('SELECT name, count, locked_until FROM login_attempts WHERE name = ?').get(name)
  }

  function saveAttempts(name, count, lockedUntil) {
    db.prepare(
      'INSERT OR REPLACE INTO login_attempts (name, count, locked_until) VALUES (?, ?, ?)'
    ).run(name, count, lockedUntil != null ? String(lockedUntil) : null)
  }

  function clearAttempts(name) {
    db.prepare('DELETE FROM login_attempts WHERE name = ?').run(name)
  }

  function wireOpApplied() {
    syncClient.onOpApplied((op) => {
      const mainWindow = getMainWindow ? getMainWindow() : null
      if (mainWindow) mainWindow.webContents.send('shoresh:op-applied', sanitizeOpForIpc(op))
    })
    if (typeof syncClient.onOpConflict === 'function') {
      syncClient.onOpConflict((msg) => {
        const mainWindow = getMainWindow ? getMainWindow() : null
        if (mainWindow) mainWindow.webContents.send('shoresh:op-conflict', sanitizeConflictForIpc(msg))
      })
    }
  }

  function chooseMode(args) {
    const { mode: requestedMode, campName, port } = args || {}
    if (requestedMode !== 'host' && requestedMode !== 'client') {
      throw new Error('mode must be "host" or "client"')
    }

    if (modeChosen) {
      if (requestedMode === mode) {
        // Same mode replayed (e.g. a renderer reload after mode was already
        // chosen this process lifetime) — syncClient/server are already
        // running, so this is a safe no-op rather than an error.
        return { mode }
      }
      throw new Error('mode already chosen for this session')
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

    const attempt = attemptsRow(name)
    const lockedUntil = attempt && attempt.locked_until ? Number(attempt.locked_until) : 0
    if (lockedUntil && lockedUntil > Date.now()) {
      return { locked: true, retryAfterMs: lockedUntil - Date.now() }
    }

    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return null
    const user = db.prepare('SELECT id, role FROM users WHERE camp_id = ? AND name = ?').get(camp.id, name)
    if (!user || !verifyPin(db, user.id, pin)) {
      let count = (attempt ? attempt.count : 0) + 1
      let newLockedUntil = null
      if (count >= LOGIN_MAX_ATTEMPTS) {
        newLockedUntil = Date.now() + LOGIN_LOCKOUT_MS
        count = 0
      }
      saveAttempts(name, count, newLockedUntil)
      return null
    }

    clearAttempts(name)

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

  async function createUserHandler({ token, camp_id, name, pin, role } = {}) {
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
    if (!syncClient) {
      throw new Error('sync not initialized — choose a mode first')
    }
    return createUser(db, { camp_id, name, pin, role }, (args) => syncClient.write(args))
  }

  async function bootstrapCamp({ campName, adminName, adminPin } = {}) {
    if (!isNonEmptyString(campName)) throw new Error('campName is required')
    if (!isNonEmptyString(adminName)) throw new Error('adminName is required')
    if (!isNonEmptyString(adminPin)) throw new Error('adminPin is required')

    const { n } = db.prepare('SELECT COUNT(*) as n FROM camps').get()
    if (n !== 0) {
      throw new Error('camp already exists')
    }
    if (!syncClient) {
      throw new Error('sync not initialized — choose a mode first')
    }

    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, campName)
    const user = await createUser(
      db,
      { camp_id: campId, name: adminName, pin: adminPin, role: 'admin' },
      (args) => syncClient.write(args)
    )

    return { campId, userId: user.id }
  }

  function verifySession({ token } = {}) {
    const session = verifySessionToken(token)
    if (!session) return { valid: false }
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(session.userId)
    if (!user) return { valid: false }
    return { valid: true, userId: user.id, role: user.role }
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

  // Resolves a conflict by re-writing the CHOSEN op's value, looked up
  // server-side by op id. The renderer only ever passes an op id — never a
  // value — so a PIN conflict's raw hash never has to cross the IPC
  // boundary into the renderer to be "kept." Works identically for
  // non-sensitive fields too, so there's a single resolution path.
  function resolveConflict({ token, entity, entity_id, field, chosen_op_id, parent_op_id } = {}) {
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
    if (!isNonEmptyString(chosen_op_id)) {
      throw new Error('chosen_op_id is required')
    }
    const chosenOp = db
      .prepare('SELECT value FROM operations WHERE id = ? AND entity = ? AND entity_id = ? AND field = ?')
      .get(chosen_op_id, entity, entity_id, field)
    if (!chosenOp) {
      throw new Error('chosen operation not found')
    }
    return syncClient.write({
      entity,
      entity_id,
      field,
      value: chosenOp.value,
      parent_op_id: parent_op_id ?? null,
      author_user_id: session.userId,
    })
  }

  // Never selects pin_hash/pin_salt — this is consumed by UI layers (e.g. the
  // conflicts screen's author-label resolution) that must never receive raw
  // PIN material, even as an unused/unrendered field.
  function listUsers() {
    return db.prepare('SELECT id, name, role FROM users').all()
  }

  function getDeviceId() {
    return deviceId
  }

  // Rehydration query for the Conflicts screen: reconstructs the unresolved
  // set from the durable `conflicts` table (see operations.js) rather than
  // relying on the live op-conflict broadcast, so a conflict that was
  // pending before an app restart is still shown afterward. Sanitized the
  // same way the live broadcast is — this is an IPC send path just like
  // wireOpApplied's, so raw PIN values must never cross it either.
  function listPendingConflictsHandler() {
    return listPendingConflicts(db).map(sanitizeConflictForIpc)
  }

  return {
    chooseMode,
    discoverHosts: discoverHostsHandler,
    login,
    createUser: createUserHandler,
    bootstrapCamp,
    write,
    verifySession,
    listUsers,
    getDeviceId,
    resolveConflict,
    listPendingConflicts: listPendingConflictsHandler,
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
  ipcMain.handle('shoresh:verify-session', (_event, args) => handlers.verifySession(args))
  ipcMain.handle('shoresh:get-camp', () => db.prepare('SELECT * FROM camps LIMIT 1').get())
  ipcMain.handle('shoresh:list-users', () => handlers.listUsers())
  ipcMain.handle('shoresh:get-device-id', () => handlers.getDeviceId())
  ipcMain.handle('shoresh:resolve-conflict', (_event, args) => handlers.resolveConflict(args))
  ipcMain.handle('shoresh:list-conflicts', () => handlers.listPendingConflicts())

  app.whenReady().then(createWindow)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
