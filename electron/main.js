import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openLocalDb, getOrCreateDeviceId } from './db/localDb.js'
import { createUser, issueSessionToken, verifySessionToken, attemptLogin } from './auth/localAuth.js'
import { startSyncServer } from './sync/syncServer.js'
import { createSyncClient } from './sync/syncClient.js'
import { advertiseHost, discoverHosts } from './sync/discovery.js'
import { listPendingConflicts } from './ops/operations.js'

const HOST_PATTERN = /^[a-zA-Z0-9.\-:]+$/

// Fields whose raw op.value must never cross the IPC boundary into the
// renderer — this is the actual security boundary. The renderer's own
// sanitizeSide (usePendingConflicts.js) is defense-in-depth only; by the
// time it runs, an unfiltered value would already be sitting in the
// renderer's JS heap as the IPC event argument, readable by any
// renderer-side code (devtools, extensions, a compromised dependency).
const IPC_PIN_FIELDS = new Set(['pin_hash', 'pin_salt'])

// Bound on how long login() waits for an in-flight WebSocket handshake to
// finish before falling back to the local/offline login path. Meaningfully
// shorter than loginRemote's own timeout for a genuinely unreachable host —
// this window exists only to absorb the sub-second CONNECTING-state race on
// a healthy LAN connection, not to wait out a dead one.
const CLIENT_CONNECT_WAIT_MS = 1500

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
      syncClient = createSyncClient(db, {
        device_id: deviceId,
        author_user_id: null,
        serverUrl: pendingServerUrl,
      })
      wireOpApplied()
    }

    mode = requestedMode
    modeChosen = true

    return { mode: requestedMode }
  }

  function discoverHostsHandler() {
    return discoverHosts({ timeoutMs: 3000 })
  }

  async function login({ name, pin } = {}) {
    if (!isNonEmptyString(name) || !isNonEmptyString(pin)) {
      throw new Error('name and pin are required')
    }

    if (mode === 'client' && syncClient) {
      // A connect() attempt may still be in the WebSocket CONNECTING state when
      // the user submits credentials (e.g. "enter host, hit connect, immediately
      // type PIN" is the natural flow). loginRemote()'s readyState guard returns
      // 'disconnected' SYNCHRONOUSLY if the socket isn't OPEN yet, which would
      // falsely tell a fresh device to "connect to the network" moments before
      // the handshake would have completed. Give the handshake a short, bounded
      // window to finish first — a LAN WebSocket handshake normally completes in
      // tens of milliseconds, so this comfortably covers that case while staying
      // far shorter than loginRemote's own timeout for a genuinely unreachable
      // host (so an unreachable Host still falls through to the offline/local
      // path promptly, just not instantly).
      await Promise.race([
        syncClient.waitUntilConnected(),
        new Promise((resolve) => setTimeout(resolve, CLIENT_CONNECT_WAIT_MS)),
      ])

      const remoteResult = await syncClient.loginRemote({ name, pin })
      if (remoteResult.status === 'ok') {
        return { token: remoteResult.token, userId: remoteResult.userId, role: remoteResult.role }
      }
      if (remoteResult.status === 'failed') {
        return remoteResult.locked ? { locked: true, retryAfterMs: remoteResult.retryAfterMs } : null
      }
      // 'disconnected' or 'timeout': fall through to local verification below,
      // which only succeeds for a device that has already synced once before.
      // A genuinely fresh, offline device gets a clear, distinct signal
      // rather than the generic invalid-credentials response.
      const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      if (!camp) {
        return { offline: true, reason: 'Connect to the camp network to sign in for the first time.' }
      }
    }

    return attemptLogin(db, { name, pin, deviceId })
  }

  async function createUserHandler({ token, camp_id, name, pin, role } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = verifySessionToken(db, token)
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
    const signingSecret = randomBytes(32).toString('hex')
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, campName, signingSecret)
    const user = await createUser(
      db,
      { camp_id: campId, name: adminName, pin: adminPin, role: 'admin' },
      (args) => syncClient.write(args)
    )

    return { campId, userId: user.id }
  }

  function verifySession({ token } = {}) {
    const session = verifySessionToken(db, token)
    if (!session) return { valid: false }
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(session.userId)
    if (!user) return { valid: false }
    return { valid: true, userId: user.id, role: user.role }
  }

  function write({ token, ...writeArgs } = {}) {
    if (!isNonEmptyString(token)) {
      throw new Error('token is required')
    }
    const session = verifySessionToken(db, token)
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
    const session = verifySessionToken(db, token)
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
    mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error('PRELOAD ERROR', preloadPath, error)
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
