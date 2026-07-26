import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { randomUUID, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openLocalDb, getOrCreateDeviceId, CURRENT_SCHEMA_VERSION, getSchemaVersion } from './db/localDb.js'
import { createUser, verifySessionToken, attemptLogin, ensureHostSigningKey } from './auth/localAuth.js'
import { startSyncServer } from './sync/syncServer.js'
import { createSyncClient } from './sync/syncClient.js'
import { advertiseHost, discoverHosts } from './sync/discovery.js'
import { listPendingConflicts } from './ops/operations.js'
import { authorize } from './auth/authorize.js'
import { deriveWriteAction, deriveBulkReplaceAction } from './auth/deriveWriteAction.js'
import { recordAuditEvent } from './audit/auditLog.js'
import {
  getCurrentProjectPath,
  setCurrentProjectPath,
  readRecentProjects,
  addRecentProject,
  writeUserBackup,
  rotatePreResolveBackups,
} from './db/projectManager.js'

const HOST_PATTERN = /^[a-zA-Z0-9.\-:]+$/

// Fields whose raw op.value must never cross the IPC boundary into the
// renderer — this is the actual security boundary. The renderer's own
// sanitizeSide (usePendingConflicts.js) is defense-in-depth only; by the
// time it runs, an unfiltered value would already be sitting in the
// renderer's JS heap as the IPC event argument, readable by any
// renderer-side code (devtools, extensions, a compromised dependency).
const IPC_PIN_FIELDS = new Set(['pin_hash', 'pin_salt'])

// Fixed allowlist for `shoresh:list` — mirrors how ops/projections.js's
// PROJECTIONS registry validates writable entities before ever touching the
// db. `entity` is validated against this map by exact key lookup (never
// regex/prefix match, never string-built into a query) before any SQL runs;
// anything not listed here is rejected, not silently queried.
//
// `template_slots` is deliberately in the parent-scoped group, not the
// direct-camp_id group: per schema.sql it has only `template_id` (no
// `camp_id` column at all), same as template_overlays/schedule_snapshots/
// day_override_template_slots. It is scoped via JOIN through
// schedule_templates, exactly like those three.
const DIRECT_CAMP_ENTITIES = new Set([
  'groups',
  'tiers',
  'activities',
  'cohorts',
  'days_of_operation',
  'time_blocks',
  'anchor_activities',
  'schedule_templates',
  'day_override_templates',
])

const PARENT_SCOPED_ENTITIES = {
  template_slots: {
    table: 'template_slots',
    parentTable: 'schedule_templates',
    parentKey: 'template_id',
  },
  template_overlays: {
    table: 'template_overlays',
    parentTable: 'schedule_templates',
    parentKey: 'template_id',
  },
  schedule_snapshots: {
    table: 'schedule_snapshots',
    parentTable: 'schedule_templates',
    parentKey: 'template_id',
  },
  day_override_template_slots: {
    table: 'day_override_template_slots',
    parentTable: 'day_override_templates',
    parentKey: 'day_override_template_id',
  },
}

// Bound on how long login() waits for an in-flight WebSocket handshake to
// finish before falling back to the local/offline login path. Meaningfully
// shorter than loginRemote's own timeout for a genuinely unreachable host —
// this window exists only to absorb the sub-second CONNECTING-state race on
// a healthy LAN connection, not to wait out a dead one.
const CLIENT_CONNECT_WAIT_MS = 1500

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

// Thin wrapper around authorize() (electron/auth/authorize.js) that converts
// its { allowed: false, reason } result into the same thrown-Error convention
// every handler in this file already uses. `reason: 'forbidden'` is mapped to
// 'admin role required' because every action currently routed through this
// helper that a staff caller can be denied is, in fact, admin-only in the
// permission matrix (electron/auth/permissions.js) — matching the exact
// error string the pre-authorize() inline checks already threw. Any other
// denial reason (invalid/malformed token, user or device no longer existing,
// a db error) collapses to 'invalid session', matching the existing
// verifySessionToken-failure message. Callers must check
// isNonEmptyString(token) themselves first if they need the more specific
// 'token is required' message for a missing token.
function requireAuthorized(db, { token, action, resourceId }) {
  const result = authorize({ db, token, action, resourceId })
  if (!result.allowed) {
    if (result.reason === 'forbidden') {
      throw new Error('admin role required')
    }
    throw new Error('invalid session')
  }
  return result
}

function sanitizeOpForIpc(op) {
  if (!op) return op
  if (op.entity === 'users' && IPC_PIN_FIELDS.has(op.field)) {
    const { value: _value, ...rest } = op
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

export function makeHandlers(db, deviceId, { getMainWindow, dbPath, userDataPath: _userDataPath } = {}) {
  // Alias to avoid shadowing the import; callers pass userDataPath as an option
  // so backups from within makeHandlers (bulkReplace) land in the same
  // {userData}/backups/ directory as user-initiated backups.
  const handlersUserDataPath = _userDataPath
  ensureDeviceRow(db, deviceId)

  let syncClient = null
  let syncServer = null  // { wss, close, sendPairingApproved, sendPairingDenied }
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

  function wirePairingCallbacks() {
    if (typeof syncClient.onPairingApproved === 'function') {
      syncClient.onPairingApproved(() => {
        const w = getMainWindow ? getMainWindow() : null
        if (w) w.webContents.send('shoresh:pairing-approved')
      })
    }
    if (typeof syncClient.onPairingDenied === 'function') {
      syncClient.onPairingDenied(() => {
        const w = getMainWindow ? getMainWindow() : null
        if (w) w.webContents.send('shoresh:pairing-denied')
      })
    }
    if (typeof syncClient.onTokenRenewed === 'function') {
      syncClient.onTokenRenewed((newToken) => {
        const w = getMainWindow ? getMainWindow() : null
        if (w) w.webContents.send('shoresh:token-renewed', { token: newToken })
      })
    }
  }

  // Deliberately NOT wrapped in authorize(). `args` here is
  // { mode, campName, port, host, hostAddress } — there has never been a
  // `token` field in this handler's signature, and `src/hooks/useDeviceMode.js`
  // calls chooseMode() as part of its pre-login init effect (before
  // verifySession is even attempted), and again from selectJoinHost()/
  // bootstrapCamp() on the Join/Bootstrap screens, all of which render before
  // `phase === 'session'`. There is no session to derive a role from at this
  // point in the flow — same category as login/verify-session, per the ADR's
  // open question, resolved here by reading the actual call sites rather than
  // guessing.
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
      syncServer = startSyncServer(db, {
        port,
        onPairingRequest: (deviceId_req, deviceName_req) => {
          const mainWindow = getMainWindow ? getMainWindow() : null
          if (mainWindow) mainWindow.webContents.send('shoresh:pairing-request', { deviceId: deviceId_req, deviceName: deviceName_req })
        },
      })
      advertiseHost({ campName, port })
      syncClient = createSyncClient(db, { device_id: deviceId, author_user_id: null })
      wireOpApplied()
    } else {
      pendingServerUrl = resolveClientServerUrl(args)
      const deviceRow = db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId)
      const deviceNameForPairing = deviceRow?.name || `Device ${deviceId.slice(0, 8)}`
      syncClient = createSyncClient(db, {
        device_id: deviceId,
        author_user_id: null,
        serverUrl: pendingServerUrl,
        device_name: deviceNameForPairing,
      })
      wireOpApplied()
      wirePairingCallbacks()
    }

    mode = requestedMode
    modeChosen = true

    return { mode: requestedMode }
  }

  // Deliberately NOT wrapped in authorize(). Takes zero arguments (see
  // preload.js: `discoverHosts: () => ipcRenderer.invoke('shoresh:discover-hosts')`)
  // and is called from the Join screen's mDNS host-picker before a mode is
  // even chosen, let alone a session established — there is no token to pass
  // in at this point in the flow, by construction of the handler's own
  // signature.
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
    // Routes the existing admin-only gate through authorize() — action
    // 'users.create' per docs/adr/2026-07-24-centralized-authorization-layer.md.
    // No behavior change: still admin-only, still throws 'admin role required'.
    requireAuthorized(db, { token, action: 'users.create' })
    if (!isNonEmptyString(camp_id)) throw new Error('camp_id is required')
    if (!isNonEmptyString(name)) throw new Error('name is required')
    if (!isNonEmptyString(pin)) throw new Error('pin is required')
    if (role !== 'admin' && role !== 'staff') throw new Error('role must be "admin" or "staff"')
    if (!syncClient) {
      throw new Error('sync not initialized — choose a mode first')
    }
    return createUser(db, { camp_id, name, pin, role }, (args) => syncClient.write(args))
  }

  // Deliberately NOT wrapped in authorize(). Signature is
  // { campName, adminName, adminPin } — no token. Ground truth from reading
  // the body below: it only proceeds when `SELECT COUNT(*) FROM camps` is 0,
  // i.e. no camp, no users table row, and therefore no session token that
  // could possibly exist yet — this call creates the very first admin user.
  // authorize() re-queries `users`/`devices` by the session's ids, which
  // can't be satisfied before those rows exist; requiring a token here would
  // make bootstrap uncallable. Same category as login/verify-session.
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

    // Host Ed25519 keypair, generated exactly once per
    // docs/adr/2026-07-25-device-trust-revocation.md — this device becomes
    // the Host by virtue of running bootstrapCamp() (the device that creates
    // the very first admin user). ensureHostSigningKey is itself idempotency
    // -guarded (checks for an existing host_signing_key row first), matching
    // this codebase's existing setup-code convention.
    const hostKey = ensureHostSigningKey(db)
    db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)

    const user = await createUser(
      db,
      { camp_id: campId, name: adminName, pin: adminPin, role: 'admin' },
      (args) => syncClient.write(args)
    )

    // This device's own `devices` row (inserted by ensureDeviceRow at
    // handlers-creation time) is authorized as part of becoming Host —
    // without this, the very next authorize()-gated IPC call made by this
    // same process (e.g. the renderer's first write() after bootstrap) would
    // be denied with 'device_not_authorized', since a devices row existing
    // no longer implies it may act. Sub-task 2's real pairing-approval flow
    // is what authorizes every OTHER device; this is the one device that
    // authorizes itself, by virtue of being the one that created the camp.
    db.prepare(
      "UPDATE devices SET authorized_at = ?, authorized_by_user_id = ?, pairing_status = 'authorized' WHERE id = ?"
    ).run(new Date().toISOString(), user.id, deviceId)

    return { campId, userId: user.id }
  }

  function getDevicePairingStatus() {
    const device = db.prepare('SELECT pairing_status, authorized_at FROM devices WHERE id = ?').get(deviceId)
    return { isPaired: !!(device?.authorized_at), pairing_status: device?.pairing_status ?? null }
  }

  function listPendingPairingRequests({ token } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'devices.read' })
    // Exclude denied devices (pairing_status='denied') so a single deny action
    // stops the device from re-appearing on the next poll (CodeReview fix).
    return db.prepare("SELECT id, name FROM devices WHERE authorized_at IS NULL AND revoked_at IS NULL AND (pairing_status IS NULL OR pairing_status = 'pending')").all()
  }

  function listDevices({ token } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'devices.read' })
    return db.prepare('SELECT id, name, pairing_status, authorized_at, revoked_at, last_synced_at FROM devices').all()
  }

  function approveDevice({ token, deviceId: targetDeviceId } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'devices.approve' })
    if (!isNonEmptyString(targetDeviceId)) throw new Error('deviceId is required')

    const existing = db.prepare('SELECT id FROM devices WHERE id = ?').get(targetDeviceId)
    if (!existing) throw new Error('device not found')

    const secret = randomBytes(32).toString('hex')
    const now = new Date().toISOString()
    db.prepare(
      "UPDATE devices SET authorized_at = ?, authorized_by_user_id = ?, pairing_status = 'authorized', device_secret_identifier = ?, revoked_at = NULL, revoked_by_user_id = NULL, revocation_reason = NULL WHERE id = ?"
    ).run(now, userId, secret, targetDeviceId)

    recordAuditEvent(db, { actorUserId: userId, deviceId: targetDeviceId, action: 'device.approve', outcome: 'allow' })

    if (syncServer) syncServer.sendPairingApproved(targetDeviceId, secret)

    return { deviceId: targetDeviceId, authorized: true }
  }

  function denyDevice({ token, deviceId: targetDeviceId } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'devices.approve' })
    if (!isNonEmptyString(targetDeviceId)) throw new Error('deviceId is required')

    // CodeReview: write pairing_status='denied' so denied devices don't
    // re-appear in listPendingPairingRequests on the next poll.
    db.prepare("UPDATE devices SET pairing_status = 'denied' WHERE id = ?").run(targetDeviceId)

    recordAuditEvent(db, { actorUserId: userId, deviceId: targetDeviceId, action: 'device.deny', outcome: 'allow' })

    if (syncServer) syncServer.sendPairingDenied(targetDeviceId)

    return { deviceId: targetDeviceId, denied: true }
  }

  function revokeDevice({ token, deviceId: targetDeviceId, reason } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'devices.revoke' })
    if (!isNonEmptyString(targetDeviceId)) throw new Error('deviceId is required')

    const existing = db.prepare('SELECT id FROM devices WHERE id = ?').get(targetDeviceId)
    if (!existing) throw new Error('device not found')

    const now = new Date().toISOString()
    db.prepare(
      "UPDATE devices SET revoked_at = ?, revoked_by_user_id = ?, revocation_reason = ?, pairing_status = 'revoked' WHERE id = ?"
    ).run(now, userId, reason ?? null, targetDeviceId)

    recordAuditEvent(db, {
      actorUserId: userId, deviceId: targetDeviceId,
      action: 'device.revoke', outcome: 'allow',
      metadata: reason ? { reason } : null,
    })

    if (syncServer) {
      for (const client of syncServer.wss.clients) {
        if (client.deviceId === targetDeviceId) {
          try { client.close(4404, 'device_revoked') } catch { /* ignore */ }
        }
      }
    }

    return { deviceId: targetDeviceId, revoked: true }
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
    // Three distinct actions dispatched from this one handler, per the ADR's
    // IPC table — matching the three distinct gates that used to be inline
    // checks here:
    // - DELETE_FIELD sentinel -> '<entity>.delete' (Security MEDIUM #1,
    //   Sub-plan B Task 3 round 2: a delete is comparably sensitive to
    //   createUser, which is admin-only — same gate, now via authorize()).
    // - camps.name -> 'camps.rename' (Round-2 fix, Sub-plan C Task 6 review:
    //   a single-camp org-identity field, gated the same way).
    // - everything else -> '<entity>.write', staff+admin per the matrix —
    //   this is the ordinary field-write path that was always ungated for
    //   both roles; authorize() now makes that explicit instead of implicit.
    const action = deriveWriteAction({ entity: writeArgs.entity, field: writeArgs.field })
    const { userId } = requireAuthorized(db, { token, action })
    if (!syncClient) {
      throw new Error('sync not initialized — choose a mode first')
    }
    return syncClient.write({ ...writeArgs, author_user_id: userId })
  }

  // A bulk_replace is a delete-then-reinsert of an ENTIRE scope (e.g. every
  // template_slots row for a template) — strictly more destructive than the
  // DELETE_FIELD/camps.name gates above, and this app has no role tier
  // narrower than admin/staff, so the whole handler is admin-gated rather
  // than trying to carve out a safe non-admin subset.
  function bulkReplace({ token, entity, scope_id, rows } = {}) {
    if (!isNonEmptyString(token)) {
      throw new Error('token is required')
    }
    // '<entity>.bulk_replace', admin-only for every entity — matches the
    // whole-handler admin gate this replaces exactly.
    const { userId } = requireAuthorized(db, { token, action: deriveBulkReplaceAction(entity) })
    if (!syncClient) {
      throw new Error('sync not initialized — choose a mode first')
    }
    // Pre-bulk-replace snapshot: same pattern as pre-resolve-conflict backup.
    // bulk_replace is the highest-risk mutation point (wipes an entire scope).
    // Best-effort — backup failure must not block the operation itself.
    if (dbPath && handlersUserDataPath) {
      try {
        writeUserBackup(dbPath, handlersUserDataPath)
      } catch {
        /* snapshot failure is non-fatal */
      }
    }
    return syncClient.writeBulkReplace({ entity, scope_id, rows, author_user_id: userId })
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
    const { userId } = requireAuthorized(db, { token, action: 'conflicts.resolve' })
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
    // Pre-resolution snapshot: copy the DB file to a dated backup so the
    // director can restore if they change their mind. Rotated to keep at
    // most 10 files (same limit as writeUserBackup). Best-effort — a backup
    // failure must not block the resolution itself (the op-log already
    // provides history; this is an extra human-accessible safety net).
    if (dbPath) {
      try {
        rotatePreResolveBackups(dbPath)
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const backupPath = dbPath.replace(/\.sqlite$/, '') + `.pre-resolve-${ts}.sqlite`
        fs.copyFileSync(dbPath, backupPath)
      } catch {
        // snapshot failure is non-fatal — resolution proceeds regardless
      }
    }

    return syncClient.write({
      entity,
      entity_id,
      field,
      value: chosenOp.value,
      parent_op_id: parent_op_id ?? null,
      author_user_id: userId,
    })
  }

  // Never selects pin_hash/pin_salt — this is consumed by UI layers (e.g. the
  // conflicts screen's author-label resolution) that must never receive raw
  // PIN material, even as an unused/unrendered field.
  // Generic entity-read IPC for renderer screens migrating off Supabase.
  // `entity` must be validated against the fixed allowlists above by exact
  // match BEFORE any query is built — a malformed/non-string/unrecognized
  // value is rejected here, never interpolated into SQL. Wrapped in
  // try/catch as defense-in-depth on top of the allowlist check itself.
  function list(token, entity) {
    if (typeof entity !== 'string' || entity.length === 0) {
      throw new Error('Invalid entity')
    }
    if (!DIRECT_CAMP_ENTITIES.has(entity) && !PARENT_SCOPED_ENTITIES[entity]) {
      throw new Error(`Unrecognized entity: ${entity}`)
    }
    if (!isNonEmptyString(token)) {
      throw new Error('token is required')
    }
    // '<entity>.read', using the already-validated entity name above —
    // staff+admin per the matrix, matching there being no existing role
    // check on this path today.
    requireAuthorized(db, { token, action: `${entity}.read` })

    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return []

    if (DIRECT_CAMP_ENTITIES.has(entity)) {
      return db.prepare(`SELECT * FROM ${entity} WHERE camp_id = ?`).all(camp.id)
    }

    const { table, parentTable, parentKey } = PARENT_SCOPED_ENTITIES[entity]
    return db
      .prepare(`SELECT t.* FROM ${table} t JOIN ${parentTable} p ON p.id = t.${parentKey} WHERE p.camp_id = ?`)
      .all(camp.id)
  }

  function listUsers(token) {
    if (!isNonEmptyString(token)) {
      throw new Error('token is required')
    }
    requireAuthorized(db, { token, action: 'users.read' })
    return db.prepare('SELECT id, name, role FROM users').all()
  }

  function getDeviceId(token) {
    if (!isNonEmptyString(token)) {
      throw new Error('token is required')
    }
    requireAuthorized(db, { token, action: 'devices.read' })
    return deviceId
  }

  // Rehydration query for the Conflicts screen: reconstructs the unresolved
  // set from the durable `conflicts` table (see operations.js) rather than
  // relying on the live op-conflict broadcast, so a conflict that was
  // pending before an app restart is still shown afterward. Sanitized the
  // same way the live broadcast is — this is an IPC send path just like
  // wireOpApplied's, so raw PIN values must never cross it either.
  function listPendingConflictsHandler(token) {
    if (!isNonEmptyString(token)) {
      throw new Error('token is required')
    }
    requireAuthorized(db, { token, action: 'conflicts.read' })
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
    list,
    bulkReplace,
    getDeviceId,
    resolveConflict,
    listPendingConflicts: listPendingConflictsHandler,
    getDevicePairingStatus,
    listPendingPairingRequests,
    listDevices,
    approveDevice,
    denyDevice,
    revokeDevice,
    getSyncClient: () => syncClient,
  }
}

function isElectronEntryPoint() {
  // eslint-disable-next-line no-undef
  return !process.env.VITEST && typeof app !== 'undefined' && app && typeof app.whenReady === 'function'
}

if (isElectronEntryPoint()) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const userDataPath = app.getPath('userData')
  const defaultDbPath = path.join(userDataPath, 'shoresh.sqlite')

  // Mutable state — swapped by project-lifecycle handlers (open/create/restore).
  let dbPath = getCurrentProjectPath(userDataPath, defaultDbPath)
  let db = openLocalDb(dbPath)
  let deviceId = getOrCreateDeviceId(db)

  let mainWindow = null

  // All IPC channels registered by makeHandlers. Keep in sync with the
  // ipcMain.handle calls in registerHandlers() below.
  const HANDLER_CHANNELS = [
    'shoresh:choose-mode',
    'shoresh:discover-hosts',
    'shoresh:login',
    'shoresh:create-user',
    'shoresh:bootstrap-camp',
    'shoresh:write',
    'shoresh:bulk-replace',
    'shoresh:verify-session',
    'shoresh:get-camp',
    'shoresh:list-users',
    'shoresh:list',
    'shoresh:get-device-id',
    'shoresh:resolve-conflict',
    'shoresh:list-conflicts',
    'shoresh:get-device-pairing-status',
    'shoresh:list-pending-pairing-requests',
    'shoresh:list-devices',
    'shoresh:approve-device',
    'shoresh:deny-device',
    'shoresh:revoke-device',
  ]

  function registerHandlers(handlers, currentDb) {
    // Remove existing registrations before re-registering (project switch).
    for (const ch of HANDLER_CHANNELS) ipcMain.removeHandler(ch)

    ipcMain.handle('shoresh:choose-mode', (_event, args) => handlers.chooseMode(args))
    ipcMain.handle('shoresh:discover-hosts', () => handlers.discoverHosts())
    ipcMain.handle('shoresh:login', (_event, args) => handlers.login(args))
    ipcMain.handle('shoresh:create-user', (_event, args) => handlers.createUser(args))
    ipcMain.handle('shoresh:bootstrap-camp', (_event, args) => handlers.bootstrapCamp(args))
    ipcMain.handle('shoresh:write', (_event, args) => handlers.write(args))
    ipcMain.handle('shoresh:bulk-replace', (_event, args) => handlers.bulkReplace(args))
    ipcMain.handle('shoresh:verify-session', (_event, args) => handlers.verifySession(args))
    // get-camp is pre-auth (called before a session exists to decide the
    // bootstrap-vs-join phase). See the note in the original registration
    // block for the full justification.
    ipcMain.handle('shoresh:get-camp', () => currentDb.prepare('SELECT id, name FROM camps LIMIT 1').get())
    ipcMain.handle('shoresh:list-users', (_event, args) => handlers.listUsers(args && args.token))
    ipcMain.handle('shoresh:list', (_event, args) => {
      const { token, entity } = args || {}
      return handlers.list(token, entity)
    })
    ipcMain.handle('shoresh:get-device-id', (_event, args) => handlers.getDeviceId(args && args.token))
    ipcMain.handle('shoresh:resolve-conflict', (_event, args) => handlers.resolveConflict(args))
    ipcMain.handle('shoresh:list-conflicts', (_event, args) => handlers.listPendingConflicts(args && args.token))
    ipcMain.handle('shoresh:get-device-pairing-status', () => handlers.getDevicePairingStatus())
    ipcMain.handle('shoresh:list-pending-pairing-requests', (_event, args) => handlers.listPendingPairingRequests(args))
    ipcMain.handle('shoresh:list-devices', (_event, args) => handlers.listDevices(args))
    ipcMain.handle('shoresh:approve-device', (_event, args) => handlers.approveDevice(args))
    ipcMain.handle('shoresh:deny-device', (_event, args) => handlers.denyDevice(args))
    ipcMain.handle('shoresh:revoke-device', (_event, args) => handlers.revokeDevice(args))
  }

  /**
   * Open a new DB at newPath, then (only on success) close the old one and
   * swap all live state. This order ensures the old db stays open and usable
   * if the new open fails — the app remains functional rather than left with
   * no working database connection.
   */
  function reinitialize(newPath) {
    // Open new db FIRST — if it throws (schema_too_new, corrupt file, etc.)
    // the old db is still open and all existing handlers remain valid.
    const newDb = openLocalDb(newPath) // throws schema_too_new if applicable
    const newDeviceId = getOrCreateDeviceId(newDb)
    const newHandlers = makeHandlers(newDb, newDeviceId, {
      getMainWindow: () => mainWindow,
      dbPath: newPath,
      userDataPath,
    })

    // New db is open and handlers built — safe to swap.
    try { db.close() } catch { /* ignore — db may already be closed */ }
    db = newDb
    dbPath = newPath
    deviceId = newDeviceId
    registerHandlers(newHandlers, db)
    setCurrentProjectPath(userDataPath, newPath)
    const camp = db.prepare('SELECT name FROM camps LIMIT 1').get()
    addRecentProject(userDataPath, { path: newPath, campName: camp?.name ?? null })
    if (mainWindow) mainWindow.webContents.reload()
  }

  // ---------------------------------------------------------------------------
  // Project-lifecycle IPC handlers (registered once, never re-registered).
  // These operate OUTSIDE makeHandlers because they swap the live db instance.
  // ---------------------------------------------------------------------------

  // Returns info about the currently-open project so the renderer can show it
  // in the sidebar footer.
  ipcMain.handle('shoresh:get-current-project', () => {
    const camp = (() => {
      try { return db.prepare('SELECT id, name FROM camps LIMIT 1').get() } catch { return null }
    })()
    return {
      path: dbPath,
      campName: camp?.name ?? null,
      schemaVersion: getSchemaVersion(db),
      openedAt: new Date().toISOString(),
    }
  })

  // Show a save-file dialog, create a fresh DB at the chosen path, run full
  // migrations, and reinitialize. The user then goes through the normal
  // bootstrap flow in the reloaded renderer.
  ipcMain.handle('shoresh:create-project', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Create New Shoresh Project',
      defaultPath: path.join(app.getPath('documents'), 'shoresh-project.db'),
      filters: [{ name: 'Shoresh Database', extensions: ['db'] }],
      buttonLabel: 'Create',
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    const newPath = result.filePath
    try {
      reinitialize(newPath)
      return { path: newPath }
    } catch (err) {
      return { error: 'create_failed', message: err.message }
    }
  })

  // Show an open-file dialog, validate the target (integrity + schema version),
  // run any needed migrations with a pre-migration backup, and reinitialize.
  ipcMain.handle('shoresh:open-project', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Shoresh Project',
      filters: [{ name: 'Shoresh Database', extensions: ['db'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    const newPath = result.filePaths[0]

    // Prevent path traversal: the dialog already constrains to .db files, but
    // we also verify the resolved path is an absolute path to a regular file.
    const resolved = path.resolve(newPath)
    if (!path.isAbsolute(resolved)) return { error: 'invalid_path' }
    try {
      const stat = fs.statSync(resolved)
      if (!stat.isFile()) return { error: 'invalid_path' }
    } catch {
      return { error: 'file_not_found' }
    }

    // Open a temporary instance just to check the schema version.
    let probe
    try {
      probe = new (await import('better-sqlite3')).default(resolved)
      probe.pragma('journal_mode = WAL')
      const version = getSchemaVersion(probe)
      probe.close()
      if (version > CURRENT_SCHEMA_VERSION) {
        return {
          error: 'schema_too_new',
          message: `This project requires a newer version of Shoresh (schema v${version}).`,
        }
      }
    } catch (err) {
      try { probe?.close() } catch { /* ignore */ }
      if (err.code === 'schema_too_new') {
        return { error: 'schema_too_new', message: err.message }
      }
      return { error: 'invalid_file', message: 'The selected file could not be opened as a Shoresh database.' }
    }

    try {
      reinitialize(resolved)
      const camp = db.prepare('SELECT name FROM camps LIMIT 1').get()
      return { path: resolved, campName: camp?.name ?? null }
    } catch (err) {
      return { error: 'open_failed', message: err.message }
    }
  })

  // Copy the current DB to a user-chosen destination. Non-destructive.
  ipcMain.handle('shoresh:export-project', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Shoresh Project',
      defaultPath: path.join(app.getPath('documents'), path.basename(dbPath)),
      filters: [{ name: 'Shoresh Database', extensions: ['db'] }],
      buttonLabel: 'Export',
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    const exportPath = result.filePath
    if (path.resolve(exportPath) === path.resolve(dbPath)) {
      return { error: 'same_file', message: 'Export destination cannot be the current project file.' }
    }
    try {
      fs.copyFileSync(dbPath, exportPath)
      try { fs.chmodSync(exportPath, 0o600) } catch { /* non-fatal */ }
      return { exportPath }
    } catch (err) {
      return { error: 'export_failed', message: err.message }
    }
  })

  // Write a dated backup to {userData}/backups/ with rotation (max 10).
  ipcMain.handle('shoresh:backup-project', () => {
    try {
      const backupPath = writeUserBackup(dbPath, userDataPath)
      return { backupPath }
    } catch (err) {
      return { error: 'backup_failed', message: err.message }
    }
  })

  // Show an open-file dialog, back up the current DB first, then copy the
  // chosen file over the current DB path and reopen the connection.
  ipcMain.handle('shoresh:restore-project', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Restore Shoresh Project from Backup',
      filters: [{ name: 'Shoresh Database', extensions: ['db'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    const sourcePath = path.resolve(result.filePaths[0])

    // Path traversal guard.
    if (!path.isAbsolute(sourcePath)) return { error: 'invalid_path' }
    try {
      const stat = fs.statSync(sourcePath)
      if (!stat.isFile()) return { error: 'invalid_path' }
    } catch {
      return { error: 'file_not_found' }
    }

    // Schema version check on source.
    let probe
    try {
      probe = new (await import('better-sqlite3')).default(sourcePath)
      probe.pragma('journal_mode = WAL')
      const version = getSchemaVersion(probe)
      probe.close()
      if (version > CURRENT_SCHEMA_VERSION) {
        return {
          error: 'schema_too_new',
          message: `Backup requires a newer version of Shoresh (schema v${version}).`,
        }
      }
    } catch {
      try { probe?.close() } catch { /* ignore */ }
      return { error: 'invalid_file', message: 'The selected file could not be read as a Shoresh database.' }
    }

    // Back up current DB before overwriting.
    try {
      writeUserBackup(dbPath, userDataPath)
    } catch {
      /* non-fatal — proceed with restore */
    }

    // Copy source to a temp path first, then atomically rename to the target.
    // This closes the corruption window where a mid-write failure (disk full,
    // etc.) would leave the target partially written — rename(2) is atomic for
    // same-volume moves on macOS/Linux/Windows (NTFS). The temp file is
    // cleaned up in the finally block if anything goes wrong before the rename.
    // Open the new file BEFORE closing the old connection — same open-before-
    // close pattern as reinitialize(): if anything fails, the old db is still
    // usable.
    const tmpPath = `${dbPath}.tmp`
    try {
      fs.copyFileSync(sourcePath, tmpPath)
      fs.renameSync(tmpPath, dbPath)
    } catch (err) {
      try { fs.unlinkSync(tmpPath) } catch { /* ignore — may not exist */ }
      return { error: 'restore_failed', message: err.message }
    }

    let newDb
    try {
      newDb = openLocalDb(dbPath)
    } catch (err) {
      return { error: 'restore_failed', message: err.message }
    }

    try { db.close() } catch { /* ignore */ }
    db = newDb
    deviceId = getOrCreateDeviceId(db)
    const restoreHandlers = makeHandlers(db, deviceId, { getMainWindow: () => mainWindow, dbPath, userDataPath })
    registerHandlers(restoreHandlers, db)
    if (mainWindow) mainWindow.webContents.reload()
    return { restored: true }
  })

  // Returns last 5 recently-opened project paths from the JSON sidecar.
  ipcMain.handle('shoresh:list-recent-projects', () => {
    return readRecentProjects(userDataPath)
  })

  // Open a specific path from the recent list — same validation as open-project.
  ipcMain.handle('shoresh:open-recent-project', async (_event, { path: targetPath } = {}) => {
    if (!isNonEmptyString(targetPath)) return { error: 'path_required' }
    const resolved = path.resolve(targetPath)
    if (!path.isAbsolute(resolved)) return { error: 'invalid_path' }
    try {
      const stat = fs.statSync(resolved)
      if (!stat.isFile()) return { error: 'invalid_path' }
    } catch {
      return { error: 'file_not_found' }
    }
    try {
      reinitialize(resolved)
      const camp = db.prepare('SELECT name FROM camps LIMIT 1').get()
      return { path: resolved, campName: camp?.name ?? null }
    } catch (err) {
      if (err.code === 'schema_too_new') {
        return { error: 'schema_too_new', message: err.message }
      }
      return { error: 'open_failed', message: err.message }
    }
  })

  // ---------------------------------------------------------------------------
  // Initial handler registration and window creation.
  // ---------------------------------------------------------------------------

  const initialHandlers = makeHandlers(db, deviceId, { getMainWindow: () => mainWindow, dbPath, userDataPath })
  registerHandlers(initialHandlers, db)

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
    const devServerUrl = process.env.VITE_DEV_SERVER_URL // eslint-disable-line no-undef
    if (devServerUrl) {
      mainWindow.loadURL(devServerUrl)
    } else {
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
    }
  }

  app.whenReady().then(createWindow)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit() // eslint-disable-line no-undef
  })
}
