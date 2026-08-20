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
import { listPendingConflicts, latestOpSeq } from './ops/operations.js'
import { authorize } from './auth/authorize.js'
import { applyUserDataPath } from './db/userDataPath.js'
import { readBuildInfo, formatBuildLabel, readAppVersion } from './buildInfo.js'
import { describeStartupFailure, formatStartupFailureLog } from './startupFailure.js'
import { deriveWriteAction, deriveBulkReplaceAction } from './auth/deriveWriteAction.js'
import { recordAuditEvent } from './audit/auditLog.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from './ops/campScopedEntities.js'
import { IPC_PIN_FIELDS } from './ops/pinFields.js'
import { listDeleted, getEntityHistory } from './ops/trash.js'
import { RESTORABLE_ENTITIES, restoreEntity } from './ops/restore.js'
import { CLEARABLE_ENTITIES, previewDelete, deleteRecord, mergeLocation } from './ops/deleteRecord.js'
import { listMigrationReviews, dismissMigrationReviews } from './ops/migrationReviews.js'
import { commitIngest, ingestUndo } from './ops/ingest.js'
import { confirmAlias, ConfirmAliasError } from './ops/confirmAlias.js'
import { duplicateWeek } from './ops/duplicateWeek.js'
import { deleteWeek } from './ops/deleteWeek.js'
import { listPendingRestores } from './sync/pendingRestores.js'
import { PROJECTIONS } from './ops/projections.js'
import {
  getCurrentProjectPath,
  setCurrentProjectPath,
  readRecentProjects,
  addRecentProject,
  writeUserBackup,
  rotatePreResolveBackups,
} from './db/projectManager.js'

const HOST_PATTERN = /^[a-zA-Z0-9.\-:]+$/

// IPC_PIN_FIELDS lives in ./ops/pinFields.js so this push boundary and the
// per-record history read (ops/trash.js) filter against one list rather than
// two copies that can drift. This is the actual security boundary: the
// renderer's own sanitizeSide (usePendingConflicts.js) is defense-in-depth
// only; by the time it runs, an unfiltered value would already be sitting in
// the renderer's JS heap as the IPC event argument, readable by any
// renderer-side code (devtools, extensions, a compromised dependency).

// Fixed allowlist for `shoresh:list` — mirrors how ops/projections.js's
// PROJECTIONS registry validates writable entities before ever touching the
// db. `entity` is validated against this map by exact key lookup (never
// regex/prefix match, never string-built into a query) before any SQL runs;
// anything not listed here is rejected, not silently queried.
//
// DIRECT_CAMP_ENTITIES/PARENT_SCOPED_ENTITIES now live in
// ./ops/campScopedEntities.js (imported above) so that this read path and
// syncServer.js's first-pairing full_sync snapshot are structurally
// guaranteed to cover the same table set — see that module's own comment.

// Explicit allowlist for `shoresh:list-by-scope`, deliberately narrower than
// PARENT_SCOPED_ENTITIES: that registry also contains
// day_override_template_slots, which C4 does not target. Gating on this set
// ALONE would let a caller-supplied scope column reach nowhere (there is
// none), but gating on PARENT_SCOPED_ENTITIES alone would silently expose
// day_override_template_slots as scope-listable. Both checks are required.
const SCOPED_LIST_ENTITIES = new Set([
  'template_slots',
  'template_overlays',
  'schedule_snapshots',
  'week_activity_exclusions',
  'week_group_exclusions',
  'week_location_exclusions',
])

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

// Extracted from listByScope's handler closure so the query shape itself
// (camp JOIN retained, scope predicate additive, scopeId ?? null) can be
// exercised directly in a test without going through requireAuthorized/IPC —
// this is what the mock/real parity test (electron/ipcSurfaceParity.test.js)
// runs against the mock's listByScope with identical fixture data. Callers
// are expected to have already validated entity against SCOPED_LIST_ENTITIES
// and PARENT_SCOPED_ENTITIES.
export function runScopedQuery(db, entity, scopeId) {
  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!camp) return []

  const { table, parentTable, parentKey } = PARENT_SCOPED_ENTITIES[entity]
  return db
    .prepare(
      `SELECT t.* FROM ${table} t JOIN ${parentTable} p ON p.id = t.${parentKey} WHERE p.camp_id = ? AND t.${parentKey} = ?`
    )
    .all(camp.id, scopeId ?? null)
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

// Finding E (docs/adr/2026-08-15-locations-concurrent-create-collision.md
// addendum): op_rejected's `op` is the full submitted op, unsanitized — the
// same PIN-bearing-field risk sanitizeOpForIpc already exists to close for
// op-applied/op-conflict. `existing` is separately safe: D3 already
// field-picks it to `{ id, name, capacity, notes }` before it ever reaches
// this file (never a raw `SELECT *` row), so only `op` needs sanitizing here.
export function sanitizeOpRejectedForIpc(msg) {
  if (!msg) return msg
  return { ...msg, op: sanitizeOpForIpc(msg.op) }
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
    // D3/D4 (docs/adr/2026-08-15-locations-concurrent-create-collision.md):
    // mirrors onOpConflict's wiring exactly. This is what makes the offline-
    // queue case (D4) reach the renderer at all — flushQueue runs with no
    // live caller waiting on any one write, so the push event is the only
    // way the director learns a queued create was rejected. Finding E
    // (addendum): `existing` is safe unsanitized — D3 already field-picks it
    // to `{ id, name, capacity, notes }`, never a raw `SELECT *` row — but
    // `msg.op` is the full submitted op, unsanitized, so it goes through
    // sanitizeOpRejectedForIpc the same way op-applied/op-conflict do above.
    if (typeof syncClient.onOpRejected === 'function') {
      syncClient.onOpRejected((msg) => {
        const mainWindow = getMainWindow ? getMainWindow() : null
        if (mainWindow) mainWindow.webContents.send('shoresh:op-rejected', sanitizeOpRejectedForIpc(msg))
      })
    }
    // Completion push for the first-sync write-gate (design doc Part 4.2).
    // No payload — this is a pure "your domain data just landed, reload"
    // signal, mirroring onOpApplied's wiring shape but with nothing to
    // sanitize/forward. Renderer consumption (reading it, and the actual
    // write-gate it unblocks) is slice 2 of this fix.
    if (typeof syncClient.onFullSyncApplied === 'function') {
      syncClient.onFullSyncApplied(() => {
        const mainWindow = getMainWindow ? getMainWindow() : null
        if (mainWindow) mainWindow.webContents.send('shoresh:full-sync-applied')
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
    // T87 Part 3 — mirrors onPairingDenied's forwarding exactly. Carries only
    // the numeric close code, never the rejected token.
    if (typeof syncClient.onAuthRejected === 'function') {
      syncClient.onAuthRejected((code) => {
        const w = getMainWindow ? getMainWindow() : null
        if (w) w.webContents.send('shoresh:auth-rejected', { code })
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
  // T16 — commit an import the director approved in the preview. Admin only:
  // it creates setup records in bulk, which is the same authority the setup
  // screens already require.
  // `mode` is renamed on the way in. The closure already has a `mode` — this
  // device's sync mode — and the guard below reads it; a shadowing parameter
  // would silently turn the Host check into a comparison against the import
  // mode instead.
  function ingestCommit({ token, approved, links, clears, humanEditedFields, cohort_id, fixedEvents, activityRules, mode: ingestMode, resolutions, base_generation, seenCounts, pinOnlyActivityNames, captureInverse } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    // Admin only. Staff may edit setup records one at a time; creating a
    // camp's whole structure in one action is a different kind of authority,
    // and 'groups.import' is deliberately absent from the staff permission
    // list so admin: ['*'] is what grants it.
    const session = requireAuthorized(db, { token, action: 'groups.import' })
    // HOST ONLY, both modes (T61). commitIngest appends every op straight to
    // THIS device's SQLite; it never routes through syncClient.write, so an
    // import run on a Client is invisible to the Host and every peer — under
    // Replace that silently forks the whole camp while showing a success
    // banner. Same gate as deleteRecordHandler and restoreEntityHandler, and
    // for the same reason (electron/ops/deleteRecord.js): a Client cannot
    // express a multi-op atomic transaction over submit_op. Refused outright
    // rather than routed to the Host — a Client→Host requestReplace is a
    // separate decision, not something to invent here.
    if (mode === 'client') {
      throw new Error(
        ingestMode === 'replace'
          ? 'Replace can only be run on the main computer.'
          : 'Import can only be run on the main computer.'
      )
    }
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) throw new Error('no camp on this device')
    return commitIngest(db, {
      approved,
      links,
      // ADR 2026-08-09 Decision 2 — the S4b clear path (record.clears) now has
      // a real caller from a raw schedule import too, and the item-level
      // human/import provenance side-channel for the unit field. Both arrive
      // ONLY through this host-trusted IPC call, alongside approved/links —
      // no new trust boundary (Red Hat Risk 4).
      clears: clears ?? {},
      humanEditedFields: humanEditedFields ?? {},
      // The Program the director is importing into, so units and time blocks
      // land where the setup screens will show them (T33).
      cohort_id: cohort_id ?? null,
      camp_id: camp.id,
      author_user_id: session.userId,
      device_id: deviceId,
      // Recurring fixed events the director ticked, resolved to real rows and
      // written as anchor_activities (T34). Defaults to none.
      fixedEvents: fixedEvents ?? [],
      // Inferred/edited activity rules (T35), keyed by activity name. Defaults
      // to none, preserving pre-T35 behaviour for callers that pass none.
      activityRules: activityRules ?? {},
      // T61 — 'replace' clears the camp's importable setup and its dependent
      // rows first, in the same transaction. Anything else is an add.
      mode: ingestMode === 'replace' ? 'replace' : 'add',
      // T73 — a director's per-conflict decisions when re-committing a held
      // import. Empty/absent on a first commit, so behavior is unchanged.
      resolutions: resolutions ?? [],
      // S4b §4 — the enrichment workbook's exported op-log generation, so the
      // commit can gate import-over-import staleness. Absent (0) for the raw
      // schedule/clipboard path, leaving the clock gate inert.
      base_generation: base_generation ?? 0,
      // ADR 2026-08-17-onescreen-reconciliation-merge.md §1/A3 — real create
      // confidence input and the pin-only guard. Absent for the S4b workbook
      // path (no seenCounts there — Risk 2/A4), which keeps every non-location
      // create tier:'new', unchanged.
      seenCounts: seenCounts ?? null,
      pinOnlyActivityNames: pinOnlyActivityNames ?? [],
      // U1 — additive, opt-in. Absent/false for every existing caller, same
      // behavior as before (docs/adr/2026-08-17-onescreen-reconciliation-undo.md).
      captureInverse: captureInverse === true,
    })
  }

  // D1 (dry-run reconciliation, docs/adr/2026-08-10-...ingestion-phaseD...).
  // Same auth gate as ingestCommit, but NOT the Host-only 'mode === client'
  // guard above — a dry run commits nothing anywhere, on any device, so there
  // is no fork-the-camp risk to guard against. Also does not push any
  // onOpApplied/sync broadcast: nothing was written for a peer to learn about.
  function ingestReconcile({ token, approved, links, clears, humanEditedFields, cohort_id, fixedEvents, activityRules, mode: ingestMode, resolutions, base_generation, seenCounts, pinOnlyActivityNames } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = requireAuthorized(db, { token, action: 'groups.import' })
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) throw new Error('no camp on this device')
    const outcome = commitIngest(db, {
      approved,
      links,
      clears: clears ?? {},
      humanEditedFields: humanEditedFields ?? {},
      cohort_id: cohort_id ?? null,
      camp_id: camp.id,
      author_user_id: session.userId,
      device_id: deviceId,
      fixedEvents: fixedEvents ?? [],
      activityRules: activityRules ?? {},
      mode: ingestMode === 'replace' ? 'replace' : 'add',
      resolutions: resolutions ?? [],
      base_generation: base_generation ?? 0,
      seenCounts: seenCounts ?? null,
      pinOnlyActivityNames: pinOnlyActivityNames ?? [],
      dryRun: true,
    })
    return {
      dryRun: true,
      held: outcome.held,
      conflicts: outcome.conflicts,
      planItems: outcome.planItems ?? [],
      // FIX 1 — the reconciliation report needs created/unchanged as entries
      // (name/confidence/time_block/days), not the bare counts ImportScreen's
      // post-commit banner reads; substitute the parallel detail channel here,
      // additively, without changing outcome.fixedEvents' own shape.
      fixedEventsReport: outcome.fixedEvents && {
        ...outcome.fixedEvents,
        created: outcome.fixedEvents.createdEntries ?? [],
        unchanged: outcome.fixedEvents.unchangedEntries ?? [],
      },
      fieldProvenance: outcome.fieldProvenance ?? {},
      legacyPriorityActivities: outcome.legacyPriorityActivities ?? [],
      evidenceSupport: outcome.evidenceSupport ?? {},
    }
  }

  // U1 (docs/adr/2026-08-17-onescreen-reconciliation-undo.md) — reverts the
  // field-update half of an import the director just committed. Same
  // authority as ingestCommit (an undo is itself a set of writes to the
  // camp's setup) and the SAME Host-only gate for the SAME reason: it writes
  // straight to this device's SQLite via appendOp, never through
  // syncClient.write, so on a Client it would be invisible to the Host and
  // every peer.
  function ingestUndoHandler({ token, invertibleOps, createdEntityIds, client_write_id } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = requireAuthorized(db, { token, action: 'groups.import' })
    if (mode === 'client') {
      throw new Error('Undo can only be run on the main computer.')
    }
    if (!isNonEmptyString(client_write_id)) throw new Error('client_write_id is required')
    return ingestUndo(db, {
      invertibleOps: Array.isArray(invertibleOps) ? invertibleOps : [],
      createdEntityIds: Array.isArray(createdEntityIds) ? createdEntityIds : [],
      author_user_id: session.userId,
      device_id: deviceId,
      client_write_id,
    })
  }

  // S1b — confirm that an imported label means an existing entity, so the
  // next import recognizes it without asking again
  // (docs/adr/2026-08-09-s1b-host-local-aliases.md §2). Admin-only via
  // 'source_aliases.confirm', deliberately absent from the staff permission
  // list (permissions.js) — the same omission pattern as 'groups.import'.
  // HOST ONLY, same reasoning as ingestCommit above: confirmAlias writes
  // straight to THIS device's SQLite via direct SQL (no op-log), so running
  // it on a Client would be invisible to the Host and every peer.
  function confirmAliasHandler({ token, entity_type, cohort_id, source_label, entity_id } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = requireAuthorized(db, { token, action: 'source_aliases.confirm' })
    if (mode === 'client') {
      throw new Error('Confirming an import match can only be done on the main computer.')
    }
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) throw new Error('no camp on this device')
    try {
      return confirmAlias(db, {
        camp_id: camp.id,
        entity_type,
        cohort_id: cohort_id ?? null,
        source_label,
        entity_id,
        confirmed_by: session.userId,
      })
    } catch (err) {
      if (err instanceof ConfirmAliasError) throw new Error(err.message)
      throw err
    }
  }

  // S4b §4 — the op-log's current generation, so S4a's export can stamp a real
  // base_generation the round-trip's staleness gate reads. Read-only.
  function latestOpSeqHandler() {
    return latestOpSeq(db)
  }

  // T27 — what this device IS right now, as opposed to chooseMode, which sets
  // it. Kept strictly read-only: a status call that could reconfigure the
  // device would be a much larger change than it looks.
  //
  // 'standalone' is not the same as 'client, disconnected'. A device that never
  // joined anything is working correctly; a client that cannot see the Host is
  // not, and the director needs to be able to tell those apart.
  function getSyncStatus() {
    if (!modeChosen) return { mode: null, connected: false, state: 'standalone' }
    if (mode === 'host') return { mode: 'host', connected: true, state: 'host' }
    const connected = typeof syncClient?.isConnected === 'function' ? syncClient.isConnected() : false
    // T87 Part 4 (docs/adr/2026-08-16-client-reauth-on-restart.md): a socket
    // can be open without being authenticated (fresh connect, or a rejected
    // token mid-reconnect) — 'client-connected' now means transport-open
    // AND authenticated, not merely transport-open, so the sidebar's "linked"
    // copy stops overclaiming.
    const authed = typeof syncClient?.isAuthenticated === 'function' ? syncClient.isAuthenticated() : false
    const state = !connected ? 'client-disconnected' : (authed ? 'client-connected' : 'client-connecting')
    return { mode: 'client', connected, authenticated: authed, state }
  }

  // T27 — push the status when it changes, rather than leaving the renderer to
  // poll. Without this the sidebar would show whatever was true at mount.
  function wireSyncStatus() {
    if (typeof syncClient?.onConnectionChange !== 'function') return
    syncClient.onConnectionChange(() => {
      const mainWindow = getMainWindow ? getMainWindow() : null
      if (mainWindow) mainWindow.webContents.send('shoresh:sync-status-changed', getSyncStatus())
    })
  }

  // guessing.
  function chooseMode(args) {
    const { mode: requestedMode, campName, port, token } = args || {}
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
      // Auto-authorize the Host device if its devices row lacks authorized_at.
      // Pre-trust-system DBs were bootstrapped before authorize() existed, so
      // bootstrapCamp never stamped it. Do this at mode-selection time so it
      // applies to both fresh logins AND stored-session restores (which bypass
      // the login handler entirely but still call chooseMode on every startup).
      db.prepare(
        "UPDATE devices SET authorized_at = COALESCE(authorized_at, ?), pairing_status = 'authorized' WHERE id = ?"
      ).run(new Date().toISOString(), deviceId)
      syncClient = createSyncClient(db, { device_id: deviceId, author_user_id: null, wss: syncServer.wss })
      wireOpApplied()
      wireSyncStatus()
    } else {
      pendingServerUrl = resolveClientServerUrl(args)
      const deviceRow = db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId)
      const deviceNameForPairing = deviceRow?.name || `Device ${deviceId.slice(0, 8)}`
      syncClient = createSyncClient(db, {
        device_id: deviceId,
        author_user_id: null,
        serverUrl: pendingServerUrl,
        device_name: deviceNameForPairing,
        // T87 (docs/adr/2026-08-16-client-reauth-on-restart.md, Part 2): a
        // returning Client's locally-verified token, so connect()'s existing
        // `if (token) → authenticate` branch (syncClient.js) actually fires
        // on startup instead of always falling back to pairing_request.
        token,
      })
      wireOpApplied()
      wirePairingCallbacks()
      wireSyncStatus()
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

    // Lazily create the Ed25519 signing key for Host devices that were
    // bootstrapped before §5 (pre-existing camps have no host_signing_key row).
    if (mode !== 'client') {
      ensureHostSigningKey(db)
      // Auto-authorize the Host device if its devices row lacks authorized_at —
      // pre-trust-system DBs were bootstrapped before authorize() existed so
      // bootstrapCamp never stamped authorized_at. Holding the private key IS
      // the proof of Host identity; no separate approval is needed.
      db.prepare(
        "UPDATE devices SET authorized_at = COALESCE(authorized_at, ?), pairing_status = 'authorized' WHERE id = ?"
      ).run(new Date().toISOString(), deviceId)
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

    // A Host trivially has 100% of its own data from the instant of its own
    // bootstrap — it never syncs FROM another device, so it must never be
    // gated by the first-sync write-gate (design doc Part 4.1/4.3, slice 2).
    // Migration v22's backfill only covers a camp that already existed at
    // migration time; a brand-new bootstrap (this path) needs its own set.
    db.prepare(
      'UPDATE device_identity SET first_sync_completed_at = COALESCE(first_sync_completed_at, ?)'
    ).run(new Date().toISOString())

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
    // T85 Risk 3a (docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md):
    // the op-log FK stub-seed (handleAuthenticate's self-registration path
    // plus the op-apply FK backfill) creates real `devices` rows with
    // pairing_status='unknown' for every peer a device merely HEARS an op
    // from — never a device that actually paired with this one. These rows
    // are inert (never authorized, already excluded from
    // listPendingPairingRequests above) but would otherwise surface in the
    // Device Manager list as phantom "Device xxxxxxxx / Not set up yet"
    // rows on every multi-device camp. Excluded here, not at the schema
    // level, so this stays scoped to the management-list read.
    return db.prepare("SELECT id, name, pairing_status, authorized_at, revoked_at, last_synced_at FROM devices WHERE pairing_status IS NOT 'unknown'").all()
  }

  function approveDevice({ token, deviceId: targetDeviceId } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'devices.approve' })
    // T86 — same reason as ingestCommit/confirmAlias: this writes straight to
    // THIS device's local, never-synced `devices` table. On a Client that
    // write can never reach the Host, where device trust is actually
    // enforced, so it must refuse outright rather than present a false
    // success. Checked after requireAuthorized, matching that precedent, so
    // an unauthorized caller gets the auth failure rather than learning the
    // device's mode.
    if (mode === 'client') {
      throw new Error('Device management can only be done on the main computer.')
    }
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
    // T86 — same reason as approveDevice above.
    if (mode === 'client') {
      throw new Error('Device management can only be done on the main computer.')
    }
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
    // T86 — same reason as approveDevice above.
    if (mode === 'client') {
      throw new Error('Device management can only be done on the main computer.')
    }
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
  function resolveConflict({ token, entity, entity_id, field, chosen_op_id, parent_op_id, stale_accept = false } = {}) {
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

    // S2b R1 (§3a): resolving a `stale` conflict by ACCEPTING the import value
    // stamps source:'import' on the resulting write — a resolution-path
    // provenance distinct from the generic human seam. This makes the director's
    // acceptance STICK: the field becomes import-owned, so future re-imports
    // update it quietly instead of re-conflicting, letting a pre-S2a camp escape
    // the NULL trap. Every OTHER resolution — including a director overriding
    // with their own typed value — stays 'human' (the default). resolveConflict
    // runs host-local, where import ownership is legitimately stamped.
    const source = stale_accept ? 'import' : 'human'

    return syncClient.write({
      entity,
      entity_id,
      field,
      value: chosenOp.value,
      parent_op_id: parent_op_id ?? null,
      author_user_id: userId,
      source,
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

  // Scope-filtered sibling of list(): same allowlist-before-query discipline,
  // but additionally requires SCOPED_LIST_ENTITIES membership so that
  // day_override_template_slots (present in PARENT_SCOPED_ENTITIES but not
  // targeted by this read path) is rejected rather than silently exposed.
  // The camp JOIN from list() is retained — the scope predicate is additive,
  // not a replacement — because template_slots and its siblings have no
  // camp_id column of their own (see campScopedEntities.js).
  function listByScope(token, entity, scopeId) {
    if (typeof entity !== 'string' || entity.length === 0) {
      throw new Error('Invalid entity')
    }
    if (!SCOPED_LIST_ENTITIES.has(entity) || !PARENT_SCOPED_ENTITIES[entity]) {
      throw new Error(`Unrecognized entity: ${entity}`)
    }
    if (!isNonEmptyString(token)) {
      throw new Error('token is required')
    }
    requireAuthorized(db, { token, action: `${entity}.read` })

    return runScopedQuery(db, entity, scopeId)
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

  // --- Trash and record history ------------------------------------------
  // docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md

  function listDeletedHandler(token) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'trash.read' })
    return listDeleted(db)
  }

  // Restore requests this device has recorded but not yet delivered. Read
  // straight from the local table rather than from syncClient, so it answers
  // correctly before a mode is chosen and on a Host (where it is always
  // empty — a Host performs a restore directly, there is no hop to fail).
  function listPendingRestoresHandler(token) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'trash.read' })
    return listPendingRestores(db)
  }

  function getEntityHistoryHandler({ token, entity, entity_id } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    if (!isNonEmptyString(entity) || !PROJECTIONS[entity]) throw new Error('Invalid entity')
    if (!isNonEmptyString(entity_id)) throw new Error('entity_id is required')
    requireAuthorized(db, { token, action: `${entity}.read` })
    // Pin material is withheld inside getEntityHistory itself, against the
    // same list this file's op-applied push filters on. Do not add a second,
    // looser read path here.
    return getEntityHistory(db, { entity, entity_id })
  }

  // Restore executes on the HOST. A Client does not hold the op history for
  // records created before it paired (its first full_sync ships materialized
  // rows and sets last_synced_seq to the then-current max), so restoring from
  // its own log would produce an empty shell. A Client therefore asks the
  // Host, and queues the request when the Host is unreachable.
  async function restoreEntityHandler({ token, entity, entity_id } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    if (!isNonEmptyString(entity)) throw new Error('Invalid entity')
    const { userId } = requireAuthorized(db, { token, action: `${entity}.restore` })
    if (!isNonEmptyString(entity_id)) throw new Error('entity_id is required')
    // Refused in the handler, not hidden in the UI — and refused on the Client
    // too, so a request that could only ever be rejected is never queued.
    if (!RESTORABLE_ENTITIES.has(entity)) return { error: 'not-restorable' }

    if (mode === 'client') {
      if (!syncClient) throw new Error('sync not initialized — choose a mode first')
      return syncClient.requestRestore({ entity, entity_id, requested_by: userId })
    }

    const result = restoreEntity(db, { entity, entity_id, author_user_id: userId, device_id: deviceId })
    if (result.error) return result
    // The ops are not broadcast here, matching every other Host-local write:
    // in host mode syncClient has no serverUrl, so an ordinary write() also
    // reaches peers via sendMissedOps on their next authenticate rather than
    // a live push. Restore must not invent a second convention.
    return { ok: true, restored_fields: result.restored_fields, deleted_children: result.deleted_children }
  }

  // --- Deleting a record a schedule uses ----------------------------------
  // docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
  //
  // Both handlers carry the SAME gate, '<entity>.delete'. previewDelete only
  // reads, but what it reads is the shape of the schedule — an ungated preview
  // would be a way for a staff user to enumerate it.

  function previewDeleteHandler({ token, entity, entity_id } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    if (!isNonEmptyString(entity)) throw new Error('Invalid entity')
    requireAuthorized(db, { token, action: `${entity}.delete` })
    if (!isNonEmptyString(entity_id)) throw new Error('entity_id is required')
    if (!CLEARABLE_ENTITIES.has(entity)) return { error: 'not-clearable' }
    return previewDelete(db, { entity, entity_id })
  }

  // Executes on the HOST, like a restore — a Client cannot express this as one
  // atomic transaction over submit_op. Unlike a restore it is NEVER QUEUED: a
  // queued delete would run against a count the director was shown hours
  // earlier, and a count nobody agreed to is not a count. With no Host, refuse
  // and say so.
  async function deleteRecordHandler({ token, entity, entity_id, expected_slot_count } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    if (!isNonEmptyString(entity)) throw new Error('Invalid entity')
    const { userId } = requireAuthorized(db, { token, action: `${entity}.delete` })
    if (!isNonEmptyString(entity_id)) throw new Error('entity_id is required')
    if (!CLEARABLE_ENTITIES.has(entity)) return { error: 'not-clearable' }

    if (mode === 'client') {
      if (!syncClient) throw new Error('sync not initialized — choose a mode first')
      return syncClient.requestDelete({ entity, entity_id, expected_slot_count })
    }

    const result = deleteRecord(db, {
      entity,
      entity_id,
      expected_slot_count,
      author_user_id: userId,
      device_id: deviceId,
    })
    if (result.error) return result
    // Ops are not broadcast here, matching every other Host-local write — peers
    // pick them up via sendMissedOps on their next authenticate.
    const { ops, ...reportable } = result
    return { ...reportable, ops_written: ops.length }
  }

  // --- Locations: merge two near-duplicate places, and the migration review
  // journal (M3c) ----------------------------------------------------------
  // docs/adr/2026-08-15-locations-merge-and-delete-rehome.md

  // Dedicated entry point (Open Q1 (a)) delegating to the shared deleteRecord
  // atomic core (D1) — a mergeLocation-shaped op, not a second delete-shaped
  // module. Same posture as deleteRecordHandler: HOST ONLY, never queued on a
  // Client (a merge executed later against a stale ref_count is not the merge
  // the director agreed to), same gate ('locations.delete' — merging DELETES
  // the loser, which is exactly what that gate already protects).
  async function mergeLocationHandler({ token, loser_id, winner_id, winner_capacity, expected_ref_count } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'locations.delete' })
    if (!isNonEmptyString(loser_id)) throw new Error('loser_id is required')
    if (!isNonEmptyString(winner_id)) throw new Error('winner_id is required')
    // Same shape the WS path's validateMergeLocationRequestMsg enforces
    // (syncServer.js) — the IPC caller is the trusted renderer, so this is
    // not a security boundary, but the two entry points must not be able to
    // drift on what they accept.
    if (winner_capacity !== undefined && winner_capacity !== null && !Number.isInteger(winner_capacity)) {
      throw new Error('Invalid winner_capacity')
    }
    if (expected_ref_count !== undefined && expected_ref_count !== null && !Number.isInteger(expected_ref_count)) {
      throw new Error('Invalid expected_ref_count')
    }

    if (mode === 'client') {
      if (!syncClient) throw new Error('sync not initialized — choose a mode first')
      return syncClient.requestMerge({ loser_id, winner_id, winner_capacity, expected_ref_count })
    }

    const result = mergeLocation(db, {
      loser_id,
      winner_id,
      winner_capacity,
      expected_ref_count,
      author_user_id: userId,
      device_id: deviceId,
    })
    if (result.error) return result
    // Ops are not broadcast here, matching deleteRecordHandler — peers pick
    // them up via sendMissedOps on their next authenticate.
    const { ops, ...reportable } = result
    return { ...reportable, ops_written: ops.length }
  }

  // The v32 migration's first-run review journal. HOST-LOCAL-SAFE reads the
  // calling device's own DB directly, regardless of mode — it never routes to
  // the Host like previewDelete/deleteRecord/restoreEntity above, because the
  // journal is per-device and never replicated (D3). Same posture as
  // listPendingConflictsHandler above.
  function listMigrationReviewsHandler(token) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'locations.read' })
    return listMigrationReviews(db)
  }

  // Dismiss = delete the local journal row(s) — a LOCAL WRITE, never an op,
  // never routed to the Host or broadcast (D4). Gated '.write' (not '.delete')
  // — dismissing a review changes no replicated location data, it only
  // resolves this device's own advisory.
  function dismissMigrationReviewsHandler({ token, ids } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'locations.write' })
    return dismissMigrationReviews(db, ids)
  }

  function duplicateWeekHandler({ token, sourceWeekId } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'schedule_weeks.write' })
    if (!isNonEmptyString(sourceWeekId)) throw new Error('sourceWeekId is required')
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) throw new Error('no camp')

    const result = duplicateWeek(
      db,
      { sourceWeekId, campId: camp.id },
      { author_user_id: userId, device_id: deviceId }
    )
    if (result.error) return result
    const { ops, ...reportable } = result
    return { ...reportable, ops_written: ops.length }
  }

  function deleteWeekHandler({ token, weekId } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    // ADMIN-ONLY, deliberately '.delete' not '.write': deleteWeek() is a
    // permanent, non-restorable cascade (restore.js refuses every entity it
    // touches) across BOTH route schedules, all saved snapshots, slots,
    // overlays and exclusions. It is the single largest irreversible action in
    // the app, and it destroys schedule_snapshots wholesale — whose INDIVIDUAL
    // delete is already admin-only (src/screens/schedule/useSnapshots.js). So
    // it must not derive to '<entity>.write', which staff hold. Staff keep
    // create/edit/duplicate/exclusion control over weeks; only permanent delete
    // is withheld. See the owner decision recorded in
    // docs/adr/2026-08-03-multi-week-slices-2-3.md and the boundary test in
    // electron/auth/authorize.test.js.
    const { userId } = requireAuthorized(db, { token, action: 'schedule_weeks.delete' })
    if (!isNonEmptyString(weekId)) throw new Error('weekId is required')
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) throw new Error('no camp')

    const result = deleteWeek(
      db,
      { weekId, campId: camp.id },
      { author_user_id: userId, device_id: deviceId }
    )
    if (result.error) return result
    const { ops, ...reportable } = result
    return { ...reportable, ops_written: ops.length }
  }

  return {
    chooseMode,
    discoverHosts: discoverHostsHandler,
    previewDelete: previewDeleteHandler,
    deleteRecord: deleteRecordHandler,
    mergeLocation: mergeLocationHandler,
    listMigrationReviews: listMigrationReviewsHandler,
    dismissMigrationReviews: dismissMigrationReviewsHandler,
    duplicateWeek: duplicateWeekHandler,
    deleteWeek: deleteWeekHandler,
    listDeleted: listDeletedHandler,
    listPendingRestores: listPendingRestoresHandler,
    getEntityHistory: getEntityHistoryHandler,
    restoreEntity: restoreEntityHandler,
    login,
    createUser: createUserHandler,
    bootstrapCamp,
    write,
    verifySession,
    listUsers,
    list,
    listByScope,
    bulkReplace,
    getDeviceId,
    getSyncStatus,
    ingestCommit,
    ingestReconcile,
    ingestUndo: ingestUndoHandler,
    confirmAlias: confirmAliasHandler,
    latestOpSeq: latestOpSeqHandler,
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
  return !process.env.VITEST && typeof app !== 'undefined' && app && typeof app.whenReady === 'function'
}

if (isElectronEntryPoint()) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))

  // Never leave the process alive with no window and no explanation. Three
  // audiences, three channels: the director gets a dialog, whoever is helping
  // them gets a file, and a terminal launch gets stderr plus a non-zero exit.
  // Shared by the module-level startup catch below and the whenReady() catch
  // around createWindow(), so a throw inside createWindow (e.g. BrowserWindow
  // construction failing) is reported the same way as one before it.
  function reportStartupFailure(err) {
    const when = new Date().toISOString()
    let logPath = null
    try {
      const dir = app.getPath('userData')
      fs.mkdirSync(dir, { recursive: true })
      logPath = path.join(dir, 'startup-error.log')
      fs.writeFileSync(logPath, formatStartupFailureLog(err, when))
    } catch {
      logPath = null // a logging failure must not replace the real error
    }

    const { title, message } = describeStartupFailure(err, logPath)
    process.stderr.write(`\n${title}\n${message}\n`)

    // showErrorBox is safe before 'ready' and is the only way to say anything
    // when the failure happened before a window could exist.
    try { dialog.showErrorBox(title, message) } catch { /* headless */ }

    app.exit(1)
  }

  // T19: everything below runs at module top level, before whenReady. A throw
  // here used to abort the module body, leaving an app with no window and no
  // message anywhere. Wrapped so a fatal startup error is SHOWN rather than
  // swallowed — see electron/startupFailure.js.
  try {
  // MUST run before any app.getPath() call and before whenReady(), or setName
  // silently has no effect — see electron/db/userDataPath.js and
  // docs/adr/2026-07-28-explicit-userdata-directory.md. Without it Electron
  // infers the directory from argv, which put every dev clone in one shared
  // "Electron" directory while the packaged app used "shoresh".
  const userDataPath = applyUserDataPath(app)
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
    'shoresh:list-by-scope',
    'shoresh:get-device-id',
    'shoresh:get-sync-status',
    'shoresh:ingest-commit',
    'shoresh:ingest-reconcile',
    'shoresh:ingest-undo',
    'shoresh:confirm-alias',
    'shoresh:latest-op-seq',
    'shoresh:resolve-conflict',
    'shoresh:list-conflicts',
    'shoresh:list-deleted',
    'shoresh:list-pending-restores',
    'shoresh:get-entity-history',
    'shoresh:restore-entity',
    'shoresh:preview-delete',
    'shoresh:delete-record',
    'shoresh:merge-location',
    'shoresh:list-migration-reviews',
    'shoresh:dismiss-migration-reviews',
    'shoresh:get-device-pairing-status',
    'shoresh:list-pending-pairing-requests',
    'shoresh:list-devices',
    'shoresh:approve-device',
    'shoresh:deny-device',
    'shoresh:revoke-device',
    'shoresh:duplicate-week',
    'shoresh:delete-week',
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
    ipcMain.handle('shoresh:list-by-scope', (_event, args) => {
      const { token, entity, scopeId } = args || {}
      return handlers.listByScope(token, entity, scopeId)
    })
    ipcMain.handle('shoresh:get-device-id', (_event, args) => handlers.getDeviceId(args && args.token))
    ipcMain.handle('shoresh:get-sync-status', () => handlers.getSyncStatus())
    ipcMain.handle('shoresh:ingest-commit', (_event, args) => handlers.ingestCommit(args))
    ipcMain.handle('shoresh:ingest-reconcile', (_event, args) => handlers.ingestReconcile(args))
    ipcMain.handle('shoresh:ingest-undo', (_event, args) => handlers.ingestUndo(args))
    ipcMain.handle('shoresh:confirm-alias', (_event, args) => handlers.confirmAlias(args))
    ipcMain.handle('shoresh:latest-op-seq', () => handlers.latestOpSeq())
    ipcMain.handle('shoresh:resolve-conflict', (_event, args) => handlers.resolveConflict(args))
    ipcMain.handle('shoresh:list-conflicts', (_event, args) => handlers.listPendingConflicts(args && args.token))
    ipcMain.handle('shoresh:list-deleted', (_event, args) => handlers.listDeleted(args && args.token))
    ipcMain.handle('shoresh:list-pending-restores', (_event, args) => handlers.listPendingRestores(args && args.token))
    ipcMain.handle('shoresh:get-entity-history', (_event, args) => handlers.getEntityHistory(args))
    ipcMain.handle('shoresh:restore-entity', (_event, args) => handlers.restoreEntity(args))
    ipcMain.handle('shoresh:preview-delete', (_event, args) => handlers.previewDelete(args))
    ipcMain.handle('shoresh:delete-record', (_event, args) => handlers.deleteRecord(args))
    ipcMain.handle('shoresh:merge-location', (_event, args) => handlers.mergeLocation(args))
    ipcMain.handle('shoresh:list-migration-reviews', (_event, args) => handlers.listMigrationReviews(args && args.token))
    ipcMain.handle('shoresh:dismiss-migration-reviews', (_event, args) => handlers.dismissMigrationReviews(args))
    ipcMain.handle('shoresh:get-device-pairing-status', () => handlers.getDevicePairingStatus())
    ipcMain.handle('shoresh:list-pending-pairing-requests', (_event, args) => handlers.listPendingPairingRequests(args))
    ipcMain.handle('shoresh:list-devices', (_event, args) => handlers.listDevices(args))
    ipcMain.handle('shoresh:approve-device', (_event, args) => handlers.approveDevice(args))
    ipcMain.handle('shoresh:deny-device', (_event, args) => handlers.denyDevice(args))
    ipcMain.handle('shoresh:revoke-device', (_event, args) => handlers.revokeDevice(args))
    ipcMain.handle('shoresh:duplicate-week', (_event, args) => handlers.duplicateWeek(args))
    ipcMain.handle('shoresh:delete-week', (_event, args) => handlers.deleteWeek(args))
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
      // The UI must be able to tell which database it is looking at — the T9
      // harm was never that two exist, but that nothing on screen distinguished them.
      isDev: !app.isPackaged,
      // ...and which BUILD it is running (T13). A stale packaged build was
      // previously indistinguishable from a current one, which cost a whole
      // diagnosis cycle on T12.
      // T14: both arguments are deliberate. readBuildInfo is told whether this
      // is a packaged run rather than inferring it from a file that survives
      // packaging, and the version comes from package.json because
      // app.getVersion() returns Electron's own version when unpackaged.
      build: formatBuildLabel(readBuildInfo(undefined, app.isPackaged), readAppVersion()),
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
      try {
        fs.renameSync(tmpPath, dbPath)
      } catch (renameErr) {
        if (renameErr.code === 'EXDEV') {
          // Cross-device move: tmp and target are on different filesystems.
          // Fall back to copy+delete — not atomic, but the pre-restore backup
          // above already guards against a mid-write failure here.
          fs.copyFileSync(tmpPath, dbPath)
          // Do not let a cleanup failure here propagate as a restore failure —
          // dbPath already has the correct content at this point.
          try { fs.unlinkSync(tmpPath) } catch { /* stale .tmp; harmless */ }
        } else {
          try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
          throw renameErr
        }
      }
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

  // Deploy smoke-test heartbeat (scripts/deploy-local.sh). The RENDERER invokes
  // `shoresh:smoke-ready` from App's mount effect; only then do we write the
  // marker. Reaching this handler proves three things at once that a window
  // event cannot: React actually mounted (the effect ran), the preload bridge
  // is intact, and a renderer→main IPC round-trip works. A build whose main
  // process crashes, whose renderer shell loads but React throws (blank white
  // screen), or whose IPC is broken never gets here, so the gate fails and the
  // deploy rolls back. Entirely gated behind SHORESH_SMOKE_NONCE, so normal
  // dev/test/production runs still call it but write nothing. A write failure
  // must never take startup down over a smoke-test convenience file.
  function writeSmokeMarker() {
    const nonce = process.env.SHORESH_SMOKE_NONCE
    if (!nonce) return
    try {
      const buildInfo = readBuildInfo(__dirname, app.isPackaged)
      const markerPath = path.join(userDataPath, 'deploy-smoke-marker.json')
      const tmpPath = `${markerPath}.tmp`
      fs.writeFileSync(tmpPath, JSON.stringify({ commit: buildInfo.commit, nonce, pid: process.pid, ts: Date.now() }))
      fs.renameSync(tmpPath, markerPath)
    } catch (err) {
      console.error('deploy smoke marker write failed (non-fatal)', err)
    }
  }
  ipcMain.handle('shoresh:smoke-ready', () => {
    writeSmokeMarker()
    return { ok: true }
  })

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
    // NOTE: the deploy smoke-test heartbeat is NOT written here. It is written
    // when the RENDERER calls the `shoresh:smoke-ready` IPC channel from App's
    // mount effect — see writeSmokeMarker() / the handler registration below.
    // That proves React actually mounted AND a main round-trip works, which a
    // `dom-ready` window event (shell parsed, but React may have thrown) does
    // not. A blank-white-screen build therefore fails the gate.
    if (!app.isPackaged) {
      mainWindow.setTitle('Shoresh [DEV]')
    }
    const devServerUrl = process.env.VITE_DEV_SERVER_URL
    if (devServerUrl) {
      mainWindow.loadURL(devServerUrl)
    } else {
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
    }
  }

  app.whenReady().then(() => {
    try {
      createWindow()
    } catch (err) {
      reportStartupFailure(err)
    }
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  } catch (err) {
    reportStartupFailure(err)
  }
}
