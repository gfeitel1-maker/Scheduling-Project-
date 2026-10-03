import { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { randomUUID, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openLocalDb, getOrCreateDeviceId, CURRENT_SCHEMA_VERSION, getSchemaVersion } from './db/localDb.js'
import { createUser, verifySessionToken, attemptLogin, ensureHostSigningKey, issueDeviceToken } from './auth/localAuth.js'
import { promoteToAdmin } from './ops/promoteToAdmin.js'
import { createLocalWriteClient } from './sync/localWriteClient.js'
import { listPendingConflicts, latestOpSeq } from './ops/operations.js'
import { authorize } from './auth/authorize.js'
import { applyUserDataPath } from './db/userDataPath.js'
import { readBuildInfo, formatBuildLabel, readAppVersion, buildAboutPanelOptions } from './buildInfo.js'
import { installMenu } from './menu.js'
import { describeStartupFailure, formatStartupFailureLog } from './startupFailure.js'
import { deriveWriteAction, deriveBulkReplaceAction } from './auth/deriveWriteAction.js'
import { recordAuditEvent } from './audit/auditLog.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES, resolveParentJoinChain } from './ops/campScopedEntities.js'
import { listEntities } from './ops/read.js'
import { listPeerErasureStateFromDb } from './ops/peerErasureState.js'
import { importSetupRows } from './ops/importSetupRows.js'
import { IPC_PIN_FIELDS } from './ops/pinFields.js'
import { listDeleted, getEntityHistory } from './ops/trash.js'
import { RESTORABLE_ENTITIES, restoreEntity, lastKnownFieldSources } from './ops/restore.js'
import { tierForField } from '../src/utils/ruleProvenance.js'
import { CLEARABLE_ENTITIES, previewDelete, deleteRecord, mergeLocation } from './ops/deleteRecord.js'
import { listMigrationReviews, dismissMigrationReviews } from './ops/migrationReviews.js'
import { listOpenReconciliationDecisions, dismissOpenReconciliationDecisions } from './ops/openReconciliationDecisions.js'
import { commitIngest, ingestUndo, listImportEvidence, listCompoundCellDecisions } from './ops/ingest.js'
import { materializeImportedVersion } from './ops/materializeImportedVersion.js'
import { confirmAlias, ConfirmAliasError } from './ops/confirmAlias.js'
import { mergeActivity, previewActivityMerge } from './ops/mergeActivity.js'
import { confirmCompoundCellPattern } from './ops/confirmCompoundCellPattern.js'
import { recordDeclinedSplit, listDeclinedSplitNames } from './ops/declinedSplits.js'
import { recordImportDecisions } from './ops/decisionJournal.js'
import { rememberColumnMapping } from './ops/rememberColumnMapping.js'
import { duplicateWeek } from './ops/duplicateWeek.js'
import { deleteWeek } from './ops/deleteWeek.js'
import { deleteElectiveSet } from './ops/deleteElectiveSet.js'
import { deleteElectiveRun } from './ops/deleteElectiveRun.js'
import { attributeElectiveSubject } from './ops/attributeElectiveSubject.js'
import { deleteSpecialDay } from './ops/deleteSpecialDay.js'
import { deleteEvent } from './ops/deleteEvent.js'
import { listDurableElectiveSets } from './ops/durableElectiveSets.js'
import { commitElectiveRun } from './ops/commitElectiveRun.js'
import { finalizeElectiveRun } from './ops/finalizeElectiveRun.js'
import { setElectiveAssignment } from './ops/setElectiveAssignment.js'
import { setElectivePreference, removeElectivePreference } from './ops/setElectivePreference.js'
import { getElectiveRun } from './ops/getElectiveRun.js'
import { getElectiveRunOuterSchedule } from './ops/getElectiveRunOuterSchedule.js'
import { campHasSetupData } from './ops/campHasSetupData.js'
import { listPendingRestores } from './sync/pendingRestores.js'
import { PROJECTIONS } from './ops/projections.js'
import { createCampDataRecordWriter } from './campDataRecord.js'
import { isAutomergeEngine } from './sync/automerge/syncEngineFlag.js'
import { createAutomergeSyncStarter } from './sync/automerge/syncStarter.js'
import { forgetPeerAddress } from './sync/automerge/peerAddressBook.js'
import { resolveConflictInDoc } from './automerge/reconcile.js'
import { ensureDeviceIdentity } from './auth/deviceIdentity.js'
import { mintGenesisEntry, mintGrantEntry, mintRevokeEntry } from './automerge/authorityLog.js'
import { syncRefusalForDomainMigration } from './db/migrationDomainState.js'
import { getDocIfLoaded, getCurrentDoc, setUserDataDirGetter as setAutomergeUserDataDirGetter, setDocCipher as setAutomergeDocCipher, flushPendingWrites as flushAutomergeDoc } from './sync/automerge/liveDoc.js'
import { projectEntity } from './automerge/projector.js'
import { AUTHORITY_LOG_ENTITY, currentAuthorityState, quorumThreshold } from './automerge/authorityReplay.js'
import * as Automerge from '@automerge/automerge'
import { docPath as automergeDocPath } from './sync/automerge/docStore.js'
import { acquireDocCipher, acquireDbKey, isAtRestEncryptionEnabled } from './db/atRestEncryption.js'
import { unsharedWriteCount } from './ops/documentWriteFailures.js'
import { createDiskSpaceMonitor } from './db/diskSpace.js'
import { codeForAuthRejectedReason } from './authRejectedSender.js'
import { mintJoinSecret, formatJoinCode } from './sync/joinCode.js'
import { startJoinSession } from './sync/automerge/joinSession.js'
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
// every other consumer of the camp-scoped table set stay structurally in step —
// see that module's own comment. The original second consumer was
// syncServer.js's first-pairing full_sync snapshot; that file was deleted in
// Stage 6, and the registry is now shared by the Automerge seed/projector
// (./automerge/seed.js, ./automerge/projector.js), the rollback migrations and
// ./ops/read.js.

// Explicit allowlist for `shoresh:list-by-scope`, deliberately narrower than
// PARENT_SCOPED_ENTITIES: that registry also contains parent-scoped children
// (e.g. special_day_slots, event_slots) which C4 does not target. Gating on
// this set ALONE would let a caller-supplied scope column reach nowhere
// (there is none), but gating on PARENT_SCOPED_ENTITIES alone would silently
// expose those children as scope-listable. Both checks are required.
const SCOPED_LIST_ENTITIES = new Set([
  'template_slots',
  'schedule_snapshots',
  'week_activity_exclusions',
  'week_group_exclusions',
  'week_location_exclusions',
])

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

// T228 — requireAuthorized is the single chokepoint every mutating handler
// goes through, so it is also the one place that can discover a session
// that expired mid-session (the device stayed open past TOKEN_TTL_MS, the
// normal overnight case) without adding a second listener elsewhere. Set
// once by makeHandlers so this module-level function still doesn't need its
// own getMainWindow parameter threaded through ~35 call sites.
let currentMainWindowGetter = () => null

// The exact authorize() denial reasons that mean this session/device can no
// longer act at all — identity or trust is gone, not just this one call.
// Deliberately EXCLUDES db_error, invalid_action, and
// device_token_not_valid_for_authorization: those are a transient
// operational failure or a caller bug, not a session-ended condition, and
// bouncing the director to login for them would hide the real problem
// behind reassuring copy. Those three still throw 'invalid session'
// unchanged, they just don't fire the push.
//
// codeForAuthRejectedReason maps each of these to the close-code useDeviceMode
// already understands. Four are keys in authRejectedSender.js's REASON_TO_CODE;
// 'user_not_found' intentionally is NOT — it takes that function's `?? 4401`
// fallback, which lands on the benign "Your session ended. Please sign in
// again." copy. That is the correct message for a deleted user (re-login is
// exactly the honest next step), so the fallback is deliberate, not an omission.
// It is left out of REASON_TO_CODE on purpose: that table is the network-
// handshake vocabulary (connectionAuth.js), which never emits 'user_not_found',
// and its own drift guard is scoped to that source.
export const SESSION_INVALID_REASONS = new Set([
  'invalid_token',
  'user_not_found',
  'device_not_found',
  'device_not_authorized',
  'device_revoked',
])

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
//
// A SESSION_INVALID_REASONS denial additionally pushes the existing
// 'shoresh:auth-rejected' channel (T228) so useDeviceMode's onAuthRejected
// listener routes the director to the login screen instead of leaving them
// stuck retrying a write that can never succeed. Additive only — the throw
// below is unchanged and still rejects the write.
function requireAuthorized(db, { token, action, resourceId }) {
  const result = authorize({ db, token, action, resourceId })
  if (!result.allowed) {
    if (result.reason === 'forbidden') {
      throw new Error('admin role required')
    }
    if (SESSION_INVALID_REASONS.has(result.reason)) {
      const mainWindow = currentMainWindowGetter()
      if (mainWindow) {
        mainWindow.webContents.send('shoresh:auth-rejected', { code: codeForAuthRejectedReason(result.reason) })
      }
    }
    throw new Error('invalid session')
  }
  return result
}

export function sanitizeOpForIpc(op) {
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

  const { table, parentKey } = PARENT_SCOPED_ENTITIES[entity]
  const { joinSql, campAlias } = resolveParentJoinChain(entity)
  return db
    .prepare(
      `SELECT t.* FROM ${table} t ${joinSql} WHERE ${campAlias}.camp_id = ? AND t.${parentKey} = ?`
    )
    .all(camp.id, scopeId ?? null)
}

// Strips PIN values from an op_conflict message BEFORE it is ever handed to
// webContents.send. This must run in the main process — sanitizing only in
// the renderer (as a pure defense-in-depth measure) is too late, since the
// raw scrypt digest + salt would already have landed in the renderer's heap
// as the IPC event argument by the time renderer code runs.
// A `unique_conflict` message (T243) carries WHOLE records, not a single
// op's value — `users` is one of the four hard-set entities, so both
// records here can carry `pin_hash`/`pin_salt`. sanitizeOpForIpc doesn't
// apply (it strips one op's `.value` keyed on `.entity`/`.field`, and these
// aren't ops), so this is a separate, explicit strip for the same PIN
// fields IPC_PIN_FIELDS already names.
function sanitizeRecordForIpc(entity, record) {
  if (!record || entity !== 'users') return record
  const rest = { ...record }
  for (const field of IPC_PIN_FIELDS) delete rest[field]
  return rest
}

export function sanitizeConflictForIpc(msg) {
  if (!msg) return msg
  if (msg.type === 'unique_conflict') {
    return {
      ...msg,
      existingRecord: sanitizeRecordForIpc(msg.entity, msg.existingRecord),
      incomingRecord: sanitizeRecordForIpc(msg.entity, msg.incomingRecord),
    }
  }
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

// T292 round-2 follow-up (Red Hat MEDIUM test-coverage gap): the will-quit
// flush and the reinitialize/restore dispose-before-close sequences used to
// live inline inside the non-exported Electron entry-point IIFE below, so no
// test could reach them — a future refactor could silently drop one without a
// red gate. Dropping the flush loses the last debounced camp-data write on
// quit; disposing AFTER db.close() arms a debounced timer against a closed
// handle. Lifting each into a tiny exported helper makes the mechanism itself
// testable, and the two db-swap call sites (reinitialize, restore-project)
// stop duplicating the same two-line pattern. See
// docs/work/runs/2026-09-28-t292-camp-data-record-self-maintaining-workbook.md
// ("Findings carried forward").

/**
 * Flush any still-pending debounced camp-data document write before the process
 * exits (T292 round 2 FIX 3). flushCampDataRecord (campDataRecord.js) already
 * catches every failure internally; the extra try/catch here is belt-and-braces
 * so quit can never be blocked by it either way. Called from app's will-quit.
 */
export function flushCampDataRecordOnQuit(liveHandlers) {
  try {
    liveHandlers?.flushCampDataRecord?.()
  } catch (err) {
    console.error('campDataRecord: flush on quit failed (non-fatal):', err?.message ?? err)
  }
}

/**
 * Dispose the camp-data writer BEFORE closing the db it reads from (T292 round 2
 * FIX 5), so its pending debounced timer can never fire against a closed handle.
 * The order is the whole point: dispose first, close second. Called by every
 * db-swap site (reinitialize, restore-project). Both calls are individually
 * guarded so neither a dispose failure nor an already-closed db can propagate.
 */
export function disposeCampDataRecordThenCloseDb(liveHandlers, oldDb) {
  try { liveHandlers?.disposeCampDataRecord?.() } catch { /* ignore */ }
  try { oldDb?.close?.() } catch { /* ignore — db may already be closed */ }
}
export function makeHandlers(db, deviceId, { getMainWindow, dbPath, userDataPath: _userDataPath, getAutomergeSyncNode, getAutomergeStartupAttempted, onCampBootstrapped, onCampJoined, retrySync } = {}) {
  // Both default to safe no-ops so every existing caller/test that doesn't
  // pass them (there are many) is unaffected — Stage 5d-2b additions only,
  // never a behavior change for a caller that stays silent about them.
  const getAutomergeNode = getAutomergeSyncNode || (() => null)
  // T268 — "has a startup attempt finished" (see startAutomergeSyncNodeIfEnabled
  // in main.js's top-level app.whenReady() flow). Defaults to false ("not yet
  // attempted") so a caller that never wires this — every existing test, and
  // the split-off restore-db/reconciliation handlers below — sees the SAME
  // 'host' fallback getSyncStatus() always returned, rather than a new
  // 'host-not-syncing' state nobody asked for.
  const getAutomergeStartupAttemptedFn = getAutomergeStartupAttempted || (() => false)
  // T273 — invoked once by bootstrapCamp, after the camp exists and this
  // device has authorized itself. On a first run there is no camp at
  // app.whenReady(), so startAutomergeSyncNodeIfEnabled returns early and
  // nothing ever called it again: the device that CREATES a camp — the one
  // displaying the pairing code — silently never synced until restart.
  // Defaults to a no-op so every existing caller is unaffected.
  const onCampBootstrappedFn = onCampBootstrapped || (() => {})
  // T274 — the join-path mirror of T273's onCampBootstrapped. Invoked once by
  // joinAwaitData, after the joined camp's document has actually landed and
  // the temporary join-session node has been stopped (see joinAwaitData
  // below for why the stop must happen first: the join node and the
  // persistent node share this device's libp2p peer identity, keyed by db —
  // ensureDeviceIdentity — not by which node started it, so running both at
  // once would be the same peer identity live twice). Defaults to a no-op so
  // every existing caller is unaffected.
  const onCampJoinedFn = onCampJoined || (() => {})
  // T275 — the retry affordance's handler. A thin re-invocation of the same
  // starter onCampBootstrapped/onCampJoined already call: the starter's own
  // idempotency guard, join funnel guard and TOCTOU latch (T274/T276) make a
  // spammed or concurrent retry safe without any new logic here. Defaults to
  // a no-op so every existing caller (every test, plus the reinitialize/
  // restore-db call sites that don't wire sync) is unaffected. The real
  // outcome surfaces via the next pushSyncStatus, never via this ack.
  const retrySyncFn = retrySync || (() => {})
  // T228 — requireAuthorized is module-level (not a closure over this call's
  // getMainWindow), so the last makeHandlers call to run wins here. That
  // matches every other caller of getMainWindow in this file, which is
  // always the single real mainWindow reference threaded through main.js's
  // one long-lived call, plus test-only extra calls that don't rely on the
  // push firing.
  currentMainWindowGetter = getMainWindow || (() => null)
  // Alias to avoid shadowing the import; callers pass userDataPath as an option
  // so backups from within makeHandlers (bulkReplace) land in the same
  // {userData}/backups/ directory as user-initiated backups.
  const handlersUserDataPath = _userDataPath
  // T160 — the disk this camp is written to. Watching the userData directory
  // rather than the process cwd: that is where BOTH the SQLite file and the
  // Automerge document live, and it is the filesystem whose exhaustion takes
  // the write path down (see diskSpace.js for why the only useful lever is
  // noticing early). Falls back to the db's own directory, then to cwd, so a
  // caller that passes neither still gets a real answer instead of silence.
  const diskMonitor = createDiskSpaceMonitor({
    dir: handlersUserDataPath || (dbPath ? path.dirname(dbPath) : process.cwd()),
  })
  ensureDeviceRow(db, deviceId)

  // T292 — the read-only camp data document (Documents/Shoresh/<camp> data.xlsx).
  // One writer per makeHandlers call, wired additively in wireOpApplied below
  // alongside the existing onOpApplied push (never replacing it — that
  // listener array is multi-subscriber, see localWriteClient.js). Best-effort
  // and non-blocking by construction (see campDataRecord.js); a failure here
  // never affects the op-apply path that triggered it.
  // Round 2 follow-up (found while re-running the suite for this ticket's
  // fixes): makeHandlers is called directly, with a real db, from
  // electron/main.test.js's 233+ cases — there is no Electron app around it
  // to sandbox a real filesystem path the way electron:dev's separate
  // shoresh-dev userData directory does for SQLite (see CLAUDE.md). Without
  // this guard, `npm test` would schedule real debounced writes into the
  // machine's ACTUAL ~/Documents/Shoresh folder. Redirect to a per-process
  // tmp directory under Vitest; production (no VITEST env var) is unaffected.
  const documentsDir = process.env.VITEST
    ? path.join(os.tmpdir(), 'shoresh-test-documents')
    : path.join(os.homedir(), 'Documents')
  const campDataRecordWriter = createCampDataRecordWriter({
    db,
    documentsDir,
    isDev: !app.isPackaged,
  })

  let syncClient = null
  let modeChosen = false
  let mode = null

  function wireOpApplied() {
    // T292 round 2 FIX 4: registered FIRST, before the renderer-push listener
    // below. notifyOpApplied's fan-out (localWriteClient.js) has no
    // per-listener try/catch, so an exception in one listener starves every
    // listener registered after it — putting the writer first means a
    // misbehaving renderer-push can never prevent the document from being
    // scheduled.
    //
    // This covers LOCAL writes only (write()/writeBulkReplace() are the only
    // callers of notifyOpApplied). A REMOTE merge (another device's edit
    // arriving over libp2p) never calls onOpApplied at all — that path is
    // wired separately, in syncStarter.js's onRemoteOps, via
    // scheduleCampDataRecord below (round 2 FIX 2).
    //
    // onFullSyncApplied is deliberately NOT used here: fullSyncAppliedListeners
    // (localWriteClient.js) is pushed to but never invoked anywhere in this
    // codebase — it was dead before this ticket, and wiring a writer to a
    // signal that never fires would just be an inert no-op, not a real path.
    syncClient.onOpApplied(() => campDataRecordWriter.schedule())
    syncClient.onOpApplied((op) => {
      const mainWindow = getMainWindow ? getMainWindow() : null
      if (mainWindow) mainWindow.webContents.send('shoresh:op-applied', sanitizeOpForIpc(op))
    })
    // Fire once immediately: by the time wireOpApplied runs (bootstrapCamp's
    // post-creation path, or the returning-device login path), a camp already
    // exists, so the document is born without waiting for the first op.
    campDataRecordWriter.schedule()
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

  // Deliberately NOT wrapped in authorize(). `src/hooks/useDeviceMode.js`
  // calls chooseMode() as part of its pre-login init effect (before
  // verifySession is even attempted), and again from bootstrapCamp() on the
  // Bootstrap screen, both of which render before `phase === 'session'`.
  // There is no session to derive a role from at this point in the flow —
  // same category as login/verify-session, per the ADR's open question,
  // resolved here by reading the actual call sites rather than
  // T16 — commit an import the director approved in the preview. Admin only:
  // it creates setup records in bulk, which is the same authority the setup
  // screens already require.
  // `mode` is renamed on the way in. The closure already has a `mode` — this
  // device's sync mode — and the guard below reads it; a shadowing parameter
  // would silently turn the Host check into a comparison against the import
  // mode instead.
  // NOT declared async: every existing caller (and test) calls this
  // synchronously and reads the outcome off the return value directly. When
  // `placements` is present this returns a Promise instead (ipcMain.handle
  // and localClient both already await/resolve their handler's return value
  // either way) — but every pre-T117 caller, which never passes placements,
  // keeps getting the outcome object back synchronously, unchanged.
  function ingestCommit({ token, approved, links, clears, humanEditedFields, cohort_id, fixedEvents, activityRules, mode: ingestMode, resolutions, base_generation, seenCounts, pinOnlyActivityNames, captureInverse, electiveHeaderFindings, activityPeriods, confirmedElectiveSets, multiBlockEvents, placements, compoundCellDecisions, divisionSupport } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    // Admin only. Staff may edit setup records one at a time; creating a
    // camp's whole structure in one action is a different kind of authority,
    // and 'groups.import' is deliberately absent from the staff permission
    // list so admin: ['*'] is what grants it.
    const session = requireAuthorized(db, { token, action: 'groups.import' })
    // HOST ONLY, both modes (T61). commitIngest appends every op straight to
    // THIS device's SQLite rather than routing through syncClient.write (the
    // localWriteClient instance — the variable name predates Stage 6c and no
    // longer refers to a WebSocket client).
    //
    // ⚠️ _Prior, and the stated RATIONALE is now doubtful rather than merely
    // re-worded: the gate was justified because "an import run on a Client is
    // invisible to the Host and every peer — under Replace that silently forks
    // the whole camp while showing a success banner", and because "a Client
    // cannot express a multi-op atomic transaction over submit_op". submit_op was
    // deleted at the Stage 6c cutover. More importantly, the invisibility premise
    // no longer holds: appendOp mirrors each write into the Automerge document,
    // so an import committed on a join-mode device WOULD now replicate. The gate
    // does still have an independent live justification — ingest reads and writes
    // host-local tables that are deliberately never replicated (source_aliases,
    // compound_cell_decisions, location_word_decisions, declined_two_row_splits)
    // — but that is not the reason recorded here. Restating the gate's rationale,
    // or deciding whether it should still be host-only at all, is a product
    // judgement and NOT something a comment sweep should settle; T311 records it._
    // Refused outright
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
    const outcome = commitIngest(db, {
      approved,
      links,
      // T114 follow-up — per-group division provenance (why this bunk is in
      // this division), written as import_evidence. Inference support only:
      // a division the file STATED is filtered out renderer-side.
      divisionSupport: divisionSupport ?? {},
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
      // written as fixed_events (T34). Defaults to none.
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
      // Slice 3a — plain data extractEntities computed client-side, carried
      // through unchanged to buildPlan's buildElectiveCandidates.
      electiveHeaderFindings: electiveHeaderFindings ?? [],
      activityPeriods: activityPeriods ?? {},
      confirmedElectiveSets: confirmedElectiveSets ?? [],
      // Slice B (docs/adr/2026-08-24-merged-cell-multiblock-ingest.md
      // addendum) — director-confirmed one-off multi-block candidates,
      // written as `events` catalog rows only (surface-then-fill). Absent
      // for every caller that predates this, same as fixedEvents above.
      multiBlockEvents: multiBlockEvents ?? [],
      // U1 — additive, opt-in. Absent/false for every existing caller, same
      // behavior as before (docs/adr/2026-08-17-onescreen-reconciliation-undo.md).
      captureInverse: captureInverse === true,
    })
    // T118 slice 4 — the director's freshly-resolved compound-cell-pattern
    // decisions (ImportScreen's "Cells We Weren't Sure About"), written to the
    // per-camp learned table AFTER the catalog commit above succeeds, same
    // "already landed, must not be reported as failed" seam as
    // materializeImportedVersion below. Per-item try/catch: one bad decision
    // must not block the others or make the whole import look like it failed.
    if (Array.isArray(compoundCellDecisions) && compoundCellDecisions.length > 0) {
      const written = { count: 0, failed: [] }
      for (const decision of compoundCellDecisions) {
        try {
          confirmCompoundCellPattern(db, {
            camp_id: camp.id,
            pattern: decision.pattern,
            interpretation: decision.interpretation,
            base_name: decision.base_name ?? null,
            wrapper_name: decision.wrapper_name ?? null,
            confirmed_by: session.userId,
          })
          written.count += 1
        } catch (err) {
          console.error('confirmCompoundCellPattern failed (non-fatal, catalog import still succeeded)', err)
          written.failed.push(decision.pattern)
        }
      }
      outcome.compoundCellDecisionsWritten = written
    }
    // T117 slice 2 — the grid placements the import captured (capturePlacements.js
    // on the renderer side), materialized into a saved version AFTER the catalog
    // commit above succeeds. Never rethrown: the catalog import already landed and
    // must not be reported as failed because the version step had trouble.
    if (Array.isArray(placements) && placements.length > 0) {
      return materializeImportedVersion(db, syncClient, {
        campId: camp.id, authorUserId: session.userId, placements,
      }).then((version) => {
        outcome.version = version
        return outcome
      }).catch((err) => {
        console.error('materializeImportedVersion failed (non-fatal, catalog import still succeeded)', err)
        outcome.version = { created: false, snapshotId: null, unresolvedCount: placements.length, unresolvedNames: [] }
        return outcome
      })
    }
    return outcome
  }

  // D1 (dry-run reconciliation, docs/adr/2026-08-10-...ingestion-phaseD...).
  // Same auth gate as ingestCommit, but NOT the Host-only 'mode === client'
  // guard above — a dry run commits nothing anywhere, on any device, so there
  // is no fork-the-camp risk to guard against. Also does not push any
  // onOpApplied/sync broadcast: nothing was written for a peer to learn about.
  function ingestReconcile({ token, approved, links, clears, humanEditedFields, cohort_id, fixedEvents, activityRules, mode: ingestMode, resolutions, base_generation, seenCounts, pinOnlyActivityNames, electiveHeaderFindings, activityPeriods, multiBlockEvents, divisionSupport } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = requireAuthorized(db, { token, action: 'groups.import' })
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) throw new Error('no camp on this device')
    const outcome = commitIngest(db, {
      approved,
      links,
      // T114 follow-up — per-group division provenance (why this bunk is in
      // this division), written as import_evidence. Inference support only:
      // a division the file STATED is filtered out renderer-side.
      divisionSupport: divisionSupport ?? {},
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
      electiveHeaderFindings: electiveHeaderFindings ?? [],
      activityPeriods: activityPeriods ?? {},
      multiBlockEvents: multiBlockEvents ?? [],
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
      unknownFieldEvidence: outcome.unknownFieldEvidence ?? {},
      electiveCandidates: outcome.electiveCandidates ?? [],
    }
  }

  // U1 (docs/adr/2026-08-17-onescreen-reconciliation-undo.md) — reverts the
  // field-update half of an import the director just committed. Same
  // authority as ingestCommit (an undo is itself a set of writes to the camp's
  // setup) and the SAME Host-only gate for the SAME reason: it writes straight to
  // this device's SQLite via appendOp, never through syncClient.write. _Prior:
  // "so on a Client it would be invisible to the Host and every peer" — see the
  // ⚠️ note on ingestCommit above; that premise no longer holds under the CRDT
  // path, and the gate's live justification is the host-local tables instead._
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

  // Slice 2a (two-rows split decline-memory) — record that the director said
  // "not now" to a split suggestion, so re-import does not re-suggest it.
  // 'declined_two_row_splits.record' is granted to staff (electron/auth/
  // permissions.js) alongside admin — staff already hold 'activities.write'
  // and can execute a Split themselves, so their decline must not silently
  // fail (Slice 2b Red Hat HIGH #2). HOST ONLY (direct SQL, no op-log — see
  // confirmAliasHandler's comment).
  function recordDeclinedSplitHandler({ token, activityName } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'declined_two_row_splits.record' })
    if (mode === 'client') {
      throw new Error('Declining a split suggestion can only be done on the main computer.')
    }
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) throw new Error('no camp on this device')
    recordDeclinedSplit(db, { campId: camp.id, activityName })
    return { ok: true }
  }

  // T173 slice 1 — best-effort journal of what the importer ASKED and what
  // the director did about it (docs/superpowers/specs/
  // 2026-09-15-seedlings-importer-learning-design.md). Same 'groups.import'
  // gate as ingestCommit/listCompoundCellDecisions: only the director running
  // an import calls this. `recordImportDecisions` itself never throws — this
  // handler can still throw on a bad token/permission, same as every other
  // gated handler, but never on the journal write itself.
  function recordImportDecisionsHandler({ token, entries } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = requireAuthorized(db, { token, action: 'groups.import' })
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return { ok: true }
    recordImportDecisions(db, { campId: camp.id, actorUserId: session.userId, entries })
    return { ok: true }
  }

  // T312 — remember the column mapping a director just confirmed, so the next
  // sheet from the same form arrives pre-filled.
  //
  // GATED ON `camp_seedlings.write`, which is ADMIN-ONLY BY DEFAULT-DENY rather
  // than by a hand-written role check: the entity is deliberately absent from
  // permissions.js ENTITIES, so authorize() refuses staff without this handler
  // restating the rule. Same mechanism the participant domain uses (ADR D9), and
  // deliberately NOT the `groups.import` gate its neighbour above carries --
  // that one is staff-reachable, and a seedling decides how every future import
  // of this camp's sheets is read.
  //
  // Best-effort by CALLER, not by swallowing: this returns its error, and the
  // panel treats a failure as "not remembered" rather than failing the import,
  // which has already succeeded by the time this is called.
  function rememberColumnMappingHandler({ token, matchKey, payload } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = requireAuthorized(db, { token, action: 'camp_seedlings.write' })
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return { ok: false, error: 'NO_CAMP' }
    if (!isNonEmptyString(matchKey)) throw new Error('matchKey is required')
    if (!payload || typeof payload !== 'object') throw new Error('payload is required')
    return rememberColumnMapping(db, {
      campId: camp.id, matchKey, payload,
      authorUserId: session?.userId ?? null, deviceId,
    })
  }

  // Slice 2a — the names ImportScreen filters dualUseNames through before
  // rendering the split-suggestion affordance. Read-only, same staff-reachable
  // gate as the write above. NOTE: import review is NOT admin-gated end to
  // end — Sidebar.jsx's ADMIN_MENU_ITEMS is misnamed and does not actually
  // gate nav to Import, so staff can reach this screen (Slice 2b Red Hat
  // HIGH #2); that's exactly why this action is staff-reachable now instead
  // of admin-only.
  function listDeclinedSplitNamesHandler({ token } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'declined_two_row_splits.record' })
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return []
    return Array.from(listDeclinedSplitNames(db, { campId: camp.id }))
  }

  // T118 slice 4 — read-only, same 'groups.import' gate as ingestCommit (this
  // is only ever read from the ImportScreen at parse time, by the same
  // director who is about to run an import). IPC can't carry a Map, so this
  // returns plain [pattern, { interpretation, base_name, wrapper_name }]
  // entries; localClient.js re-wraps them into a Map for extractEntities.
  function listCompoundCellDecisionsHandler({ token } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'groups.import' })
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return []
    return Array.from(listCompoundCellDecisions(db, camp.id).entries())
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
  //
  // T275 — the retry affordance's handler (sidebarState.js's host-not-syncing
  // "try again"). Deliberately a bare re-invocation, not awaited: the ack is
  // a formality (the renderer never reads its fields), and the real outcome
  // is the next pushSyncStatus the starter's own finally block already fires
  // on settle. Nothing here decides success/failure — reflecting that from
  // this return value would risk telling the director something the next
  // real getSyncStatus push contradicts.
  function retrySyncHandler() {
    retrySyncFn()
    return { ok: true }
  }
  function getSyncStatus() {
    // The disk filling up, noticed while there is still room to act (T160).
    // Throttled inside the monitor — getSyncStatus is called on mount and on
    // every push, and free space does not change meaningfully in a second.
    // `low: false` covers "could not measure", which must render as silence
    // rather than as reassurance (diskSpace.js).
    const disk = diskMonitor.read()

    // Writes this device holds that the authoritative document does not (T153).
    // Reported on EVERY state including standalone and host, because it is not a
    // connectivity fact: a lone device with a failed document write is diverged
    // from the camp whether or not anyone is reachable, and the offline copy
    // ("your changes will reach it when it is back") is exactly the sentence
    // that must not be shown for these.
    const unsharedWrites = unsharedWriteCount(db)

    // Is any OTHER computer holding a copy of this camp (T176)?
    //
    // This became load-bearing when at-rest encryption was scoped
    // (docs/current/KEY_RECOVERY_STORY.md). That page's one real-loss case is a
    // camp whose only device is lost: the storage key goes with the machine and
    // the data is unreadable even to its owner, by design, because a
    // director-remembered passphrase was rejected as the worse day. Its
    // mitigation is operational rather than cryptographic — *keep more than one
    // device paired and synced* — and a second synced device is not a backup
    // step someone has to remember, it IS the backup, continuously.
    //
    // That advice is only actionable if a director can tell at a glance that
    // they have not followed it. Until now the count lived behind the Devices
    // screen, which is where you go once you already suspect something.
    //
    // COUNTED, DELIBERATELY, as "authorized and not revoked" — not "a row
    // exists". `devices` carries inert `pairing_status='unknown'` stubs for any
    // peer this device merely HEARD an op from (see listDevices), and a revoked
    // device is one the director deliberately cut off. Neither holds a usable
    // copy, and counting either would answer "you have a second copy" when the
    // camp does not. The question is about a SURVIVING COPY, not about rows.
    const otherDeviceCount = db
      .prepare(
        "SELECT COUNT(*) AS n FROM devices WHERE id != ? AND authorized_at IS NOT NULL AND revoked_at IS NULL"
      )
      .get(deviceId).n

    // T268 — a refused sync (electron/db/migrationDomainState.js) is checked
    // BEFORE branching on mode: a refused Client is just as blind as a
    // refused Host, and this must never read as connected/healthy for
    // either. `docExists` reuses the exact expression the startup guard uses
    // (fs.existsSync(automergeDocPath(...))) via syncRefusalForDomainMigration
    // — one notion of "a document exists", not two. Strictly read-only: this
    // helper never seeds, resolves, or writes anything (see its own doc
    // comment in migrationDomainState.js) — getSyncStatus's whole contract is
    // that a status read cannot change durable state.
    const campId = db.prepare('SELECT id FROM camps LIMIT 1').get()?.id ?? null
    const docExists = campId ? fs.existsSync(automergeDocPath(handlersUserDataPath, campId)) : false
    const refusal = syncRefusalForDomainMigration(db, { docExists })
    if (refusal) {
      // T268 round 2 (Finding 3): `refusal.detail` is NOT included here — it
      // can carry raw migration-marker JSON (entity ids included, see
      // electron/db/localDb.js's domain_state_migration_pending) across a
      // token-less IPC boundary to the renderer, and nothing under src/
      // consumes it. The sidebar only needs `syncBlocked`/`state`. The
      // startup guard's console.error and audit `reason` still read
      // `refusal.detail` directly (see startAutomergeSyncNodeIfEnabled above)
      // — this is only about what crosses the IPC boundary.
      return {
        mode,
        connected: false,
        state: 'sync-blocked',
        syncBlocked: true,
        unsharedWrites,
        lowDisk: disk.low,
        otherDeviceCount,
      }
    }

    if (!modeChosen) return { mode: null, connected: false, state: 'standalone', unsharedWrites, lowDisk: disk.low, otherDeviceCount }
    if (mode === 'host') {
      // T268: `connected: true, state: 'host'` used to be unconditional here —
      // a Host that failed to start its sync node (refusal aside; e.g. the
      // automerge engine is on but the node genuinely is not running) still
      // read as healthy. Now derived from whether a node is ACTUALLY running,
      // not from whether a mode was chosen.
      if (!isAutomergeEngine() || getAutomergeNode() != null || !getAutomergeStartupAttemptedFn()) {
        // Either the op-log engine is in use (unaffected, always 'host'), or a
        // node is running, or a startup attempt has not finished yet — the
        // last case exists to avoid a boot flicker: the node starts
        // asynchronously after app.whenReady(), so "not yet attempted" must
        // read the same as it always has, not as a false alarm.
        return { mode: 'host', connected: true, state: 'host', unsharedWrites, lowDisk: disk.low, otherDeviceCount }
      }
      return { mode: 'host', connected: false, state: 'host-not-syncing', unsharedWrites, lowDisk: disk.low, otherDeviceCount }
    }
    // Stage 6c: the honest source of "can this device reach the camp" is the
    // libp2p node's peer set, not a socket. `getPeers()` returns every
    // libp2p-connected peer INCLUDING one that merely completed a noise
    // handshake and never authenticated (transport.js is explicit about this),
    // so the two counts below preserve exactly the distinction T87 introduced:
    // transport-open is not the same as admitted to the camp, and the sidebar's
    // "linked" copy must not overclaim.
    const node = getAutomergeNode()
    const peers = node ? node.getPeers() : []
    const connected = peers.length > 0
    const authed = peers.some((peerId) => node.isPeerAuthenticated(peerId))
    const state = !connected ? 'client-disconnected' : (authed ? 'client-connected' : 'client-connecting')
    return { mode: 'client', connected, authenticated: authed, state, unsharedWrites, lowDisk: disk.low, otherDeviceCount }
  }

  // T27 — push the status when it changes, rather than leaving the renderer to
  // poll. Without this the sidebar would show whatever was true at mount.
  function pushSyncStatus() {
    const mainWindow = getMainWindow ? getMainWindow() : null
    if (mainWindow) mainWindow.webContents.send('shoresh:sync-status-changed', getSyncStatus())
  }

  function chooseMode(args) {
    // `campName` is still sent by the renderer (bootstrap passes it through to
    // bootstrapCamp) but is deliberately NOT read here: LAN discovery is
    // camp-scoped by an opaque hash of the camp id and never carries the name
    // (electron/sync/automerge/discovery.js).
    const { mode: requestedMode, token } = args || {}
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
      // Stage 6c: no WebSocket server, and no separate mDNS advertisement. The
      // libp2p node does its own camp-scoped discovery
      // (electron/sync/automerge/discovery.js), so a Host no longer runs a
      // second announcement alongside it.
      // Auto-authorize the Host device if its devices row lacks authorized_at.
      // Pre-trust-system DBs were bootstrapped before authorize() existed, so
      // bootstrapCamp never stamped it. Do this at mode-selection time so it
      // applies to both fresh logins AND stored-session restores (which bypass
      // the login handler entirely but still call chooseMode on every startup).
      db.prepare(
        "UPDATE devices SET authorized_at = COALESCE(authorized_at, ?), pairing_status = 'authorized' WHERE id = ?"
      ).run(new Date().toISOString(), deviceId)
      syncClient = createLocalWriteClient(db, { device_id: deviceId, author_user_id: null })
      wireOpApplied()
      // Stage 5d-2b: the automerge/libp2p node (if running) also needs this
      // Host's own token to authenticate itself to any Client it discovers
      // — startAutomergeSyncNodeIfEnabled already tries to self-issue one at
      // startup, but the Host device row may not have been auto-authorized
      // yet at that point (the UPDATE above just did it, for the FIRST
      // time), so retry here where it's guaranteed to succeed.
      //
      // Finding 2 fix: issueDeviceToken, NOT issueCampToken(db, null,
      // deviceId) — a 'camp' token requires a real userId (verifySessionToken
      // rejects a null one outright), so the old call always minted a token
      // that could never verify. issueDeviceToken mints a distinct
      // admission-only token with no userId — see its doc comment.
      try {
        getAutomergeNode()?.setAuthToken(issueDeviceToken(db, deviceId))
      } catch {
        // Still not the Host (no host_signing_key) — unreachable in
        // practice on this branch, but never worth throwing over.
      }
    } else {
      // Stage 6c: a Client is no longer a different kind of device. It writes
      // locally exactly as a Host does, and its writes reach the camp because
      // every device holds the whole document — not because a server accepted
      // them. There is no serverUrl, no socket, and no pairing callbacks over
      // WS; joining happens through the camp code
      // (docs/adr/2026-09-08-libp2p-join-flow.md) and pairing decisions arrive
      // over libp2p.
      syncClient = createLocalWriteClient(db, { device_id: deviceId, author_user_id: null })
      wireOpApplied()
      // Stage 5d-2b: a returning device that already holds a token hands it to
      // the libp2p node so it can authenticate to peers without a fresh login.
      if (isNonEmptyString(token)) {
        getAutomergeNode()?.setAuthToken(token)
      }
    }

    mode = requestedMode
    modeChosen = true

    return { mode: requestedMode }
  }

  async function login({ name, pin } = {}) {
    if (!isNonEmptyString(name) || !isNonEmptyString(pin)) {
      throw new Error('name and pin are required')
    }

    // Stage 6c: login is local on every device. `users` is a modeled document
    // entity, so a joined device already holds the camp's roster and can verify
    // a PIN against its own database — there is no Host to ask.
    //
    // A device that has NOT joined has no roster to check against, and that is
    // the join flow's job rather than this handler's: JoinByCodeScreen ->
    // startJoinSession performs the first login against the Host over libp2p
    // and writes the camp row (docs/adr/2026-09-08-libp2p-join-flow.md). The
    // WebSocket loginRemote round-trip this replaces existed only because a
    // Client had no local roster to check.
    if (mode === 'client') {
      const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      if (!camp) {
        return { offline: true, reason: 'Join the camp from this device before signing in.' }
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

  // T163 (owner decision 2026-09-14, SECURITY.md T150) — the ONLY path that
  // may turn a staff user into an admin. write() (below) explicitly refuses
  // entity:'users' field:'role' value:'admin' and names this handler, so a
  // role promotion can never bypass the fresh-PIN requirement enforced here
  // (promoteToAdmin/assertValidPin — electron/ops/promoteToAdmin.js).
  async function promoteToAdminHandler({ token, userId, newPin } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId: actorUserId } = requireAuthorized(db, { token, action: 'users.promote' })
    if (!isNonEmptyString(userId)) throw new Error('userId is required')
    return promoteToAdmin(db, { userId, newPin, actorUserId, deviceId })
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

    // T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) — the axiomatic genesis
    // entry: this device, by virtue of being the one that just created the camp, IS the founder.
    // No signature (axiomatic, per the ADR) — just this device's own device_identity_key PEER ID,
    // so every OTHER device can later verify entries this founder signs. Best-effort: a camp that
    // bootstrapped successfully must never be reported as failed because this mint hiccuped (same
    // non-fatal posture as the sync-node-start try/catch directly below) — the founder's own
    // admin status falls back to (re-)resolving on the next projection pass once this succeeds.
    try {
      const { peerId: founderPeerId } = await ensureDeviceIdentity(db)
      mintGenesisEntry(db, { founderDeviceId: deviceId, founderPeerId })
      projectAuthorityLogLocally()
    } catch (err) {
      console.error(`bootstrapCamp: minting the genesis authority entry failed (non-fatal): ${err?.message ?? err}`)
    }

    // A Host trivially has 100% of its own data from the instant of its own
    // bootstrap — it never syncs FROM another device, so it must never be
    // gated by the first-sync write-gate (design doc Part 4.1/4.3, slice 2).
    // Migration v22's backfill only covers a camp that already existed at
    // migration time; a brand-new bootstrap (this path) needs its own set.
    db.prepare(
      'UPDATE device_identity SET first_sync_completed_at = COALESCE(first_sync_completed_at, ?)'
    ).run(new Date().toISOString())

    // T273 — start syncing now, in this session. Deliberately NOT awaited:
    // the renderer's bootstrap screen awaits bootstrapCamp, and libp2p
    // startup takes as long as it takes. The starter already swallows its own
    // errors and pushes sync status to the renderer from its own `finally`;
    // this call site is defensive anyway, on both the synchronous throw and
    // the rejected-promise paths, because a camp that was successfully
    // created must never be reported as a failed bootstrap.
    try {
      Promise.resolve(onCampBootstrappedFn()).catch((err) => {
        console.error(`sync node start after bootstrap failed (non-fatal): ${err?.message ?? err}`)
      })
    } catch (err) {
      console.error(`sync node start after bootstrap failed (non-fatal): ${err?.message ?? err}`)
    }

    // T292 — the camp now exists on this device. createUser above already fired
    // onOpApplied (→ schedule()), so the data document is in practice already
    // born; this explicit schedule() makes the spec §1.1 "born the moment a camp
    // exists" guarantee DIRECT rather than incidental to createUser's write path.
    campDataRecordWriter.schedule()

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
    // the FK stub-seed (the self-registration path now in connectionAuth.js's
    // evaluateAuthenticate — _prior: "handleAuthenticate's", in the syncServer.js
    // deleted at Stage 6c — plus the op-apply FK backfill) creates real `devices` rows with
    // pairing_status='unknown' for every peer a device merely HEARS an op
    // from — never a device that actually paired with this one. These rows
    // are inert (never authorized, already excluded from
    // listPendingPairingRequests above) but would otherwise surface in the
    // Device Manager list as phantom "Device xxxxxxxx / Not set up yet"
    // rows on every multi-device camp. Excluded here, not at the schema
    // level, so this stays scoped to the management-list read.
    const rows = db.prepare("SELECT id, name, pairing_status, authorized_at, revoked_at, last_synced_at FROM devices WHERE pairing_status IS NOT 'unknown'").all()

    // T332 fold-in (data contract for the "Removal pending" UI state) — the SAME derived
    // replay state revokeDevice's own truth-in-UI gate reads (authorityReplay.js's
    // currentAuthorityState), never recomputed independently here: admins is the current
    // granted set (includes a target until quorum actually removes it), votes is
    // target -> Map<signer, surviving-vote-hashes> for outstanding quorum votes. A device that
    // was never granted/targeted gets no EXTRA fields (effectiveState/votesNeeded/votesCast/
    // hasVoted) — this is additive, and leaves the ordinary revoked_at-only row shape untouched
    // for every non-admin device. `isSelf`, though, is added to EVERY row, admin or not: the
    // self-target guard in revokeDevice (electron/main.js) refuses a self-revoke regardless of
    // whether the target is an admin, so the UI's self-exclusion needs the same signal on every
    // row, not only the admin-targeted ones.
    const doc = getCurrentDoc(db)
    let authorityState = null
    if (doc) {
      try {
        authorityState = currentAuthorityState(Automerge, doc)
      } catch (err) {
        console.error(`listDevices: computing authority state failed (non-fatal, admin rows fall back to pairing_status): ${err?.message ?? err}`)
      }
    }

    return rows.map((row) => {
      const isSelf = row.id === deviceId
      if (!authorityState) return { ...row, isSelf }

      const isCurrentAdmin = authorityState.admins.has(row.id)
      const votersForTarget = authorityState.votes.get(row.id)
      const wasEverTargeted = isCurrentAdmin || !!votersForTarget
      if (!wasEverTargeted) return { ...row, isSelf }

      const votesCast = votersForTarget ? votersForTarget.size : 0
      const votesNeeded = quorumThreshold(authorityState.admins.size)
      const effectiveState = !isCurrentAdmin ? 'removed' : votesCast > 0 ? 'removal_pending' : 'active'
      return {
        ...row,
        effectiveState,
        votesNeeded,
        votesCast,
        hasVoted: !!votersForTarget?.has(deviceId),
        isSelf,
      }
    })
  }

  // T322 S3b — read-only per-peer erasure state for the Device Manager badge.
  // Returns, per peer device, LOGICALLY_ERASED vs UNKNOWN for the camp's purge-
  // tombstones (docs/work/tickets/T322-per-peer-erasure-state-ui.md). Same
  // `devices.read` gate as listDevices; it reads the receiver-side self-report
  // table written only by S3a's authenticated handshake and takes no action —
  // never a per-peer write, never revocation. The local device is excluded (it
  // never self-reports and is not a propagation target).
  function listPeerErasureState({ token } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'devices.read' })
    return listPeerErasureStateFromDb(db, { localDeviceId: deviceId })
  }

  // The atomic setup-import door (board q-atomic-import-primitive, part 2). The
  // seven setup screens resolve a preview into a confirmed create/update batch
  // and commit it here in ONE call; importSetupRows wraps the whole set in one
  // runAtomic frame, so a mid-set failure rolls everything back (the DB is
  // byte-identical to before) and names the row that failed. This is exactly the
  // authority of the per-field setup writes it replaces — `<entity>.write`,
  // staff+admin — so it is authorized the same way and is deliberately NOT
  // Host-only (staff edit setup on any device; a batch of the same writes is no
  // different). Credential/role fields never travel this path (the doors only
  // ever send setup entities), so write()'s users.* guards are not duplicated.
  function importSetupRowsHandler({ token, rows } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows must be a non-empty array')
    const entities = [...new Set(rows.map((row) => row?.entity).filter(Boolean))]
    if (entities.length === 0) throw new Error('every import row must name an entity')
    // Authorize each distinct entity's write; capture the session userId for
    // op authorship. Every entity must pass — a batch is all-or-none, so a
    // caller may not smuggle an unauthorized entity in alongside an authorized one.
    let userId = null
    for (const entity of entities) {
      ({ userId } = requireAuthorized(db, { token, action: `${entity}.write` }))
    }
    const result = importSetupRows(db, { rows, author_user_id: userId, device_id: deviceId })
    // Regenerate the read-only camp-data export workbook on a clean commit,
    // mirroring the onOpApplied fan-out the per-field write path triggered.
    if (result.ok) campDataRecordWriter.schedule()
    return result
  }

  // T331 — after minting a camp_authority_log entry on THIS device, the generic op-log dual-write
  // (appendOp -> recordLocalWrite) has updated the shared DOCUMENT, but nothing re-runs the
  // projector for an entity with no PROJECTIONS registration (applyProjection no-ops for it — see
  // campDocument.js's EXTRA_MODELED_ENTITIES comment). Unlike every registered entity, whose SQL
  // side is already correct the instant appendOp returns, camp_authority_log's derived
  // applied_authority_log/authority_cache need an explicit projection pass on the ORIGINATING
  // device too — a remote peer gets this for free from syncNode.js's own projectAndNotify/
  // handleSyncMessage once the entry syncs out, but this device must not wait for its own round
  // trip before its own gates A/B see the result. Best-effort/non-fatal: a projection hiccup here
  // must never undo the mint that already landed in the document.
  function projectAuthorityLogLocally() {
    try {
      projectEntity(db, getCurrentDoc(db), AUTHORITY_LOG_ENTITY)
    } catch (err) {
      console.error(`projectAuthorityLogLocally: local authority-log projection failed (non-fatal): ${err?.message ?? err}`)
    }
  }

  function approveDevice({ token, deviceId: targetDeviceId, makeAdmin = false } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'devices.approve' })
    // T332 (docs/work/specs/2026-10-03-t332-client-admin-minting-design.md), superseding the T86
    // guard that used to sit here: that guard's premise was that this function's only effect was
    // a write to THIS device's local, never-synced `devices` table, which a Client could never
    // make take effect fleet-wide. T331's camp_authority_log mint (below, when makeAdmin is true)
    // is mode-agnostic by construction and IS the fleet-wide effect now — relaxing this guard is
    // what finally lets a Client device reach it. The local `devices` UPDATE below remains exactly
    // what it always was: a best-effort local convenience, not load-bearing for fleet-wide trust.
    if (!isNonEmptyString(targetDeviceId)) throw new Error('deviceId is required')

    const existing = db.prepare('SELECT id FROM devices WHERE id = ?').get(targetDeviceId)
    if (!existing) throw new Error('device not found')

    const secret = randomBytes(32).toString('hex')
    const now = new Date().toISOString()
    db.prepare(
      "UPDATE devices SET authorized_at = ?, authorized_by_user_id = ?, pairing_status = 'authorized', device_secret_identifier = ?, revoked_at = NULL, revoked_by_user_id = NULL, revocation_reason = NULL WHERE id = ?"
    ).run(now, userId, secret, targetDeviceId)

    recordAuditEvent(db, { actorUserId: userId, deviceId: targetDeviceId, action: 'device.approve', outcome: 'allow' })

    // T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) — the in-person pairing UX
    // IS the natural point to mint a signed admin grant too, when the approving admin chooses to
    // grant admin status rather than staff-only trust (the ADR's own design: "rides the pairing
    // moment that already exists"). An ORDINARY (non-admin) device needs no camp_authority_log
    // entry at all — it is simply absent from the admin set, which is the default; the existing
    // devices.authorized_at write above IS its whole trust grant, unchanged. target_peer_id is
    // best-effort: a brand-new device has not yet authenticated over libp2p (that only happens
    // AFTER this approval, on its next connect), so its peer id may still be unknown here — the
    // grant still lands and the device is still a valid admin (authorityReplay.js's isComplete
    // check does not require target_peer_id), it just cannot itself SIGN further entries until a
    // later connection resolves its peer id. Best-effort/non-fatal, same posture as bootstrapCamp's
    // genesis mint — a legitimate approval must never fail because this mint hiccuped.
    if (makeAdmin) {
      try {
        const targetPeerId = db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get(targetDeviceId)?.libp2p_peer_id ?? null
        mintGrantEntry(db, { targetDeviceId, targetPeerId, signerDeviceId: deviceId })
        projectAuthorityLogLocally()
      } catch (err) {
        console.error(`approveDevice: minting the admin grant authority entry failed (non-fatal): ${err?.message ?? err}`)
      }
    }

    // The joining device has its pending stream tracked in the libp2p node;
    // authGate.js resolves false when there is nothing pending for it, so this
    // is safe to call unconditionally.
    getAutomergeNode()?.sendPairingApproved(targetDeviceId, secret)

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

    getAutomergeNode()?.sendPairingDenied(targetDeviceId)

    return { deviceId: targetDeviceId, denied: true }
  }

  function revokeDevice({ token, deviceId: targetDeviceId, reason } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'devices.revoke' })
    // T332 (docs/work/specs/2026-10-03-t332-client-admin-minting-design.md) — same reasoning as
    // approveDevice above: mintRevokeEntry below is unconditional and mode-agnostic, the real
    // fleet-wide effect, so the T86-era Client guard that used to sit here is vestigial post-T331
    // and is removed rather than left as a stale proxy for an effect that is no longer host-local.
    if (!isNonEmptyString(targetDeviceId)) throw new Error('deviceId is required')
    // T332 fold-in (Red Hat MEDIUM) — an admin may not revoke/vote-to-remove their OWN device.
    // Enforced here, not just by hiding the button, because the "Confirm removal" affordance and
    // the ordinary Revoke button both resolve to this same call.
    if (targetDeviceId === deviceId) {
      throw new Error('You cannot remove your own device.')
    }

    const existing = db.prepare('SELECT id FROM devices WHERE id = ?').get(targetDeviceId)
    if (!existing) throw new Error('device not found')

    // T332 fold-in — read BEFORE minting this vote: was the target already a currently-granted
    // admin/founder? This is what decides whether the local write below is gated on quorum at
    // all. An ordinary device (no row here, the overwhelming common case, including every camp
    // that predates T331 and has never minted a camp_authority_log entry) keeps TODAY's
    // unconditional immediate-removal guarantee regardless of whether the mint below succeeds —
    // the distributed mint is additive for it, never load-bearing for this device's own local
    // enforcement. Only a target that is ALREADY an admin/founder enters the quorum-gated path.
    const wasAdminOrFounder = db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(targetDeviceId)?.status === 'admin'

    recordAuditEvent(db, {
      actorUserId: userId, deviceId: targetDeviceId,
      action: 'device.revoke', outcome: 'allow',
      metadata: reason ? { reason } : null,
    })

    // T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) — the DISTRIBUTED half.
    // ALWAYS mints a signed 'revoke' entry naming THIS device as signer (deviceId, the acting
    // admin's own identity) — never decided here whether the target is an ordinary device
    // (immediate removal) or an admin/founder (a vote toward quorum): authorityReplay.js's
    // replay re-derives that from the target's OWN causal state on every peer, per the ADR's
    // "never trust a self-report" rule, so this call site does not reimplement that threshold
    // logic. Best-effort/non-fatal — a failure here must never fail the audit record above.
    try {
      mintRevokeEntry(db, { targetDeviceId, signerDeviceId: deviceId })
      projectAuthorityLogLocally()
    } catch (err) {
      console.error(`revokeDevice: minting the distributed revoke authority entry failed (non-fatal): ${err?.message ?? err}`)
    }

    // T332 fold-in (Red Hat HIGH, Art. V — never show the director a tidy lie). For an
    // admin/founder target, the mint above may be only ONE vote toward quorum — re-read
    // authority_cache (the SAME derived state projectAuthorityLogLocally() above just
    // recomputed from the real camp_authority_log replay) rather than writing devices.revoked_at
    // optimistically just because this one call was made; this device must not render or act on
    // a removal that has not actually happened yet. An ordinary target keeps the unconditional
    // immediate-removal guarantee from before this fold-in (see wasAdminOrFounder above).
    const effectivelyRevoked = wasAdminOrFounder
      ? db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(targetDeviceId)?.status === 'revoked'
      : true

    if (!effectivelyRevoked) {
      return { deviceId: targetDeviceId, revoked: false }
    }

    const now = new Date().toISOString()
    db.prepare(
      "UPDATE devices SET revoked_at = ?, revoked_by_user_id = ?, revocation_reason = ?, pairing_status = 'revoked' WHERE id = ?"
    ).run(now, userId, reason ?? null, targetDeviceId)

    // A revoked device that is still CONNECTED must stop being admitted now, not
    // when it next happens to drop. Admission is granted once and otherwise only
    // cleared on peer:disconnect, so without this a revoked laptop keeps
    // receiving the camp's documents for as long as it stays online. The WS
    // transport had no equivalent gap — revoking closed the socket. Found by
    // porting integration scenario 05.
    try {
      const peerId = db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get(targetDeviceId)?.libp2p_peer_id
      if (peerId) getAutomergeNode()?.revokePeer(peerId)
    } catch (err) {
      console.error(`revokeDevice: failed to evict ${targetDeviceId} from the live admission set: ${err?.message ?? err}`)
    }

    // T328 Slice 1 (docs/adr/2026-10-02-wan-discovery-transport-ladder.md): a revoked peer's
    // remembered address must not survive to be redialed on a later startup. Same best-effort,
    // non-fatal posture as the revokePeer eviction above — a failure here must never fail the
    // revocation itself.
    try {
      const peerId = db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get(targetDeviceId)?.libp2p_peer_id
      if (peerId) forgetPeerAddress(db, peerId)
    } catch (err) {
      console.error(`revokeDevice: failed to forget remembered address for ${targetDeviceId}: ${err?.message ?? err}`)
    }

    return { deviceId: targetDeviceId, revoked: true }
  }

  function verifySession({ token } = {}) {
    const session = verifySessionToken(db, token)
    // Finding 2 fix: a 'device' token (issueDeviceToken) proves connection
    // admission only and carries no userId — reject it explicitly here too,
    // rather than relying on the userRow lookup below incidentally missing
    // for a null id. Same reasoning as authorize.js's explicit check.
    if (!session || session.type === 'device') return { valid: false }
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(session.userId)
    if (!user) return { valid: false }
    return { valid: true, userId: user.id, role: user.role }
  }

  function write({ token, ...writeArgs } = {}) {
    if (!isNonEmptyString(token)) {
      throw new Error('token is required')
    }
    // T163: block users.role -> 'admin' from the generic write path, the
    // same way IPC_PIN_FIELDS blocks pin_hash/pin_salt from leaving the
    // main process (electron/ops/pinFields.js) — a role promotion is a
    // dedicated, atomic operation (role + a FRESH admin-floor PIN, written
    // together via promoteToAdmin/runAtomic), not an ordinary field write.
    // Without this, an admin could flip a staff user's role through write()
    // and silently leave their existing (possibly 4-digit) PIN in place —
    // the server cannot tell from a scrypt hash whether that PIN meets the
    // admin floor, so the role flip alone can never be trusted to be safe.
    if (writeArgs.entity === 'users' && writeArgs.field === 'role' && writeArgs.value === 'admin') {
      throw new Error('users.role cannot be set to admin via write() — use promoteToAdmin, which also resets the PIN to the director floor')
    }
    // Q1 fix (docs/adr/2026-09-14-users-auth-fields-off-the-replicated-document.md): credential
    // fields (role/pin_hash/pin_salt) must ONLY change through createUser / promoteToAdmin, because
    // those are the paths that mint the Host `auth_sig` the projection layer now verifies. A generic
    // write() to one of these fields would produce an UNSIGNED change that every other device
    // correctly refuses on the merge path — a silent, camp-wide revert. Closing that path here makes
    // the two signing sites the only way to change credentials, which is exactly the invariant the
    // enforcement relies on. (Red Hat review of the enforcement slice.)
    if (writeArgs.entity === 'users' && (writeArgs.field === 'pin_hash' || writeArgs.field === 'pin_salt' || writeArgs.field === 'role')) {
      throw new Error(`users.${writeArgs.field} cannot be changed via write() — credential fields are Host-signed; use createUser or promoteToAdmin`)
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
    // A CRDT conflict's competing values come from the DOCUMENT
    // (docs/adr/2026-09-08-crdt-conflict-reconciliation.md), not from two ops —
    // only the winning side ever gets a ledger row, so the losing value has no
    // `operations` id to look up and this validation would refuse the very
    // choice the director is being asked to make.
    const crdtRow = db
      .prepare(
        "SELECT id, incoming_op, existing_op FROM conflicts " +
          "WHERE entity = ? AND entity_id = ? AND field = ? AND resolved_at IS NULL AND id LIKE 'crdt:%'"
      )
      .get(entity, entity_id, field)

    let chosenValue
    if (crdtRow) {
      const sides = [crdtRow.existing_op, crdtRow.incoming_op].map((s) => {
        try { return JSON.parse(s) } catch { return null }
      })
      const chosen = sides.find((s) => s && s.op_id === chosen_op_id)
      if (!chosen) throw new Error('chosen conflict side not found')
      chosenValue = chosen.value
    } else {
      const chosenOp = db
        .prepare('SELECT value FROM operations WHERE id = ? AND entity = ? AND entity_id = ? AND field = ?')
        .get(chosen_op_id, entity, entity_id, field)
      if (!chosenOp) {
        throw new Error('chosen operation not found')
      }
      chosenValue = chosenOp.value
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

    const result = syncClient.write({
      entity,
      entity_id,
      field,
      value: chosenValue,
      parent_op_id: parent_op_id ?? null,
      author_user_id: userId,
      source,
    })

    // A CRDT conflict needs one more step, and it is not belt-and-braces.
    //
    // The write above reaches the document as a plain assignment. When the
    // director chooses the value that had ALREADY won locally — their most
    // likely choice, because it is the one on their screen — that assignment can
    // write no operation at all, leaving the losing register in place and the
    // conflict unresolved. Scenario 28 caught exactly this, failing on roughly
    // half its runs: precisely the runs where the resolver's own value had won.
    //
    // `resolveConflictInDoc` deletes the key and sets it in ONE change, so the
    // new operation dominates every earlier one whatever the chosen value
    // happens to be, and no peer ever observes the field absent.
    //
    // The op-log write is still what happened first, and deliberately so: it is
    // what gives this resolution a ledger row and the right provenance. This
    // second step is about the DOCUMENT's registers, not about the record.
    if (crdtRow) {
      // `applyLocal` documents itself as NOT the production local-write path,
      // because projecting the whole document per field-op would be the
      // per-keystroke performance trap Stage 5f avoids. That reasoning does not
      // apply here: resolving a conflict is a rare, deliberate act by a
      // director, and it needs exactly what applyLocal does — reconcile, set,
      // project and broadcast one already-changed document.
      const onCollapseFailed = (err) => {
        // The director's choice IS recorded (the op-log write above returned);
        // only the document-level collapse failed, so the conflict may resurface
        // until the next write to this field. Say that, rather than reporting a
        // failure that would send them to re-decide something already decided.
        console.error(
          `resolveConflict: the choice was recorded, but collapsing the document conflict failed — ` +
            `it may resurface until the next write to this field: ${err?.message ?? err}`
        )
      }
      try {
        const node = getAutomergeNode()
        const doc = getDocIfLoaded(db)
        if (node && doc) {
          // Async, and deliberately not awaited — resolveConflict is synchronous
          // for its caller. `.catch` rather than a bare call so a rejection is
          // surfaced instead of becoming an unhandled promise rejection.
          Promise.resolve(
            node.applyLocal(resolveConflictInDoc(doc, { entity, entityId: entity_id, field, value: chosenValue }))
          ).catch(onCollapseFailed)
        }
      } catch (err) {
        onCollapseFailed(err)
      }
    }

    return result
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

    return listEntities(db, entity)
  }

  // Scope-filtered sibling of list(): same allowlist-before-query discipline,
  // but additionally requires SCOPED_LIST_ENTITIES membership so that a
  // parent-scoped child (present in PARENT_SCOPED_ENTITIES but not targeted
  // by this read path) is rejected rather than silently exposed.
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

  // Stage 6c: restore executes locally, on whichever device the director is
  // using. It reconstructs a deleted record from this device's `operations`
  // history.
  //
  // KNOWN LIMITATION, and it is the honest state rather than an oversight: a
  // device only has op rows for writes IT made. A record deleted on another
  // device arrives as a document merge, which writes no op row, so restoring it
  // here returns a clean `no-history` error rather than the record. The old
  // transport dodged this by having Clients ask the Host; there is no Host to
  // ask now.
  //
  // The fix is the local history ledger — writing op rows from received merges
  // — which is the narrowed Stage 6d. Deferred integration scenario 18 is its
  // exit criterion. See docs/current/CRDT_SECURITY_GAPS.md.
  //
  // It fails safe: `restoreEntity` checks for the history it needs
  // (`if (!fields.has('camp_id')) return { error: 'no-history' }`) before
  // writing anything, so the failure is a typed error, never a half-restored
  // record or an empty shell.
  async function restoreEntityHandler({ token, entity, entity_id } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    if (!isNonEmptyString(entity)) throw new Error('Invalid entity')
    const { userId } = requireAuthorized(db, { token, action: `${entity}.restore` })
    if (!isNonEmptyString(entity_id)) throw new Error('entity_id is required')
    // Refused in the handler, not hidden in the UI.
    if (!RESTORABLE_ENTITIES.has(entity)) return { error: 'not-restorable' }

    const result = restoreEntity(db, { entity, entity_id, author_user_id: userId, device_id: deviceId })
    if (result.error) return result
    // The ops are not announced here, matching every other local write.
    // _Prior: the reason given was that "in host mode syncClient has no
    // serverUrl, so an ordinary write() also reaches peers via sendMissedOps on
    // their next authenticate rather than a live push." That mechanism is gone —
    // sendMissedOps lived in syncServer.js, deleted at the Stage 6c cutover — and
    // so is the premise. Peer replication is no longer tied to this decision at
    // all: appendOp mirrors every local write into the Automerge document
    // (liveDoc.recordLocalWrite), which reaches connected peers on its own. What
    // is NOT announced here is the renderer-facing op notification._
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

  // Stage 6c: executes on whichever device the director is using. Under the
  // op-log a Client could not express this as one atomic transaction over
  // submit_op, so it asked the Host; now every device holds the whole document
  // and the transaction is local. The count the director was shown is still
  // checked against the data at the moment of deletion (expected_slot_count) —
  // that guard is what made a QUEUED delete unacceptable, and it is unchanged.
  async function deleteRecordHandler({ token, entity, entity_id, expected_slot_count } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    if (!isNonEmptyString(entity)) throw new Error('Invalid entity')
    const { userId } = requireAuthorized(db, { token, action: `${entity}.delete` })
    if (!isNonEmptyString(entity_id)) throw new Error('entity_id is required')
    if (!CLEARABLE_ENTITIES.has(entity)) return { error: 'not-clearable' }

    const result = deleteRecord(db, {
      entity,
      entity_id,
      expected_slot_count,
      author_user_id: userId,
      device_id: deviceId,
    })
    if (result.error) return result
    // Ops are not announced here, matching every other local write. _Prior:
    // "peers pick them up via sendMissedOps on their next authenticate" —
    // sendMissedOps was deleted with syncServer.js at the Stage 6c cutover; peers
    // now receive these writes through the Automerge document. See
    // restoreEntityHandler above for the full note._
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
    // Shape validation for the renderer's arguments. The IPC caller is the
    // trusted renderer, so this is not a security boundary. _Prior: this was
    // "same shape the WS path's validateMergeLocationRequestMsg enforces
    // (syncServer.js) ... the two entry points must not be able to drift on what
    // they accept." There is no WS path and no second entry point — syncServer.js
    // was deleted at the Stage 6c cutover — so there is nothing left to drift
    // against; the check is kept on its own merits._
    if (winner_capacity !== undefined && winner_capacity !== null && !Number.isInteger(winner_capacity)) {
      throw new Error('Invalid winner_capacity')
    }
    if (expected_ref_count !== undefined && expected_ref_count !== null && !Number.isInteger(expected_ref_count)) {
      throw new Error('Invalid expected_ref_count')
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
    // Ops are not announced here, matching deleteRecordHandler. _Prior: "peers
    // pick them up via sendMissedOps on their next authenticate" — see
    // restoreEntityHandler above; that mechanism was deleted at Stage 6c._
    const { ops, ...reportable } = result
    return { ...reportable, ops_written: ops.length }
  }

  // Merging a duplicate activity into the one it duplicates (the Activities
  // duplicate-catcher's one-click fix). Gated on 'activities.delete' rather
  // than '.write': the loser is deleted, and the schedule rows that pointed at
  // it are re-pointed — the same authority mergeLocation requires.
  //
  // The alias is the POINT, not a side effect. Writing source_aliases here is
  // what makes the NEXT import of the same typo'd file resolve silently to the
  // winner instead of creating the duplicate again (ingest.js's listAliasMap
  // already reads it). Without it this fixes one import and learns nothing.
  //
  // It is deliberately best-effort and AFTER the merge: a camp whose activities
  // were just merged is in a correct state whether or not the app also
  // remembers why, and failing the merge because the memory failed would be
  // the worse trade.
  function mergeActivityHandler({ token, loser_id, winner_id, expected_ref_count } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'activities.delete' })
    if (!isNonEmptyString(loser_id)) throw new Error('loser_id is required')
    if (!isNonEmptyString(winner_id)) throw new Error('winner_id is required')
    if (expected_ref_count !== undefined && expected_ref_count !== null && !Number.isInteger(expected_ref_count)) {
      throw new Error('Invalid expected_ref_count')
    }

    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) throw new Error('no camp on this device')
    const loserName = db.prepare('SELECT name FROM activities WHERE id = ?').get(loser_id)?.name ?? null

    const result = mergeActivity(db, {
      loser_id,
      winner_id,
      expected_ref_count,
      author_user_id: userId,
      device_id: deviceId,
    })
    if (result.error) return result

    let alias_remembered = false
    if (loserName) {
      try {
        confirmAlias(db, {
          camp_id: camp.id,
          entity_type: 'activities',
          source_label: loserName,
          entity_id: winner_id,
          confirmed_by: userId,
        })
        alias_remembered = true
      } catch (err) {
        // Surfaced, never swallowed — a merge that did not teach anything is a
        // merge the director will have to repeat after the next import.
        console.error(`[merge-activity] alias not remembered for "${loserName}":`, err)
      }
    }

    const { ops, ...reportable } = result
    return { ...reportable, ops_written: ops.length, alias_remembered }
  }

  function previewActivityMergeHandler({ token, loser_id } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'activities.read' })
    if (!isNonEmptyString(loser_id)) throw new Error('loser_id is required')
    return previewActivityMerge(db, { loser_id })
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

  // docs/adr/2026-08-28-persisted-reconciliation-decisions.md §4b. HOST
  // ONLY, same reasoning as confirmAliasHandler above: open_reconciliation_
  // decisions is a host-local table, only ever written by commitPlan on the
  // Host device (import is host-only) — a Client's own copy of this table
  // is always empty by construction, so routing this through IPC to the
  // Host rather than reading the calling device's own (always-empty) db
  // would be the honest behavior; until that's needed, this reads the
  // calling device's own db directly and is gated host-only so a Client
  // never mistakes an always-empty read for "nothing to review".
  function listOpenReconciliationDecisionsHandler({ token } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'open_reconciliation_decisions.read' })
    if (mode === 'client') {
      throw new Error('Reconciliation decisions can only be read on the main computer.')
    }
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return []
    return listOpenReconciliationDecisions(db, camp.id)
  }

  // Dismiss = a plain DELETE ... WHERE id = ? (§4b) — a LOCAL WRITE, never
  // an op, never routed to the Host or broadcast, same posture as
  // dismissMigrationReviewsHandler. HOST ONLY for the same reason as the
  // list handler above.
  function dismissOpenReconciliationDecisionsHandler({ token, ids } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'open_reconciliation_decisions.dismiss' })
    if (mode === 'client') {
      throw new Error('Reconciliation decisions can only be dismissed on the main computer.')
    }
    return dismissOpenReconciliationDecisions(db, ids)
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

  // T306 — THE RENDERER'S ROUTE TO NAMING AN UNNAMED SUBMISSION.
  //
  // The import lands a child's preferences with no name when the planner carries
  // none (ADR §14.1a: a first-class outcome, not a failure), and the Roots home
  // attention surface asks "we have this camper's choices but not their name — who
  // is this?". Until T306 that question had no answer path from the renderer at
  // all: `attributeElectiveSubject` existed, was tested, and was reachable ONLY
  // from scripts/mcp/tools.js. §14.1a's promise that attribution is "resolvable
  // later without re-import" was true for a machine and false for a human.
  //
  // 'campers.attribute', NOT 'campers.write'. Owner ruling 2026-09-29: staff may
  // name an unnamed child, because the people who collected the sheets know whose
  // is whose. But the op's own refusal to rename an ALREADY-NAMED camper
  // (`is_unattributed !== 1`) lives in the op, not in the generic write path —
  // main.js's write() derives a bare `campers.write` via deriveWriteAction and
  // never routes through this op. Granting staff `campers.write` would therefore
  // hand them a path that renames any camper with that guard nowhere in it. The
  // narrow verb keeps every caller on the guarded path
  // (electron/ops/participantEntities.js).
  //
  // RETURNS the op's {ok:false,error} rather than throwing it. That is deliberate:
  // the op's message names the specific reason ("X is not an unattributed subject,
  // so there is no name to fill in…"), and flattening it into a generic throw
  // would lose exactly the sentence the director needs. The renderer must check
  // `ok` — an IPC caller that only catches throws turns this refusal into a silent
  // success, which is the swallowed-failure class this repo keeps ruling against.
  function attributeSubjectHandler({ token, subjectId, displayName, externalId = null } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'campers.attribute' })
    if (!isNonEmptyString(subjectId)) throw new Error('subjectId is required')
    if (!isNonEmptyString(displayName)) throw new Error('displayName is required')
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) throw new Error('no camp')

    // THE SAME CALL SHAPE scripts/mcp/tools.js uses. Two call shapes for one op is
    // the ADR §3.2 defect this program has already paid for twice: attribution
    // performed through the UI and through MCP must produce the same rekey.
    return attributeElectiveSubject(db, {
      campId: camp.id,
      deviceId,
      authorUserId: userId,
      subjectId,
      displayName,
      externalId,
    })
  }

  // T110 (docs/adr/2026-08-20-electives-authoring.md; docs/work/tickets/
  // T110-electives-sets-crud-and-durability-marker.md): wires the
  // deleteElectiveSet cascade primitive (electron/ops/deleteElectiveSet.js,
  // shipped inert in T41 slice 1) to a caller. ADMIN-ONLY ('.delete' not
  // '.write'), matching every other entity's permanent-delete posture
  // (permissions.js default-deny — staff hold elective_sets.write but not
  // elective_sets.delete). Mirrors deleteWeekHandler's shape: direct db
  // write + requireAuthorized, no client-mode delegation (same as
  // deleteWeek/deleteRecord's precedent for host-issued cascades).
  function deleteElectiveSetHandler({ token, electiveSetId } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'elective_sets.delete' })
    if (!isNonEmptyString(electiveSetId)) throw new Error('electiveSetId is required')

    const result = deleteElectiveSet(
      db,
      { electiveSetId },
      { author_user_id: userId, device_id: deviceId }
    )
    if (result.error) return result
    const { ops, ...reportable } = result
    return { ...reportable, ops_written: ops.length }
  }

  // T106 (docs/work/tickets/T106-special-day-author-ui.md; docs/adr/2026-08-20-
  // special-days-authoring-and-day-override-repoint.md D1): wires the
  // deleteSpecialDay cascade primitive (electron/ops/deleteSpecialDay.js,
  // shipped inert in T40 slice 1) to a caller. ADMIN-ONLY ('.delete' not
  // '.write'), same posture as deleteElectiveSetHandler above (permissions.js
  // default-deny — staff hold special_days.write but not special_days.delete).
  function deleteSpecialDayHandler({ token, specialDayId } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'special_days.delete' })
    if (!isNonEmptyString(specialDayId)) throw new Error('specialDayId is required')

    const result = deleteSpecialDay(
      db,
      { specialDayId },
      { author_user_id: userId, device_id: deviceId }
    )
    if (result.error) return result
    const { ops, ...reportable } = result
    return { ...reportable, ops_written: ops.length }
  }

  // Events internal sub-schedule Slice 2 (docs/adr/2026-08-22-event-internal-
  // subschedule.md §3): wires the deleteEvent cascade primitive
  // (electron/ops/deleteEvent.js, shipped inert in this slice) to a caller.
  // ADMIN-ONLY ('.delete' not '.write'), same posture as
  // deleteSpecialDayHandler above. Not called from any UI in this slice —
  // restore.js's "events: refused: no delete UI yet" note stays accurate.
  function deleteEventHandler({ token, eventId } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const { userId } = requireAuthorized(db, { token, action: 'events.delete' })
    if (!isNonEmptyString(eventId)) throw new Error('eventId is required')

    const result = deleteEvent(
      db,
      { eventId },
      { author_user_id: userId, device_id: deviceId }
    )
    if (result.error) return result
    const { ops, ...reportable } = result
    return { ...reportable, ops_written: ops.length }
  }

  // T105 (docs/work/tickets/T105-elective-inline-authoring-and-render.md;
  // docs/work/specs/2026-08-20-elective-authoring-render-design.md §2):
  // listDurableElectiveSets (electron/ops/durableElectiveSets.js, T110) gets
  // its first production caller here — the single sanctioned seam for
  // "durable/reusable electives" (is_reusable = 1 only). Read-only, mirrors
  // listUsers's shape exactly: requireAuthorized then one query, no
  // client-mode delegation. Never substitute the generic `list('elective_sets')`
  // handler for this — that returns one-offs unfiltered.
  function listDurableElectiveSetsHandler(token) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'elective_sets.read' })
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return []
    return listDurableElectiveSets(db, camp.id)
  }

  // The individual-elective run path (T196/T226/T227).
  //
  // ADMIN-ONLY, and not by a check written here: the seven participant
  // entities are deliberately absent from permissions.js ENTITIES, so
  // authorize() default-denies them for staff and
  // participantEntitiesAdminOnly.test.js holds that. These handlers name a
  // participant action and inherit that property rather than re-implementing
  // it — a hand-written role check here would be a second place for the rule
  // to drift (ADR D9: the participant domain is admin-only; staff consume the
  // export).
  //
  // The SHEET IS PARSED IN THE RENDERER, same as ImportScreen: parsePreferenceSheet
  // and buildElectiveAssignments are pure modules with no db, so only the WRITE
  // needs to cross the boundary. That keeps the mapping-correction loop
  // interactive without a round trip per keystroke.
  function commitElectiveRunHandler(args) {
    const {
      token, name, sourceFilename = null, sourceSha256 = null, parsed, assignments = [],
      occurrences = [], scheduleWeekId = null, scheduleTemplateId = null, runId = null,
      // T320 (docs/adr/2026-09-30-elective-run-durability.md item 4) — the
      // eligibility findings buildElectiveAssignments already computed at
      // solve time, passed through so commitElectiveRun.js can persist them.
      findings = [],
    } = args ?? {}
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = requireAuthorized(db, { token, action: 'elective_assignment_runs.write' })
    if (!isNonEmptyString(name)) throw new Error('a run needs a name')
    if (!parsed || !Array.isArray(parsed.campers)) throw new Error('parsed sheet is required')
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) throw new Error('no camp')
    // commitElectiveRun returns {ok:false, error} for a refusal rather than
    // throwing — a same-name collision is a decision for the director, not an
    // exception. It is returned as-is so the screen can render the names.
    return commitElectiveRun(db, {
      campId: camp.id,
      deviceId,
      authorUserId: session?.userId ?? null,
      name,
      sourceFilename,
      sourceSha256,
      parsed,
      assignments,
      occurrences,
      scheduleWeekId,
      scheduleTemplateId,
      runId,
      findings,
    })
  }

  function listElectiveRunsHandler(token) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'elective_assignment_runs.read' })
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return []
    // T250 A0.1 — widened to include schedule_template_id/schedule_week_id/
    // tier_id/finalized_at/finalized_by: RunIdentity (src/screens/elective/
    // run/RunStateRows.jsx) reads all five, and they were previously
    // undefined on a run opened cold from this list.
    //
    // C3 (board item 9b) — finalized_by_name is a READ-SIDE LEFT JOIN, no
    // schema change: RunIdentity used to render the raw finalized_by user id
    // verbatim ("by f0c9f725-…"). finalized_by carries no FK (schema.sql's
    // own comment on the column: nullable, a legacy row migrates forward with
    // both NULL), so the join legitimately yields no match — u.name is then
    // NULL and the screen falls back to "a director" rather than crashing or
    // printing the id.
    return db
      .prepare(
        `SELECT r.id, r.name, r.status, r.source_filename, r.solver_version,
                r.schedule_week_id, r.schedule_template_id, r.tier_id, r.finalized_at, r.finalized_by,
                u.name AS finalized_by_name
           FROM elective_assignment_runs r
           LEFT JOIN users u ON u.id = r.finalized_by
          WHERE r.camp_id = ? ORDER BY r.name`
      )
      .all(camp.id)
  }

  // T198 — thin IPC plumbing only; the read itself lives in electron/ops/getElectiveRun.js
  // (extracted verbatim, comments included — see that file for the shape this returns).
  function getElectiveRunHandler(args) {
    const { token, runId } = args ?? {}
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'elective_assignment_runs.read' })
    if (!isNonEmptyString(runId)) throw new Error('runId is required')
    return getElectiveRun(db, { runId })
  }

  // Finalizing a draft run into an immutable, exportable final one (T244,
  // docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md
  // decision (a)). Same admin-only participant-entity posture as
  // commitElectiveRunHandler above (the action name, not a hand-written role
  // check, is what enforces it — participantEntitiesAdminOnly.test.js).
  // The write itself lives in electron/ops/finalizeElectiveRun.js, following
  // commitElectiveRun's split: this handler only authorizes, resolves the
  // camp, and forwards.
  function finalizeElectiveRunHandler(args) {
    const { token, runId } = args ?? {}
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = requireAuthorized(db, { token, action: 'elective_assignment_runs.write' })
    if (!isNonEmptyString(runId)) throw new Error('runId is required')
    return finalizeElectiveRun(db, { runId, authorUserId: session?.userId ?? null, deviceId })
  }

  // T250 A4 — permanently deleting an elective run and every row scoped to it.
  // Same admin-only participant-entity posture as the handlers above (the
  // action name, not a hand-written role check, is what enforces it —
  // participantEntitiesAdminOnly.test.js). The cascade itself lives in
  // electron/ops/deleteElectiveRun.js; this handler only authorizes and
  // forwards, same split as deleteElectiveSetHandler above. A final run is
  // deletable — D10 rules on editing an immutable run's content, not on
  // removing the run itself.
  function deleteElectiveRunHandler({ token, runId } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = requireAuthorized(db, { token, action: 'elective_assignment_runs.delete' })
    if (!isNonEmptyString(runId)) throw new Error('runId is required')
    const result = deleteElectiveRun(db, { runId }, { author_user_id: session?.userId ?? null, device_id: deviceId })
    if (result.error) return result
    const { ops, ...reportable } = result
    return { ...reportable, ops_written: ops.length }
  }

  // Moving/locking a camper inside a draft run (T245, same ADR, decision (b)).
  // Same admin-only participant-entity posture as the handlers above — the
  // action name, not a hand-written role check, is what enforces it
  // (participantEntitiesAdminOnly.test.js). The write lives in
  // electron/ops/setElectiveAssignment.js; this handler only authorizes,
  // validates the argument shape, and forwards. Appended after the finalize
  // handler per the ADR's merge-order note; do not reorder.
  function setElectiveAssignmentHandler(args) {
    const {
      token, runId, camperId, occurrenceId = null, activityId = null, locked = false,
      // T320 (docs/adr/2026-09-30-elective-run-durability.md item 3) — the
      // move/remove picker's contract.
      replacesAssignmentId = null,
    } = args ?? {}
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = requireAuthorized(db, { token, action: 'elective_assignment_runs.write' })
    if (!isNonEmptyString(runId)) throw new Error('runId is required')
    if (!isNonEmptyString(camperId)) throw new Error('camperId is required')
    // REMOVE-ONLY (occurrenceId/activityId both null, replacesAssignmentId
    // given) is the one shape that skips the usual non-empty-string
    // requirement on occurrenceId/activityId — there is no destination to
    // validate. Every other call still requires both, exactly as before.
    const isRemoveOnly = occurrenceId == null && activityId == null && replacesAssignmentId != null
    if (!isRemoveOnly) {
      if (!isNonEmptyString(occurrenceId)) throw new Error('occurrenceId is required')
      if (!isNonEmptyString(activityId)) throw new Error('activityId is required')
    }
    return setElectiveAssignment(db, {
      runId, camperId, occurrenceId, activityId, locked, replacesAssignmentId,
      authorUserId: session?.userId ?? null, deviceId,
    })
  }

  // T297 — editing one camper's PREFERENCE (what they asked for) as distinct
  // from their PLACEMENT (what they got, setElectiveAssignmentHandler above).
  // Same admin-only posture and the same action name: a preference belongs to
  // the run, and a preference edit is a write to it.
  //
  // `rank` is validated as an integer or null and `rankKind` as a non-empty
  // string, because BOTH are the director's statement about the edit and neither
  // may be inferred here — the ops module writes exactly what it is handed.
  function setElectivePreferenceHandler(args) {
    const {
      token, runId, camperId, occurrenceId, choiceId,
      rank = null, rankKind = null, replacesPreferenceId = null,
    } = args ?? {}
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = requireAuthorized(db, { token, action: 'elective_assignment_runs.write' })
    if (!isNonEmptyString(runId)) throw new Error('runId is required')
    if (!isNonEmptyString(camperId)) throw new Error('camperId is required')
    if (!isNonEmptyString(occurrenceId)) throw new Error('occurrenceId is required')
    if (!isNonEmptyString(choiceId)) throw new Error('choiceId is required')
    if (rank !== null && !Number.isInteger(rank)) throw new Error('rank must be an integer or null')
    if (rankKind !== null && !isNonEmptyString(rankKind)) throw new Error('rankKind must be a non-empty string or null')
    if (replacesPreferenceId !== null && !isNonEmptyString(replacesPreferenceId)) {
      throw new Error('replacesPreferenceId must be a non-empty string or null')
    }
    return setElectivePreference(db, {
      runId, camperId, occurrenceId, choiceId, rank, rankKind, replacesPreferenceId,
      authorUserId: session?.userId ?? null, deviceId,
    })
  }

  function removeElectivePreferenceHandler(args) {
    const { token, runId, preferenceId } = args ?? {}
    if (!isNonEmptyString(token)) throw new Error('token is required')
    const session = requireAuthorized(db, { token, action: 'elective_assignment_runs.write' })
    if (!isNonEmptyString(runId)) throw new Error('runId is required')
    if (!isNonEmptyString(preferenceId)) throw new Error('preferenceId is required')
    return removeElectivePreference(db, {
      runId, preferenceId, authorUserId: session?.userId ?? null, deviceId,
    })
  }

  // T198 — thin IPC plumbing only; the read itself lives in
  // electron/ops/getElectiveRunOuterSchedule.js (extracted verbatim, comments
  // included — see that file for the shape this returns).
  function getElectiveRunOuterScheduleHandler(args) {
    const { token, runId } = args ?? {}
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'elective_assignment_runs.read' })
    if (!isNonEmptyString(runId)) throw new Error('runId is required')
    return getElectiveRunOuterSchedule(db, { runId })
  }

  // T249 (docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md
  // decision (e); ADR D8's release gate). The renderer has no way to know
  // whether at-rest encryption is actually active — SHORESH_AT_REST_ENCRYPTION
  // is read only in electron/ — so the elective feature could not state, in the
  // UI, that camper data is still unencrypted on disk. This is that one read.
  //
  // Deliberately NO requireAuthorized: this is public configuration state about
  // THIS device's build posture, not camp or camper data, the same class of
  // read as getCamp. Gating it behind a session token would make the disclosure
  // unrenderable exactly where it is least useful (before a session resolves),
  // and it discloses nothing an attacker on this machine could not read off the
  // process environment anyway.
  //
  // It calls isAtRestEncryptionEnabled() — the SAME resolution the document and
  // SQLite ciphers use (electron/db/atRestEncryption.js, imported above and
  // used at the acquireDocCipher/acquireDbKey call site) — rather than
  // re-parsing process.env here, so the statement in the UI cannot disagree
  // with what the app actually did to the bytes on disk.
  function getSecurityStatusHandler() {
    return { atRestEncryptionEnabled: isAtRestEncryptionEnabled() }
  }

  // Slice D (docs/adr/2026-08-22-roots-as-hub-setup-ia.md §7): batched
  // read-only provenance for the Activities screen's row-level provenance
  // dot. Returns the whole camp's activity import_evidence rows plus, per
  // activity, the last op `source` for the 3 owner-locked rule fields
  // (min_per_week/max_per_week, eligible_group_ids, location_id) —
  // src/utils/ruleProvenance.js combines the two into a tier per field. No
  // new table, no schema change: import_evidence already exists
  // (electron/db/schema.sql), this just exposes it over IPC for the first
  // time, mirroring listDurableElectiveSetsHandler's shape exactly.
  function listImportEvidenceHandler(token) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'activities.read' })
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return { evidence: [], fieldSources: {} }
    const evidence = listImportEvidence(db, camp.id, { entity_type: 'activities' })
    const activityIds = db.prepare('SELECT id FROM activities WHERE camp_id = ?').all(camp.id).map((r) => r.id)
    const fieldSources = {}
    for (const activityId of activityIds) {
      const sources = lastKnownFieldSources(db, 'activities', activityId)
      fieldSources[activityId] = {
        min_per_week: sources.get('min_per_week') ?? null,
        max_per_week: sources.get('max_per_week') ?? null,
        eligible_group_ids: sources.get('eligible_group_ids') ?? null,
        location_id: sources.get('location_id') ?? null,
        // T114 follow-up. RULE_FIELDS gained a co-schedule row; without its
        // source here the lookup returns undefined, tierForField reads that as
        // a human write, and an imported inference renders as 'confirmed' — the
        // provenance dot then vouches for something nobody reviewed.
        max_groups_per_slot: sources.get('max_groups_per_slot') ?? null,
        same_tier_only: sources.get('same_tier_only') ?? null,
      }
    }
    return { evidence, fieldSources }
  }

  // T114 follow-up — the groups counterpart, backing the Groups screen's
  // per-row division provenance. Narrowed to the one inferred field a group
  // has (tier_id), mirroring listImportEvidenceHandler's shape.
  function listDivisionEvidenceHandler(token) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'groups.read' })
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return { evidence: [], fieldSources: {} }
    const evidence = listImportEvidence(db, camp.id, { entity_type: 'groups' })
    const fieldSources = {}
    for (const row of db.prepare('SELECT id FROM groups WHERE camp_id = ?').all(camp.id)) {
      fieldSources[row.id] = { tier_id: lastKnownFieldSources(db, 'groups', row.id).get('tier_id') ?? null }
    }
    return { evidence, fieldSources }
  }

  // T119 (docs/work/tickets/T119-imported-location-capacity-provenance.md):
  // batched read backing the Locations screen's per-row capacity provenance
  // marker and the Roots attention list's aggregate count. Mirrors
  // listImportEvidenceHandler's shape, narrowed to one field. capacity has no
  // import-evidence record (unlike the activity rule fields), so
  // tierForField's three-way tier collapses to a binary: 'confirmed' (an
  // actual op with source='human') vs 'unconfirmed' (source='import', OR no
  // capacity op at all).
  //
  // The "no op at all" case is NOT the same as tierForField's general
  // "source is null -> confirmed" default (correct for a hand-created
  // record that went through the normal write path, where every field gets
  // a 'human' op). For locations specifically, the ONLY way to have zero
  // capacity ops is the v32 migration backfill (electron/db/localDb.js,
  // §"Camp Spatial Model" — a raw INSERT that bypasses the op-log
  // entirely), which derived capacity from old activities.max_groups_per_slot
  // values with no director review. So it is read the same as an import: a
  // machine-derived guess, unconfirmed until a human writes it — checked via
  // Map.has, not the (always-defined-for-real-ops) source value itself.
  function locationCapacityProvenanceHandler(token) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'locations.read' })
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return {}
    const locationIds = db.prepare('SELECT id FROM locations WHERE camp_id = ?').all(camp.id).map((r) => r.id)
    const result = {}
    for (const locationId of locationIds) {
      const sources = lastKnownFieldSources(db, 'locations', locationId)
      if (!sources.has('capacity')) { result[locationId] = 'unconfirmed'; continue }
      result[locationId] = tierForField(sources.get('capacity'), null) === 'confirmed' ? 'confirmed' : 'unconfirmed'
    }
    return result
  }

  // ---------------------------------------------------------------------
  // Join flow (docs/adr/2026-09-08-libp2p-join-flow.md).
  //
  // Two halves that never run on the same device at the same time: the HOST's
  // Add-a-device window, and the JOINING device's pre-identity session. The
  // joining half is deliberately token-free — a device with no camp has no
  // user, no session and nothing to authorize against. Its safety comes from
  // startJoinSession itself, which
  // refuses outright if this device already belongs to a camp, and from the
  // join-code proof both sides exchange.
  // ---------------------------------------------------------------------

  // The director's Add-a-device window. Consent, not security: it stops a Host
  // nobody is standing at from putting pairing prompts on screen. Reset to
  // closed on every app start by virtue of being process state.
  let joinWindowOpen = false

  // T286 — the random, Host-minted, window-scoped join secret (never derived
  // from the campId; see joinCode.js's module comment). Minted the moment the
  // window opens, discarded the moment it closes (or the app restarts, by
  // virtue of being process state, same as joinWindowOpen above). THIS is the
  // actual security boundary syncNode.js's getJoinSecret reads — a leaked or
  // brute-forced secret dies with its window rather than living forever the
  // way the old campId-derived code did.
  let joinSecret = null

  // Which join flow the Join screen should present. Pre-auth by construction:
  // a device deciding how to join has no session yet. Returns only the engine
  // name — no camp, no device, nothing about this machine's contents.
  //
  // This exists because the two flows are genuinely different experiences (an
  // address picker vs. a typed camp code), not two renderings of one thing,
  // and BOTH must work while `SHORESH_SYNC_ENGINE` still defaults to `oplog`.
  // It goes away with the WS layer in Stage 6c, along with the branch in
  // JoinScreen that reads it.
  function getSyncEngine() {
    return { engine: isAutomergeEngine() ? 'automerge' : 'oplog' }
  }

  // T286 — while the window is closed there is no secret to show (it hasn't
  // been minted, or was discarded when the window last closed): `code`/
  // `formatted` come back null and the renderer's own gating (it only ever
  // renders the code when `open` is true — DeviceManagerScreen.jsx) never
  // shows a stale or absent value as if it were real.
  function getJoinCode({ token } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'devices.approve' })
    if (mode === 'client') {
      throw new Error('Adding a device can only be done on the main computer.')
    }
    const camp = db.prepare('SELECT id, name FROM camps LIMIT 1').get()
    if (!camp) throw new Error('no camp on this device yet')
    return {
      code: joinSecret,
      formatted: joinSecret ? formatJoinCode(joinSecret) : null,
      campName: camp.name,
      open: joinWindowOpen,
    }
  }

  function setJoinWindow({ token, open } = {}) {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    requireAuthorized(db, { token, action: 'devices.approve' })
    if (mode === 'client') {
      throw new Error('Adding a device can only be done on the main computer.')
    }
    joinWindowOpen = Boolean(open)
    // A fresh secret every time the window opens — including re-opening after
    // a close — so a leaked or previously-brute-forced-in-vain secret is never
    // reused. Discarded (not just left stale) on close: nothing should still
    // verify against it once the Host has stopped advertising the tag.
    joinSecret = joinWindowOpen ? mintJoinSecret() : null
    return {
      open: joinWindowOpen,
      code: joinSecret,
      formatted: joinSecret ? formatJoinCode(joinSecret) : null,
    }
  }

  // The joining device's live session, for this process only. Never persisted:
  // an app restart mid-join starts over, which is correct — nothing has been
  // written yet at any point before login.
  let activeJoin = null

  async function joinStart({
    code,
    deviceName,
    // T274 round 2 (Security + Code Reviewer): these are test-only seams,
    // forwarded to startJoinSession, which already documents them as such
    // (peer discovery over loopback, no real network interface, used by
    // test/integration/harnessAutomerge.js's AmClient.join for the same
    // reason). preload.js:72 forwards the WHOLE args object to this handler
    // over IPC — the renderer CAN send these, so they are only HONORED under
    // Vitest (below), never merely "inert because nothing sends them". The
    // join-code HMAC proof still gates admission regardless of what a
    // renderer supplies here, so this is not an auth bypass — but a
    // discovery/timeout value a compromised renderer could otherwise steer
    // is not a boundary worth leaving unenforced when enforcing it costs one
    // env check.
    knownHost,
    peerDiscovery,
    discoveryWaitMs,
    documentWaitMs,
  } = {}) {
    if (activeJoin) {
      const cancelled = await joinCancel()
      // T274 round 3 — a `stop_failed` here means the OLD temporary node is
      // still running and joinCancel deliberately kept the reference (see its
      // own comment) rather than orphan it. Starting a new session anyway
      // would immediately clobber that reference with a second real node on
      // this device's same peer identity — the exact bug this round exists
      // to close. Refuse instead: `activeJoin` is still set, so a follow-up
      // joinCancel (or joinStart) call gets another chance to actually stop
      // it before anything new is allowed to start.
      if (cancelled.status === 'stop_failed') return { status: 'stop_failed' }
    }
    const testOnly = Boolean(process.env.VITEST)
    const started = await startJoinSession({
      db,
      deviceId,
      deviceName: deviceName || db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId)?.name,
      code,
      knownHost: testOnly ? knownHost : undefined,
      peerDiscovery: testOnly ? peerDiscovery : undefined,
      discoveryWaitMs: testOnly ? discoveryWaitMs : undefined,
      documentWaitMs: testOnly ? documentWaitMs : undefined,
    })
    if (started.status !== 'started') return { status: started.status }
    activeJoin = started.session
    return { status: 'started' }
  }

  async function joinFindHost() {
    if (!activeJoin) throw new Error('no join in progress')
    const found = await activeJoin.findHost()
    return { status: found ? 'found' : 'not_found' }
  }

  async function joinRequestPairing() {
    if (!activeJoin) throw new Error('no join in progress')
    return activeJoin.requestPairing()
  }

  async function joinAwaitPairingDecision() {
    if (!activeJoin) throw new Error('no join in progress')
    return activeJoin.waitForPairingDecision()
  }

  async function joinLogin({ name, pin, deviceSecretIdentifier } = {}) {
    if (!activeJoin) throw new Error('no join in progress')
    return activeJoin.login({ name, pin, deviceSecretIdentifier })
  }

  // The camp's data, as distinct from its identity — see joinSession's own
  // waitForCamp comment. `timeout` here is a real outcome the screen must
  // show, never a spinner that hides a dead connection.
  //
  // T274 — on success this is also where the join handoff completes. The
  // join module's own header comment calls this out: "the handoff is the
  // point" — a join session is over the instant the camp exists and the
  // first document has landed, and from then on this device must behave
  // like an ordinary Client with a persistent, camp-scoped sync node. Two
  // things make that NOT a one-line "just start the persistent node" fix:
  //   1. Nothing did it before this, at all — the device ran the rest of its
  //      session with no persistent node and never synced until restart.
  //   2. The join flow already runs its OWN temporary libp2p node, and that
  //      node shares THIS device's stable peer identity with whatever the
  //      persistent starter would create (ensureDeviceIdentity is keyed by
  //      db, not by which node started it) — so starting the persistent node
  //      while the temporary one is still up would be one peer identity
  //      live twice, not a harmless second node.
  // So the temporary session is stopped FIRST, synchronously with this call
  // (the join UI is already on a "receiving" spinner; a few extra ms to tear
  // down libp2p is invisible), and only then is onCampJoined fired — mirroring
  // T273's onCampBootstrapped, deliberately NOT awaited: libp2p startup takes
  // as long as it takes, and a successful join must never be reported as
  // failed because sync start-up was slow. startAutomergeSyncNodeIfEnabled's
  // own idempotency guard (`if (automergeSyncNode) return`) makes any
  // redundant invocation harmless.
  async function joinAwaitData() {
    if (!activeJoin) throw new Error('no join in progress')
    const session = activeJoin
    const camp = await session.waitForCamp()
    // T274 round 3 — deliberately does NOT null `activeJoin` here. The node
    // is still running (waitForCamp only gave up waiting; it didn't stop
    // anything), so keeping the reference means a retry's joinStart ->
    // joinCancel can still find and stop it — the same "never drop the
    // reference to a possibly-live node" invariant joinCancel now enforces
    // on its own failure path, already covering this composition.
    if (!camp) return { status: 'timeout' }

    activeJoin = null
    // T274 round 2 (Red Hat, HIGH): onCampJoined must fire ONLY when the
    // temporary node is confirmed stopped. The whole reason to stop first is
    // that the temp node and the persistent node share this device's
    // db-keyed peer identity — if stop() throws, the temp node may still be
    // up, and starting the persistent one anyway would be that identity live
    // twice. Prefer safe-degraded (no persistent node started this cycle;
    // getSyncStatus's existing T268 path surfaces "not syncing", which a
    // retry or restart resolves) over a confirmed double-node.
    let stopped = false
    try {
      await session.stop()
      stopped = true
    } catch (err) {
      console.error(`join: stopping the temporary join node failed — sync node NOT started this cycle to avoid a duplicate peer identity (non-fatal, resolves on retry/restart): ${err?.message ?? err}`)
    }
    if (stopped) {
      try {
        Promise.resolve(onCampJoinedFn()).catch((err) => {
          console.error(`sync node start after join failed (non-fatal): ${err?.message ?? err}`)
        })
      } catch (err) {
        console.error(`sync node start after join failed (non-fatal): ${err?.message ?? err}`)
      }
    }

    return { status: 'ok', camp }
  }

  // T274 round 3 (Red Hat, MEDIUM) — the same double-identity hazard fix 1
  // (joinAwaitData) closed, on the cancel path. This used to null
  // `activeJoin` BEFORE awaiting stop(), so a rejection left the temporary
  // node running with NO reference to it anywhere in main.js. A subsequent
  // joinStart (its own auto-cancel-then-start below, or a manual retry) would
  // then start a SECOND real libp2p node on this device's db-keyed peer
  // identity, orphaning the first. `activeJoin` is now cleared ONLY once
  // stop() is confirmed to have succeeded — mirroring joinAwaitData's own
  // "gate the next step on the stop actually succeeding" discipline — so a
  // failed stop keeps the reference alive (retryable, never orphaned) instead
  // of being silently dropped.
  async function joinCancel() {
    if (!activeJoin) return { status: 'idle' }
    const session = activeJoin
    try {
      await session.stop()
    } catch (err) {
      console.error(`join: stopping the join session failed — the node is NOT orphaned, its reference is retained so a retry can stop it and nothing starts a second node on this identity in the meantime: ${err?.message ?? err}`)
      return { status: 'stop_failed' }
    }
    activeJoin = null
    return { status: 'cancelled' }
  }

  return {
    // Stage 6c: called by the libp2p node when its peer set changes, so the
    // sidebar reflects reachability instead of showing whatever was true at
    // mount. Not an IPC channel — it is invoked in-process (see
    // startAutomergeSyncNodeIfEnabled), so it is deliberately absent from
    // preload.js and from the IPC surface parity check.
    pushSyncStatus,
    chooseMode,
    previewDelete: previewDeleteHandler,
    deleteRecord: deleteRecordHandler,
    mergeLocation: mergeLocationHandler,
    mergeActivity: mergeActivityHandler,
    previewActivityMerge: previewActivityMergeHandler,
    listMigrationReviews: listMigrationReviewsHandler,
    dismissMigrationReviews: dismissMigrationReviewsHandler,
    listOpenReconciliationDecisions: listOpenReconciliationDecisionsHandler,
    dismissOpenReconciliationDecisions: dismissOpenReconciliationDecisionsHandler,
    duplicateWeek: duplicateWeekHandler,
    deleteWeek: deleteWeekHandler,
    attributeSubject: attributeSubjectHandler,
    deleteElectiveSet: deleteElectiveSetHandler,
    deleteElectiveRun: deleteElectiveRunHandler,
    deleteSpecialDay: deleteSpecialDayHandler,
    deleteEvent: deleteEventHandler,
    listDurableElectiveSets: listDurableElectiveSetsHandler,
    commitElectiveRun: commitElectiveRunHandler,
    listElectiveRuns: listElectiveRunsHandler,
    getElectiveRun: getElectiveRunHandler,
    finalizeElectiveRun: finalizeElectiveRunHandler,
    setElectiveAssignment: setElectiveAssignmentHandler,
    setElectivePreference: setElectivePreferenceHandler,
    removeElectivePreference: removeElectivePreferenceHandler,
    getElectiveRunOuterSchedule: getElectiveRunOuterScheduleHandler,
    // T249 — append-only per the ADR's merge-order note; do not reorder.
    getSecurityStatus: getSecurityStatusHandler,
    listImportEvidence: listImportEvidenceHandler,
    listDivisionEvidence: listDivisionEvidenceHandler,
    locationCapacityProvenance: locationCapacityProvenanceHandler,
    listDeleted: listDeletedHandler,
    listPendingRestores: listPendingRestoresHandler,
    getEntityHistory: getEntityHistoryHandler,
    restoreEntity: restoreEntityHandler,
    login,
    createUser: createUserHandler,
    promoteToAdmin: promoteToAdminHandler,
    bootstrapCamp,
    write,
    verifySession,
    listUsers,
    list,
    listByScope,
    bulkReplace,
    getDeviceId,
    getSyncStatus,
    retrySync: retrySyncHandler,
    ingestCommit,
    ingestReconcile,
    ingestUndo: ingestUndoHandler,
    confirmAlias: confirmAliasHandler,
    recordDeclinedSplit: recordDeclinedSplitHandler,
    recordImportDecisions: recordImportDecisionsHandler,
    rememberColumnMapping: rememberColumnMappingHandler,
    listDeclinedSplitNames: listDeclinedSplitNamesHandler,
    listCompoundCellDecisions: listCompoundCellDecisionsHandler,
    latestOpSeq: latestOpSeqHandler,
    resolveConflict,
    listPendingConflicts: listPendingConflictsHandler,
    getDevicePairingStatus,
    listPendingPairingRequests,
    listDevices,
    listPeerErasureState,
    importSetupRows: importSetupRowsHandler,
    approveDevice,
    denyDevice,
    revokeDevice,
    getSyncEngine,
    getJoinCode,
    setJoinWindow,
    joinStart,
    joinFindHost,
    joinRequestPairing,
    joinAwaitPairingDecision,
    joinLogin,
    joinAwaitData,
    joinCancel,
    // T274 final — the one-funnel guard: `startAutomergeSyncNodeIfEnabled`
    // reads this (via `liveHandlers`, same as `isJoinWindowOpen` below) to
    // refuse starting the PERSISTENT node while a join session is still
    // retained (in-flight, or kept alive after a failed stop — see
    // joinCancel's own comment). `activeJoin` is null on every path that
    // should NOT block a start: before any join, and after
    // joinAwaitData's successful camp materialization (which nulls it
    // before firing onCampJoined). It is non-null only while a join is
    // genuinely still live or stuck-retained, which is exactly the case a
    // second, PERSISTENT node on this device's same peer identity must not
    // be started underneath.
    hasRetainedJoinSession: () => activeJoin !== null,
    isJoinWindowOpen: () => joinWindowOpen,
    // T286 — the live secret, read by syncStarter.js's getJoinSecret forward,
    // the same wiring `isJoinWindowOpen` already uses.
    getJoinSecret: () => joinSecret,
    getSyncClient: () => syncClient,
    // T292 round 2 FIX 2 — the seam syncStarter.js's onRemoteOps calls (via
    // getLiveHandlers(), the same forwarding pattern isJoinWindowOpen/
    // getJoinSecret already use above) so a REMOTE merge schedules the
    // document write exactly like a local write does. Read via optional
    // chaining by every caller, so a stale/mocked handlers object without
    // this method is simply a no-op, never a throw.
    scheduleCampDataRecord: () => campDataRecordWriter.schedule(),
    // T292 round 2 FIX 5 — called by reinitialize()/the restore-backup
    // handler before the underlying db is closed, so this writer's pending
    // timer (which reads from `db`) cannot fire against a closed handle.
    disposeCampDataRecord: () => campDataRecordWriter.dispose(),
    // T292 round 2 FIX 3 — called from app's will-quit so a still-pending
    // debounced write is not lost to the process exiting first.
    flushCampDataRecord: () => campDataRecordWriter.flush(),
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

  // T19 + T175: the setup runs in an async IIFE so it can `await app.whenReady()` before touching
  // safeStorage (the at-rest key). Empirically, safeStorage.isEncryptionAvailable() is false BEFORE
  // ready and true after — acquiring the key at module top level (pre-ready) fails closed on a real
  // device. applyUserDataPath (setName) still runs pre-ready, synchronously, before the await. A
  // throw here is still SHOWN rather than swallowed (electron/startupFailure.js).
  ;(async () => {
  try {
  // MUST run before any app.getPath() call and before whenReady(), or setName
  // silently has no effect — see electron/db/userDataPath.js and
  // docs/adr/2026-07-28-explicit-userdata-directory.md. Without it Electron
  // infers the directory from argv, which put every dev clone in one shared
  // "Electron" directory while the packaged app used "shoresh".
  const userDataPath = applyUserDataPath(app)
  const defaultDbPath = path.join(userDataPath, 'shoresh.sqlite')

  // Stage 5e (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 5): wire liveDoc.js's
  // injected userDataDir getter unconditionally, at the same point every other userData-rooted
  // path in this file is established. This makes liveDoc.recordLocalWrite/ensureSeeded no longer
  // "gracefully inert" — but it is still a pure assignment, not a behavior branch: nothing reads
  // this getter unless isAutomergeEngine() is true (operations.js's appendOp gates recordLocalWrite
  // on isOpLogEngine() before ever calling it; startAutomergeSyncNodeIfEnabled below gates
  // ensureSeeded the same way). Flag-off therefore still executes zero new logic.
  setAutomergeUserDataDirGetter(() => userDataPath)

  // safeStorage (used by the at-rest key acquisition just below) is only usable AFTER the app is
  // ready — verified on a real device: isEncryptionAvailable() is false before ready, true after,
  // with a working encrypt/decrypt round-trip. Await it here. applyUserDataPath above already ran
  // (setName must precede ready); everything from here down now runs post-ready, which is the normal
  // place an Electron app opens its resources anyway.
  await app.whenReady()

  // At-rest encryption (ADR 2026-09-15, ticket T175): acquire the per-device document cipher and
  // inject it into liveDoc, so every .automerge read/write goes through it. Default OFF
  // (SHORESH_AT_REST_ENCRYPTION!='on') → acquireDocCipher returns null → liveDoc stays plaintext,
  // so this whole block is inert until the flag is deliberately turned on for the reviewed
  // real-app rollout. When ON, a missing/unavailable keychain key is fatal by design (no key = no
  // data), but it must arrive as the human recovery story, not a raw stack trace (assessment
  // finding 3) — see docs/current/KEY_RECOVERY_STORY.md.
  let docCipher = null
  let dbKey = null
  try {
    dbKey = acquireDbKey(userDataPath, safeStorage) // null when encryption is off → SQLite stays plaintext
    docCipher = acquireDocCipher(userDataPath, safeStorage)
  } catch (err) {
    console.error(
      'At-rest encryption is enabled but this device\'s storage key could not be obtained ' +
        `(${err?.message ?? err}). The camp data on this device cannot be read without it. This is ` +
        'by design — the key lives in the OS keychain and is not recoverable if that entry is gone. ' +
        'Recover by re-syncing this device from a paired peer, or re-pairing it fresh; see the ' +
        '"three keys, one event" recovery story (docs/current/KEY_RECOVERY_STORY.md). The app will ' +
        'not start with encryption on and no key.'
    )
    throw err // fail closed — never fall back to reading plaintext when encryption is on
  }
  setAutomergeDocCipher(docCipher)
  if (isAtRestEncryptionEnabled()) {
    console.log('At-rest encryption: ON — the camp document is encrypted on disk under the OS-keychain key.')
  }

  // Mutable state — swapped by project-lifecycle handlers (open/create/restore).
  let dbPath = getCurrentProjectPath(userDataPath, defaultDbPath)
  let db = openLocalDb(dbPath, { key: dbKey })
  let deviceId = getOrCreateDeviceId(db)

  let mainWindow = null

  // All IPC channels registered by makeHandlers. Keep in sync with the
  // ipcMain.handle calls in registerHandlers() below.
  const HANDLER_CHANNELS = [
    'shoresh:choose-mode',
    'shoresh:discover-hosts',
    'shoresh:login',
    'shoresh:create-user',
    'shoresh:promote-to-admin',
    'shoresh:bootstrap-camp',
    'shoresh:write',
    'shoresh:bulk-replace',
    'shoresh:verify-session',
    'shoresh:get-camp',
    'shoresh:camp-has-setup-data',
    'shoresh:list-users',
    'shoresh:list',
    'shoresh:list-by-scope',
    'shoresh:get-device-id',
    'shoresh:get-sync-status',
    'shoresh:retry-sync',
    'shoresh:ingest-commit',
    'shoresh:ingest-reconcile',
    'shoresh:ingest-undo',
    'shoresh:confirm-alias',
    'shoresh:record-declined-split',
    'shoresh:list-declined-split-names',
    'shoresh:latest-op-seq',
    'shoresh:resolve-conflict',
    'shoresh:list-conflicts',
    'shoresh:list-deleted',
    'shoresh:list-pending-restores',
    'shoresh:get-entity-history',
    'shoresh:restore-entity',
    'shoresh:preview-delete',
    'shoresh:delete-record',
    'shoresh:delete-elective-run',
    'shoresh:merge-location',
    'shoresh:merge-activity',
    'shoresh:preview-activity-merge',
    'shoresh:list-migration-reviews',
    'shoresh:dismiss-migration-reviews',
    'shoresh:get-device-pairing-status',
    'shoresh:list-pending-pairing-requests',
    'shoresh:list-devices',
    'shoresh:list-peer-erasure-state',
    'shoresh:import-setup-rows',
    'shoresh:approve-device',
    'shoresh:get-sync-engine',
    'shoresh:get-join-code',
    'shoresh:set-join-window',
    'shoresh:join-start',
    'shoresh:join-find-host',
    'shoresh:join-request-pairing',
    'shoresh:join-await-pairing-decision',
    'shoresh:join-login',
    'shoresh:join-await-data',
    'shoresh:join-cancel',
    'shoresh:deny-device',
    'shoresh:revoke-device',
    'shoresh:duplicate-week',
    'shoresh:delete-week',
    'shoresh:attribute-subject',
  ]

  function registerHandlers(handlers, currentDb) {
    // Whichever handler set is currently registered. Needed because the
    // automerge sync node (started separately, and surviving a project switch)
    // has to ask the LIVE handlers whether the director's Add-a-device window
    // is open — reading a captured `initialHandlers` would silently consult a
    // stale set after a switch.
    liveHandlers = handlers
    // Remove existing registrations before re-registering (project switch).
    for (const ch of HANDLER_CHANNELS) ipcMain.removeHandler(ch)

    ipcMain.handle('shoresh:choose-mode', (_event, args) => handlers.chooseMode(args))
    ipcMain.handle('shoresh:login', (_event, args) => handlers.login(args))
    ipcMain.handle('shoresh:create-user', (_event, args) => handlers.createUser(args))
    ipcMain.handle('shoresh:promote-to-admin', (_event, args) => handlers.promoteToAdmin(args))
    ipcMain.handle('shoresh:bootstrap-camp', (_event, args) => handlers.bootstrapCamp(args))
    ipcMain.handle('shoresh:write', (_event, args) => handlers.write(args))
    ipcMain.handle('shoresh:bulk-replace', (_event, args) => handlers.bulkReplace(args))
    ipcMain.handle('shoresh:verify-session', (_event, args) => handlers.verifySession(args))
    // get-camp is pre-auth (called before a session exists to decide the
    // bootstrap-vs-join phase). See the note in the original registration
    // block for the full justification.
    ipcMain.handle('shoresh:get-camp', () => currentDb.prepare('SELECT id, name FROM camps LIMIT 1').get())
    // Stage-aware landing (docs/adr/2026-08-28-stage-aware-nav-landing.md
    // Decision 1) — pre-auth like get-camp above (called before a session
    // exists, inside useDeviceMode's init effect). A single cheap existence
    // check over the required-setup tables (same set REQUIRED_AREAS in
    // src/engine/readiness.js treats as the blocking core), never
    // getReadiness's full five-collection engine pass — the landing decision
    // only ever needs the one "is this camp truly untouched" bit. Returns
    // true the moment ANY required table has a row.
    ipcMain.handle('shoresh:camp-has-setup-data', () => campHasSetupData(currentDb))
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
    ipcMain.handle('shoresh:retry-sync', () => handlers.retrySync())
    ipcMain.handle('shoresh:ingest-commit', (_event, args) => handlers.ingestCommit(args))
    ipcMain.handle('shoresh:ingest-reconcile', (_event, args) => handlers.ingestReconcile(args))
    ipcMain.handle('shoresh:ingest-undo', (_event, args) => handlers.ingestUndo(args))
    ipcMain.handle('shoresh:confirm-alias', (_event, args) => handlers.confirmAlias(args))
    ipcMain.handle('shoresh:record-declined-split', (_event, args) => handlers.recordDeclinedSplit(args))
    ipcMain.handle('shoresh:record-import-decisions', (_event, args) => handlers.recordImportDecisions(args))
    ipcMain.handle('shoresh:remember-column-mapping', (_event, args) => handlers.rememberColumnMapping(args))
    ipcMain.handle('shoresh:list-declined-split-names', (_event, args) => handlers.listDeclinedSplitNames(args))
    ipcMain.handle('shoresh:list-compound-cell-decisions', (_event, args) => handlers.listCompoundCellDecisions(args))
    ipcMain.handle('shoresh:latest-op-seq', () => handlers.latestOpSeq())
    ipcMain.handle('shoresh:resolve-conflict', (_event, args) => handlers.resolveConflict(args))
    ipcMain.handle('shoresh:list-conflicts', (_event, args) => handlers.listPendingConflicts(args && args.token))
    ipcMain.handle('shoresh:list-deleted', (_event, args) => handlers.listDeleted(args && args.token))
    ipcMain.handle('shoresh:list-pending-restores', (_event, args) => handlers.listPendingRestores(args && args.token))
    ipcMain.handle('shoresh:get-entity-history', (_event, args) => handlers.getEntityHistory(args))
    ipcMain.handle('shoresh:restore-entity', (_event, args) => handlers.restoreEntity(args))
    ipcMain.handle('shoresh:preview-delete', (_event, args) => handlers.previewDelete(args))
    ipcMain.handle('shoresh:delete-record', (_event, args) => handlers.deleteRecord(args))
    ipcMain.handle('shoresh:delete-elective-run', (_event, args) => handlers.deleteElectiveRun(args))
    ipcMain.handle('shoresh:merge-location', (_event, args) => handlers.mergeLocation(args))
    ipcMain.handle('shoresh:merge-activity', (_event, args) => handlers.mergeActivity(args))
    ipcMain.handle('shoresh:preview-activity-merge', (_event, args) => handlers.previewActivityMerge(args))
    ipcMain.handle('shoresh:list-migration-reviews', (_event, args) => handlers.listMigrationReviews(args && args.token))
    ipcMain.handle('shoresh:dismiss-migration-reviews', (_event, args) => handlers.dismissMigrationReviews(args))
    ipcMain.handle('shoresh:list-open-reconciliation-decisions', (_event, args) => handlers.listOpenReconciliationDecisions(args))
    ipcMain.handle('shoresh:dismiss-open-reconciliation-decisions', (_event, args) => handlers.dismissOpenReconciliationDecisions(args))
    ipcMain.handle('shoresh:get-device-pairing-status', () => handlers.getDevicePairingStatus())
    ipcMain.handle('shoresh:list-pending-pairing-requests', (_event, args) => handlers.listPendingPairingRequests(args))
    ipcMain.handle('shoresh:list-devices', (_event, args) => handlers.listDevices(args))
    ipcMain.handle('shoresh:list-peer-erasure-state', (_event, args) => handlers.listPeerErasureState(args))
    ipcMain.handle('shoresh:import-setup-rows', (_event, args) => handlers.importSetupRows(args))
    ipcMain.handle('shoresh:approve-device', (_event, args) => handlers.approveDevice(args))
    ipcMain.handle('shoresh:get-sync-engine', () => handlers.getSyncEngine())
    ipcMain.handle('shoresh:get-join-code', (_event, args) => handlers.getJoinCode(args))
    ipcMain.handle('shoresh:set-join-window', (_event, args) => handlers.setJoinWindow(args))
    ipcMain.handle('shoresh:join-start', (_event, args) => handlers.joinStart(args))
    ipcMain.handle('shoresh:join-find-host', () => handlers.joinFindHost())
    ipcMain.handle('shoresh:join-request-pairing', () => handlers.joinRequestPairing())
    ipcMain.handle('shoresh:join-await-pairing-decision', () => handlers.joinAwaitPairingDecision())
    ipcMain.handle('shoresh:join-login', (_event, args) => handlers.joinLogin(args))
    ipcMain.handle('shoresh:join-await-data', () => handlers.joinAwaitData())
    ipcMain.handle('shoresh:join-cancel', () => handlers.joinCancel())
    ipcMain.handle('shoresh:deny-device', (_event, args) => handlers.denyDevice(args))
    ipcMain.handle('shoresh:revoke-device', (_event, args) => handlers.revokeDevice(args))
    ipcMain.handle('shoresh:duplicate-week', (_event, args) => handlers.duplicateWeek(args))
    ipcMain.handle('shoresh:delete-week', (_event, args) => handlers.deleteWeek(args))
    ipcMain.handle('shoresh:attribute-subject', (_event, args) => handlers.attributeSubject(args))
    ipcMain.handle('shoresh:delete-elective-set', (_event, args) => handlers.deleteElectiveSet(args))
    ipcMain.handle('shoresh:delete-special-day', (_event, args) => handlers.deleteSpecialDay(args))
    ipcMain.handle('shoresh:delete-event', (_event, args) => handlers.deleteEvent(args))
    ipcMain.handle('shoresh:list-durable-elective-sets', (_event, args) => handlers.listDurableElectiveSets(args && args.token))
    ipcMain.handle('shoresh:commit-elective-run', (_event, args) => handlers.commitElectiveRun(args))
    ipcMain.handle('shoresh:list-elective-runs', (_event, args) => handlers.listElectiveRuns(args && args.token))
    ipcMain.handle('shoresh:get-elective-run', (_event, args) => handlers.getElectiveRun(args))
    ipcMain.handle('shoresh:finalize-elective-run', (_event, args) => handlers.finalizeElectiveRun(args))
    ipcMain.handle('shoresh:set-elective-assignment', (_event, args) => handlers.setElectiveAssignment(args))
  ipcMain.handle('shoresh:set-elective-preference', (_event, args) => handlers.setElectivePreference(args))
  ipcMain.handle('shoresh:remove-elective-preference', (_event, args) => handlers.removeElectivePreference(args))
    ipcMain.handle('shoresh:get-security-status', () => handlers.getSecurityStatus())
    ipcMain.handle('shoresh:list-import-evidence', (_event, args) => handlers.listImportEvidence(args && args.token))
    ipcMain.handle('shoresh:list-division-evidence', (_event, args) => handlers.listDivisionEvidence(args && args.token))
    ipcMain.handle('shoresh:location-capacity-provenance', (_event, args) => handlers.locationCapacityProvenance(args && args.token))
    ipcMain.handle('shoresh:get-elective-run-outer-schedule', (_event, args) => handlers.getElectiveRunOuterSchedule(args))
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
    const newDb = openLocalDb(newPath, { key: dbKey }) // throws schema_too_new if applicable; keyed when encryption is on
    const newDeviceId = getOrCreateDeviceId(newDb)
    const newHandlers = makeHandlers(newDb, newDeviceId, {
      getMainWindow: () => mainWindow,
      dbPath: newPath,
      userDataPath,
    })

    // New db is open and handlers built — safe to swap. T292 round 2 FIX 5:
    // dispose the OLD writer first — its pending debounced timer reads from
    // `db`, so it must not still be armed once that handle closes.
    disposeCampDataRecordThenCloseDb(liveHandlers, db)
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
      build: formatBuildLabel(readBuildInfo(__dirname, app.isPackaged), readAppVersion(__dirname)),
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
      // Keyed when encryption is on: a restored plaintext backup is migrated to encrypted on open.
      newDb = openLocalDb(dbPath, { key: dbKey })
    } catch (err) {
      return { error: 'restore_failed', message: err.message }
    }

    // T292 round 2 FIX 5 — same reasoning as reinitialize() above.
    disposeCampDataRecordThenCloseDb(liveHandlers, db)
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

  // Declared here (ahead of automergeSyncNode's own definition further down)
  // so makeHandlers' chooseMode/login closures can reach whatever node is
  // running by the time THEY run, without makeHandlers needing to know
  // anything about libp2p/Automerge itself — same "handed a getter, not the
  // implementation" shape as getMainWindow above.
  // Set by registerHandlers; see its comment.
  let liveHandlers = null
  // T276 — the starter (extracted to electron/sync/automerge/syncStarter.js
  // so its behaviour is executed under Vitest, not just asserted on AST
  // shape) holds its own closure state: the persistent node handle, the
  // TOCTOU in-flight latch, and the startup-attempted flag. `getLiveHandlers`
  // must stay a getter, not a captured value — `liveHandlers` above is
  // reassigned by registerHandlers after this factory is constructed, so a
  // captured value would be stale/null forever.
  const syncStarter = createAutomergeSyncStarter({
    deviceId,
    db,
    userDataPath,
    docCipher,
    getMainWindow: () => mainWindow,
    getLiveHandlers: () => liveHandlers,
  })
  const startAutomergeSyncNodeIfEnabled = () => syncStarter.start()
  const initialHandlers = makeHandlers(db, deviceId, {
    getMainWindow: () => mainWindow,
    dbPath,
    userDataPath,
    getAutomergeSyncNode: () => syncStarter.getNode(),
    getAutomergeStartupAttempted: () => syncStarter.getStartupAttempted(),
    // T273 — the only thing that starts sync on the session that creates the
    // camp. Its own `if (automergeSyncNode) return` idempotency guard makes a
    // second invocation (app.whenReady's, already returned by then) harmless.
    onCampBootstrapped: () => startAutomergeSyncNodeIfEnabled(),
    // T274 — the join-path mirror: the only thing that starts sync on the
    // session that JOINS a camp. joinAwaitData stops the temporary join node
    // before calling this, so there is never a second live libp2p node with
    // this device's peer identity; startAutomergeSyncNodeIfEnabled's own
    // idempotency guard makes any further redundant invocation harmless too.
    onCampJoined: () => startAutomergeSyncNodeIfEnabled(),
    // T275 — the sidebar's retry affordance for host-not-syncing. Same
    // starter, same guards; a director tapping "try again" is no different
    // from any other caller of startAutomergeSyncNodeIfEnabled.
    retrySync: () => startAutomergeSyncNodeIfEnabled(),
  })
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
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
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

  // C6 — the Licenses window. A standalone BrowserWindow rather than an AppShell
  // screen, deliberately: AppShell only renders at phase === 'session', and a
  // menu item that is dead at mode-select/login/bootstrap/join (pairing is
  // awaited inline within JoinByCodeScreen, not a separate phase) is a bug
  // (D6). It loads the static, generated HTML with no preload and no
  // node integration — it is public text and needs no privilege. Reuses the
  // existing window instead of stacking duplicates.
  let licensesWindow = null
  function showLicensesWindow() {
    if (licensesWindow && !licensesWindow.isDestroyed()) {
      licensesWindow.focus()
      return
    }
    // The page renders text interpolated from third-party package metadata
    // (homepage URLs, license text) — deny popups and block navigation away
    // from the local file as defense-in-depth, on top of renderHtml's own
    // escaping and homepage-scheme allowlist.
    const win = new BrowserWindow({
      width: 760,
      height: 720,
      title: 'Third-Party Licenses',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    })
    win.setMenuBarVisibility(false)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())

    const licensesPath = path.join(__dirname, 'third-party-licenses.html')
    if (!fs.existsSync(licensesPath)) {
      win.destroy()
      dialog.showErrorBox(
        'Licenses unavailable',
        'third-party-licenses.html was not found. Run `npm run licenses` to generate it.'
      )
      return
    }
    licensesWindow = win
    licensesWindow.loadFile(licensesPath)
    licensesWindow.on('closed', () => {
      licensesWindow = null
    })
  }

  // C4/C5 — the application menu and About panel, installed once at startup.
  // Shoresh sets no menu today and inherits Electron's default; installMenu
  // replaces it wholesale, so the template re-declares every standard editing/
  // window role (see electron/menu.js's header comment for why this matters).
  //
  // setAboutPanelOptions + role:'about' is supported on all platforms in
  // Electron 43.1.1 (verified against that version's own docs: neither API nor
  // role:'about' carries a platform tag, and `credits` is tagged macOS+Windows,
  // which only makes sense if Windows renders a panel) — no dialog.showMessageBox
  // fallback is needed. On Linux, values must be set explicitly to show at all,
  // which is why every field is passed rather than left to a default.
  function installAppMenuAndAboutPanel() {
    app.setAboutPanelOptions(
      buildAboutPanelOptions({
        info: readBuildInfo(__dirname, app.isPackaged),
        version: readAppVersion(__dirname),
      })
    )
    installMenu({
      Menu,
      isMac: process.platform === 'darwin',
      onShowLicenses: showLicensesWindow,
      onOpenGitHub: () => shell.openExternal('https://github.com/gfeitel1-maker/Scheduling-Project-'),
      onReportIssue: () => shell.openExternal('https://github.com/gfeitel1-maker/Scheduling-Project-/issues'),
    })
  }

  app.whenReady().then(() => {
    try {
      installAppMenuAndAboutPanel()
    } catch (err) {
      // A menu/About-panel failure must never take the app down — the window
      // still needs to open even if this step errors.
      console.error(`menu/about-panel install failed (non-fatal): ${err?.message ?? err}`)
    }
    try {
      createWindow()
    } catch (err) {
      reportStartupFailure(err)
    }
    startAutomergeSyncNodeIfEnabled()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('will-quit', async () => {
    // Stage 5e item 3: flush any debounced Automerge doc save before the process exits, so a
    // deliberate quit never loses a write to the durability window liveDoc.js's scheduleSave
    // documents (up to SAVE_DEBOUNCE_MS of in-memory-only writes otherwise). A no-op when nothing
    // is pending (flag off, or nothing written since the last flush).
    try {
      flushAutomergeDoc()
    } catch (err) {
      console.error('automerge sync: flush on quit failed (non-fatal):', err?.message ?? err)
    }
    // T292 round 2 FIX 3 — flush any still-pending debounced camp data
    // document write before the process exits. See flushCampDataRecordOnQuit.
    flushCampDataRecordOnQuit(liveHandlers)
    const automergeSyncNode = syncStarter.getNode()
    if (automergeSyncNode) {
      try {
        await automergeSyncNode.stop()
      } catch { /* shutting down anyway */ }
    }
  })
  } catch (err) {
    reportStartupFailure(err)
  }
  })()
}
