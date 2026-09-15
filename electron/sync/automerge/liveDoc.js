// Stage 5b/5e/5f live wiring (docs/work/plans/2026-09-06-stage5-live-wiring-design.md §§ 2, 5): the
// in-process singleton that holds "the current camp's Automerge document" for the flagged
// (SHORESH_SYNC_ENGINE=automerge) path only. `operations.js`'s `appendOp` calls
// `recordLocalWrite` after its own op-log transaction has already committed — this module never
// participates in that transaction and never throws out of it (see operations.js's try/catch at
// the call site).
//
// userDataDir and campId are both injected/derived, never hardcoded, so this stays testable
// without Electron: userDataDir defaults to a getter the caller can override
// (setUserDataDirGetter), matching electron/db/userDataPath.js's injected-path pattern; campId is
// read fresh from `db` on every call (`SELECT id FROM camps LIMIT 1`, this repo's one-camp-per-
// device-db convention) so a test can swap `db` between cases without this module caching a stale
// camp.
//
// Stage 5e added two things on top of 5b's mechanism:
//   - seed-on-first-touch (getDoc's cache-miss branch): the FIRST time this module needs a doc for
//     a camp and no file exists yet on disk, it seeds from the camp's CURRENT SQLite rows
//     (automerge/seed.js) rather than starting from an empty document — closing the exact hazard
//     projector.js's assertDocIsSupersetOrEmpty guards against (an unseeded doc's delete-reconcile
//     wiping a live camp). This fires from BOTH entry points that can need a doc first: a write
//     arriving via recordLocalWrite, and main.js's own explicit ensureSeeded() call at startup —
//     whichever happens first for a given camp seeds it, and the guard's cache means it can only
//     happen once per camp per process.
//   - debounced persistence (see scheduleSave/flushPendingWrites below): a full `A.save` + fsync on
//     every single field-op does not scale to a bulk import of thousands of ops.
//
// Stage 5f (confirmed defect fix — two independent doc holders that never reconciled): before this
// stage, this module's own `docsByCamp` map and syncNode.js's private `state.doc` were separate
// Automerge documents. `docsByCamp` was mutated by every local write and was the only thing ever
// persisted; `state.doc` was mutated by every remote merge and never persisted at all. They
// diverged from the first write, and the routine sequence "device receives a remote merge, then
// makes any unrelated local edit, then restarts" silently deleted the remotely-merged row (the
// restart's projection ran against liveDoc's STALE copy, which delete-reconciled the row away).
//
// The fix: `docRegistry` below is now the ONE place "the current in-memory doc for this db" lives.
// It is keyed by the `db` handle's OWN identity (a WeakMap), not by campId — campId is still used
// for persistence (the file is named by campId), but the in-memory slot is per-db so that two
// separate device dbs that happen to report the same campId (only ever happens in tests that spin
// up two nodes in one process; production is structurally one camp per device db, per this
// project's convention) never collide. `recordLocalWrite` (this module) and `syncNode.handleReceived`/
// `applyLocal` (syncNode.js) now both read and write through `getCurrentDoc`/`setCurrentDoc` below,
// so there is exactly one document per db, and it is the thing this module persists.
//
// Serialization/reentrancy: `docRegistry` is a plain synchronous Map access — no locks needed.
// `recordLocalWrite` runs synchronously inside `appendOp`'s call site (after its own transaction
// commits). `syncNode.handleReceived` reads/replaces the registry entry synchronously too, with no
// `await` between reading the pre-merge doc and writing the merged one (the only `await` in that
// function is the LATER re-broadcast, after the doc is already updated) — so even though
// `handleReceived` is an async function, Node's single-threaded run-to-completion semantics mean
// there is no window where a local write and a remote merge can interleave mid-update. Both sides
// always read the latest value and write back synchronously before yielding to the event loop.
import { docPath, loadDoc, saveDoc } from './docStore.js'
import { recordDocumentWriteFailure, documentWriteFailureRecorded } from '../../ops/documentWriteFailures.js'
import { DOCUMENT_OUTCOME } from '../../ops/documentOutcome.js'
import { recordSyncHealthEvent, SYNC_HEALTH } from '../../ops/syncHealthEvents.js'
import { applyWrite, applyBulkReplace, MODELED_ENTITIES, BULK_REPLACE_MODELED_ENTITIES } from '../../automerge/campDocument.js'
import { seedAllFromSqlite } from '../../automerge/seed.js'

// null until wired: production startup wiring is Stage 5e (main.js calls
// setUserDataDirGetter with the real userData path); tests call it directly. If
// the flag is turned on BEFORE that wiring runs, recordLocalWrite is gracefully
// inert (one warning, never a per-write throw) rather than throwing on every
// write — see recordLocalWrite. This keeps the mechanism testable in isolation.
let userDataDirGetter = null
let warnedUnconfigured = false

// db -> current in-memory Automerge doc for that db's camp (Stage 5f). Keyed by db identity, not
// campId — see module comment above for why. In production there is exactly one db per process, so
// this is effectively a single entry, same as before.
let docRegistry = new WeakMap()

// Stage 5f item 2 (local writes must broadcast): set by the caller that owns the sync transport
// (main.js, once the automerge sync node has started) to `(doc) => node.broadcastLocalDoc(doc)`.
// Invoked from flushPendingWrites, debounced exactly like the save itself — never per field-op —
// and ONLY for a debounce window that included at least one local write (a window that only ever
// saw a remote merge is already broadcast by syncNode's own re-broadcast-on-receive). null in every
// test that doesn't care about broadcast, and in any process before a sync node has started.
// Keyed by db, not a single module-global. One PROCESS is one device in
// production, so a global looked equivalent — but it is not, and the difference
// is not only a test concern: with two nodes in one process the second
// `setLocalWriteBroadcaster` silently replaced the first, so writes on one
// device pushed through the other device's node, or through a node that had
// already stopped. Integration scenario 30 failed on exactly that, and only
// when other scenarios had run first, which is the signature of shared global
// state rather than of a bug in the scenario.
let broadcastCallbacks = new WeakMap()

// Debounce state for saveDoc/broadcast (Stage 5e item 3, extended in 5f to also drive the local-
// write broadcast off the SAME timer — see module comment). Keyed by campId (the persistence unit),
// value is `{ db, local }`: `db` so the flush can look up the current doc in `docRegistry`, `local`
// so the flush knows whether to broadcast (true if ANY write in this window was a local one).
const SAVE_DEBOUNCE_MS = 250
// Only ever used to make one incident's console lines greppable together.
let failureCounter = 0
let pendingTimer = null
let pendingSaves = new Map()

export function setUserDataDirGetter(getter) {
  userDataDirGetter = getter
}

export function setLocalWriteBroadcaster(db, fn) {
  if (!db) throw new Error('setLocalWriteBroadcaster: db is required — the broadcaster is per-device')
  broadcastCallbacks.set(db, fn)
}

// Keyed by `db`, NOT module-global — the same discipline docRegistry and
// broadcastCallbacks above already use, for the reason documented there:
// integration scenarios run two devices in ONE process, and shared global state
// made one device's node serve the other's writes (scenario 30). A global depth
// counter here would be the same mistake: device A's rollback would discard
// device B's already-committed buffer.
let deferStates = new WeakMap() // db -> { depth, queue }

function deferStateFor(db) {
  let state = deferStates.get(db)
  if (!state) {
    state = { depth: 0, queue: [] }
    deferStates.set(db, state)
  }
  return state
}

export function resetForTests() {
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = null
  pendingSaves = new Map()
  docRegistry = new WeakMap()
  userDataDirGetter = null
  warnedUnconfigured = false
  broadcastCallbacks = new WeakMap()
  // Without this, a test whose transaction throws leaves a depth > 0 and every
  // subsequent test silently buffers its document writes forever.
  deferStates = new WeakMap()
}

function getCampId(db) {
  return db.prepare('SELECT id FROM camps LIMIT 1').get()?.id ?? null
}

// Stage 5f: the shared accessor syncNode.js uses for both reading "the current doc" and replacing
// it after a remote merge — see module comment above. Returns undefined/null when nothing has been
// set for this db yet (syncNode always sets one at startup before ever reading it).
export function getCurrentDoc(db) {
  return docRegistry.get(db) ?? null
}

// Stage 5f: syncNode calls this after a remote merge advances the doc, and once at startup to seed
// the registry from the doc its caller resolved (main.js's already-seeded/resolved doc). Schedules
// the SAME debounced save recordLocalWrite uses (not local-origin, so it does not trigger a
// broadcast — syncNode already re-broadcasts a remote merge itself, via its own except-self relay).
export function setCurrentDoc(db, doc, { persist = true } = {}) {
  docRegistry.set(db, doc)
  // persist:false is for a merge that produced NO new heads. The registry still MUST be updated
  // (A.merge consumes its first argument, so the previously-registered handle is now invalid and
  // any later A.change on it throws "Attempting to change an outdated document"), but there is
  // nothing new to write to disk, so scheduling a save would be pure churn.
  if (!persist) return
  if (!userDataDirGetter) return
  const campId = getCampId(db)
  if (!campId) return
  const userDataDir = userDataDirGetter()
  if (!userDataDir) return
  scheduleSave(db, userDataDir, campId, { local: false })
}

// Stage 5c (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 5): read-only lookup for
// main.js's sync-node startup — "use the doc liveDoc already holds for this camp, if any, rather
// than loading a second independent copy from disk". Returns null (never creates or loads) when
// this module hasn't seen or seeded a doc for the camp yet.
export function getDocIfLoaded(db) {
  return getCurrentDoc(db)
}

// Cache-miss path: load the persisted doc, or — if this camp has never been persisted before —
// seed one from the camp's current SQLite rows (never a bare createEmptyDoc(); see the module
// comment and projector.js's assertDocIsSupersetOrEmpty). A freshly seeded doc is saved
// immediately, synchronously, not debounced: this is a one-time event per camp per process, not a
// per-field-op hot path, and it must land on disk before any projectAll can run against it.
function getDoc(db, userDataDir, campId, { persistSeed = true } = {}) {
  const cached = getCurrentDoc(db)
  if (cached) return cached
  let doc = loadDoc(userDataDir, campId)
  if (!doc) {
    doc = seedAllFromSqlite(db)
    // `persistSeed: false` when this seed is happening INSIDE a write — see
    // recordLocalWrite. Saving the seed there writes a document that is missing
    // the very write that triggered it, and that partial document is what a
    // crash inside the debounce window would leave on disk.
    if (persistSeed) saveDoc(userDataDir, campId, doc)
  }
  docRegistry.set(db, doc)
  return doc
}

// Stage 5e item 1 (seed-on-first-enable): main.js's startup calls this before resolving which doc
// to hand the sync node, so a camp that has never run with the flag on gets seeded from its current
// SQLite rows before anything can project against it. Returns the doc (seeding/persisting it if
// this is the first time), or null when there is nothing to seed against yet (unconfigured, or no
// camp bootstrapped). Idempotent per camp per process: a second call just returns the cached doc.
export function ensureSeeded(db) {
  if (!userDataDirGetter) return null
  const campId = getCampId(db)
  if (!campId) return null
  const userDataDir = userDataDirGetter()
  if (!userDataDir) return null
  return getDoc(db, userDataDir, campId)
}

// Stage 5e item 3 (extended 5f item 2): coalesce saves AND local-write broadcasts onto the same
// timer. `recordLocalWrite`/`setCurrentDoc` are called once per field-op — a bulk import can call
// either thousands of times in a tight loop, and a full `A.save` + fsync (or a broadcast) per call
// would stall the main process. Instead, mark the campId dirty (remembering which db to read the
// current doc from, and whether any write in this window was local) and — if nothing is already
// scheduled — start one timer; when it fires, every dirty campId's CURRENT in-memory doc is written
// (and, for windows with a local write, broadcast) once, however many writes accumulated.
//
// Durability window: up to SAVE_DEBOUNCE_MS (or until flushPendingWrites() runs, e.g. at app quit)
// of field-writes exist only in memory, not yet on disk, if the process crashes.
//
// WHAT THIS COSTS, STATED HONESTLY. The document is the authoritative, replicated state and SQLite
// is the projection of it (docs/current/WHERE_DATA_LIVES.md) — the reverse of what this comment
// said through Stage 5, when the document was still a scaffold. So a crash inside this window does
// NOT leave "the authoritative record intact and a stale mirror": it leaves SQLite holding a write
// the authoritative document does not have. That is survivable rather than destructive, and only
// because of one deliberate decision: startup performs NO projectAll (see main.js's sync-node
// startup), so nothing reverts SQLite to the stale document on the next launch. The divergence is
// real, bounded to the window, and persists silently until some later merge projects the older
// value over it. Closing it properly means a synchronous save (rejected: a full A.save + fsync per
// field-op does not survive a bulk import) or a write-ahead of pending ops; neither is built.
// Meanwhile a deliberate quit flushes (main.js's will-quit), and a FAILED save is now recorded
// rather than thrown into the void (see flushPendingWrites). Re-seeding from SQLite remains the
// deliberate operational repair, not an automatic reseed on every restart (which would also
// discard genuine Automerge-only history, e.g. tombstones — see the design doc §5's own reasoning
// against reseeding on every restart).
function scheduleSave(db, userDataDir, campId, { local = false, opId = null } = {}) {
  const existing = pendingSaves.get(campId)
  // The op ids in flight for THIS window. If the save at the end of it fails,
  // these are the ops that reached SQLite and never reached the document file
  // — the only moment they are still identifiable, which is the whole reason
  // to carry them (see flushPendingWrites).
  const opIds = existing?.opIds ?? new Set()
  if (opId) opIds.add(opId)
  pendingSaves.set(campId, { db, local: local || Boolean(existing?.local), opIds })
  if (pendingTimer) return
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    flushPendingWrites()
  }, SAVE_DEBOUNCE_MS)
  // Never hold the process open just for this timer (matters for app quit / test teardown).
  pendingTimer.unref?.()
}

// Flush every campId with an unsaved in-memory doc to disk immediately, synchronously, and
// broadcast to peers any campId whose pending window included a local write. Called by main.js on
// app quit (so the debounce window never loses a write the user thinks was saved when they quit
// deliberately) and available to tests that need to observe a debounced save without waiting out
// the timer.
export function flushPendingWrites() {
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  if (pendingSaves.size === 0) return
  const userDataDir = userDataDirGetter?.()
  const entries = pendingSaves
  pendingSaves = new Map()
  if (!userDataDir) return
  for (const [campId, { db, local, opIds }] of entries) {
    const doc = getCurrentDoc(db)
    if (!doc) continue
    // THE FSYNC IS THE THIRD PLACE A WRITE CAN BE LOST, and it used to be the
    // only one with no container and no record. `applyWrite` failing in memory
    // is retried and recorded (documentWriteFailures.js); a rollback around a
    // document write is held by runAtomic (operations.js). This is neither: the
    // document is correct in memory and the DISK write fails (a full or
    // unwritable disk, a path that is no longer a directory). Uncontained it
    // throws out of a setTimeout callback — an uncaught main-process exception
    // — and every write in the window is silently missing from the file, with
    // the op ids that would identify them already discarded.
    //
    // So: contain it, record every op that was in the window against the SAME
    // `store='document'` ledger an in-memory failure uses (the divergence is
    // identical — SQLite has it, the document does not — and so is the repair),
    // and never let one camp's failure skip another's save or its broadcast.
    try {
      saveDoc(userDataDir, campId, doc)
    } catch (err) {
      // A CORRELATION ID, because the recovery can fail too and Red Hat was
      // right that it fails hardest exactly when it matters most. The motivating
      // fault is a full disk — and `recordDocumentWriteFailure`/`recordAuditEvent`
      // are SQLite inserts to the same disk, both deliberately never-throwing. So
      // under sustained ENOSPC this whole mechanism can degrade to console lines,
      // which is the pre-fix behaviour. It cannot be fixed by trying harder on
      // the same disk; what it can have is a tag that ties the three otherwise
      // unrelated console lines into one incident, and a check below that says
      // plainly when nothing durable landed rather than implying it did.
      const incident = `docsave-${campId}-${failureCounter++}`
      console.error(`[${incident}] document save failed for camp ${campId} (SQLite already committed, unaffected):`, err)
      for (const opId of opIds ?? []) {
        recordDocumentWriteFailure(db, { op_id: opId, entity: 'document', entity_id: campId, field: 'save', error: err })
      }
      // A remote merge schedules a save with no op ids of its own (nothing
      // local was written). Losing THAT save is still a real divergence — the
      // in-memory document is ahead of the file — and would otherwise leave no
      // trace at all, so it is recorded as a device event rather than nothing.
      // T174: this used to call recordAuditEvent with outcome:'error', which
      // audit_events' CHECK constraint rejects — so the "durable trace" advertised
      // here never landed a row, and check_projection_health reported healthy
      // because it could read nothing back. Its own table now, and the return
      // value is checked below rather than assumed.
      const healthRecorded = recordSyncHealthEvent(db, {
        campId,
        kind: SYNC_HEALTH.DOCUMENT_SAVE_FAILED,
        incident,
        detail: JSON.stringify({ pendingOpCount: opIds?.size ?? 0, error: String(err?.message ?? err) }),
      })
      // Did the durable trace actually land? If the disk is gone, no. Saying so
      // is the difference between a degraded mechanism and a mechanism that
      // lies about having worked.
      if (!documentWriteFailureRecorded(db, opIds) || !healthRecorded) {
        console.error(
          `[${incident}] NOTHING DURABLE WAS RECORDED for this failure — the recovery write failed too ` +
            `(most likely the same full or unwritable disk). ${opIds?.size ?? 0} write(s) are in SQLite and ` +
            `not in the document, and this console line is the only trace that exists.`
        )
      }
      continue
    }
    const broadcast = broadcastCallbacks.get(db)
    // `broadcast` resolves to syncNode's broadcastLocalDoc, which is async and
    // is deliberately not awaited (a flush must not block on the network). Both
    // halves of that need guarding or a failure to PROPAGATE a saved write is
    // exactly as invisible as a failure to SAVE one used to be: a synchronous
    // throw would abort this camp's iteration, and a rejection would surface as
    // an unhandled promise rejection and nothing else.
    if (local && broadcast) {
      try {
        const result = broadcast(doc)
        if (result && typeof result.catch === 'function') {
          result.catch((err) => console.error(`document broadcast failed for camp ${campId} (saved locally, peers may be stale):`, err))
        }
      } catch (err) {
        console.error(`document broadcast failed for camp ${campId} (saved locally, peers may be stale):`, err)
      }
    }
  }
}

// Mirror one op-log write into the held Automerge doc, if `entity` is modeled. Unmodeled entities
// (parent-scoped entities, template_slots, host-only tables) are a deliberate scope
// fence (see campDocument.js's MODELED_ENTITIES) — they stay op-log-only, silently, not an error.
//
// This is ALSO the local half of Stage 5f's unification: the doc this reads and writes
// (getDoc/docRegistry) is the exact same one syncNode.js's remote-merge path reads and writes, so a
// local edit always builds on top of whatever the last remote merge left behind, never a stale copy.
function applyLocalWriteNow(db, { entity, entity_id, field, value, source, author_user_id, op_id = null }) {
  if (!MODELED_ENTITIES.has(entity)) return

  // Not wired yet (pre-Stage-5e): stay gracefully inert — warn ONCE, never
  // throw per write. SQLite still has the write either way; what is lost is
  // replication of it, which is exactly what this warning is for.
  if (!userDataDirGetter) {
    if (!warnedUnconfigured) {
      console.warn(
        'liveDoc: userDataDir not configured — Automerge dual-write is inert until Stage 5e wires it at startup'
      )
      warnedUnconfigured = true
    }
    return
  }

  const campId = getCampId(db)
  if (!campId) return

  const userDataDir = userDataDirGetter()
  if (!userDataDir) return
  // A write can be the FIRST thing that ever needs a document for this camp —
  // and with the engine defaulting to automerge (Stage 6b), that is now an
  // ordinary production path rather than a test-only one.
  //
  // The seed must NOT be persisted on its own here. `ensureExists` creates a
  // row before its fields arrive (`groups.name` is NOT NULL, so the row exists
  // with ''), so a seed taken mid-write captures placeholder values — and
  // saving that immediately puts a document on disk that is missing the write
  // that caused it. A crash inside the debounce window would leave exactly that
  // partial document, which the next launch would load rather than re-seed, and
  // then replicate its empty values over the correct ones on other devices.
  //
  // So: seed in memory, apply the write, and persist the two together below.
  const seeding = getCurrentDoc(db) === null || getCurrentDoc(db) === undefined
  const doc = getDoc(db, userDataDir, campId, { persistSeed: false })
  const nextDoc = applyWrite(doc, { entity, entity_id, field, value, source, author_user_id })
  docRegistry.set(db, nextDoc)
  if (seeding) {
    // One synchronous save, once per camp per process — the same one-time cost
    // the seed already paid, just moved to after the write instead of before.
    //
    // ON FAILURE, UNDO THE REGISTRY. Without this, `withRetry`'s second attempt
    // finds the doc already cached, takes the `seeding = false` path, skips the
    // save entirely, and returns SUCCESS — reporting a genuinely failed write as
    // "succeeded on attempt 2 after a transient failure". Measured, not
    // theorised: it is what this function did before this line existed.
    // Retrying is only honest if each attempt starts from the same state.
    try {
      saveDoc(userDataDir, campId, nextDoc)
    } catch (err) {
      docRegistry.delete(db)
      throw err
    }
  }
  scheduleSave(db, userDataDir, campId, { local: true, opId: op_id })
}

// Mirror one appendBulkReplaceOp write into the held Automerge doc — the bulk-replace counterpart
// of recordLocalWrite above. Same gating (unmodeled entity / unconfigured / no camp -> inert), same
// getDoc/docRegistry/scheduleSave plumbing, so a bulk-replace and an ordinary field write on the
// same db always build on the SAME in-memory doc, never a stale copy of one or the other.
function applyLocalBulkReplaceNow(db, { entity, scope_id, rows, op_id = null }) {
  if (!BULK_REPLACE_MODELED_ENTITIES.has(entity)) return

  if (!userDataDirGetter) {
    if (!warnedUnconfigured) {
      console.warn(
        'liveDoc: userDataDir not configured — Automerge dual-write is inert until Stage 5e wires it at startup'
      )
      warnedUnconfigured = true
    }
    return
  }

  const campId = getCampId(db)
  if (!campId) return

  const userDataDir = userDataDirGetter()
  if (!userDataDir) return
  const doc = getDoc(db, userDataDir, campId)
  const nextDoc = applyBulkReplace(doc, { entity, scope_id, rows })
  docRegistry.set(db, nextDoc)
  scheduleSave(db, userDataDir, campId, { local: true, opId: op_id })
}

// --- Deferred document writes: the rollback boundary -----------------------
//
// SQLite can roll back. An Automerge document cannot — `applyWrite` returns a
// new document and there is nothing to undo it with. That asymmetry is the
// whole defect this exists to close.
//
// `appendOp` writes SQLite + the op-log inside a transaction, then writes the
// document once that transaction returns, believing it committed
// (operations.js). Nested inside another transaction that belief is false:
// better-sqlite3 nests as SAVEPOINTs, so the savepoint releases while the outer
// transaction is still open. If the outer one then rolls back, SQLite and the
// op-log are undone and the document keeps every write — and the next
// projectAll writes them straight back into SQLite. A failed import returns.
//
// Since the document cannot be rolled back, it is not written at all until the
// outermost transaction has actually committed. During one, writes queue here
// in order; on commit they are applied in that order; on rollback they are
// dropped. Ordering is preserved because a later write to the same field must
// still win, exactly as it would have unbuffered.
//
// Depth-counted, because these transactions nest (deleteRecord's cascade calls
// deleteWeek's, and so on). Only the OUTERMOST boundary flushes — an inner one
// releasing early would reintroduce the bug one level down.
//
// The gating each apply does (unmodeled entity, unconfigured userDataDir, no
// camp row) deliberately runs at APPLY time, not queue time, so a buffered
// write behaves identically to an unbuffered one.
export function beginDeferredDocWrites(db) {
  deferStateFor(db).depth += 1
}

export function commitDeferredDocWrites(db) {
  const state = deferStateFor(db)
  if (state.depth === 0) return
  state.depth -= 1
  if (state.depth > 0) return
  const queued = state.queue
  state.queue = []
  for (const item of queued) {
    // EACH item independently, and a failure never escapes.
    //
    // By the time this runs, SQLite and the op-log have COMMITTED — that is the
    // whole point of flushing after the transaction. So a throw here must not
    // propagate: it would reach commitPlan's catch, which re-throws anything
    // that is not its HELD/DRY_RUN sentinel, and the director would be told the
    // import failed while SQLite says it succeeded. That is the mirror of the
    // bug this deferral exists to fix.
    //
    // Nor may one failure truncate the rest: the remaining writes are unrelated
    // and each is independently applicable, exactly as they were before
    // deferral, when appendOp wrapped every single recordLocalWrite in its own
    // try/catch. Deferral changes WHEN a write applies, never whether its
    // failure is contained.
    //
    // A failure still leaves the document behind SQLite for that field — the
    // second, separate hole (a document write failing on its own), which this
    // change does not claim to close.
    const flushed = withRetry(() => {
      if (item.kind === 'bulk') applyLocalBulkReplaceNow(item.db, item.args)
      else applyLocalWriteNow(item.db, item.args)
    })
    // Replace 'deferred' with what actually happened. See recordLocalWrite.
    if (item.op) item.op[DOCUMENT_OUTCOME] = flushed.ok ? 'applied' : 'failed'
    if (!flushed.ok) {
      const err = flushed.error
      console.error(`deferred document write failed after ${flushed.attempts} attempts (SQLite already committed, unaffected):`, err)
      recordDocumentWriteFailure(item.db, {
        op_id: item.args?.op_id,
        entity: item.args?.entity,
        entity_id: item.args?.entity_id ?? item.args?.scope_id,
        field: item.args?.field,
        error: err,
      })
    }
  }
}

export function discardDeferredDocWrites(db) {
  const state = deferStateFor(db)
  if (state.depth === 0) return
  state.depth -= 1
  if (state.depth > 0) return
  state.queue = []
}

// Retry a document write before giving up on it.
//
// The value is still in hand at this instant — that is the whole reason to try
// here rather than sweep up later. Once `projectAll` runs, SQLite has been
// corrected to match the document and the good value is no longer sitting in
// the easy place to find it; recovering then means reconstructing from the
// op-log, which is more work and more ways to be wrong.
//
// A transient cause (a busy disk, a momentary lock while the debounced save is
// landing) clears on the next attempt. A deterministic one (a value the
// document model rejects) fails all three, costs microseconds, and falls
// through to being recorded — which is the outcome it would have had anyway.
//
// Deliberately synchronous and small: this sits on the write path, and a write
// the director is waiting on must not block on backoff.
const DOCUMENT_WRITE_ATTEMPTS = 3

function withRetry(apply) {
  let lastErr
  for (let attempt = 1; attempt <= DOCUMENT_WRITE_ATTEMPTS; attempt += 1) {
    try {
      apply()
      if (attempt > 1) {
        console.warn(`document write succeeded on attempt ${attempt} after a transient failure`)
      }
      return { ok: true, attempts: attempt }
    } catch (err) {
      lastErr = err
    }
  }
  return { ok: false, attempts: DOCUMENT_WRITE_ATTEMPTS, error: lastErr }
}

// Returns 'deferred' when the write is buffered inside a transaction boundary
// and 'applied' when it reached the in-memory document. The caller (appendOp)
// reports that outward: "buffered" and "done" are different answers to "does the
// authoritative copy have this", and collapsing them is the lie T153 removes.
export function recordLocalWrite(db, args, op = null) {
  const state = deferStates.get(db)
  if (state && state.depth > 0) {
    // The op travels with the queued write so the flush can stamp the REAL
    // outcome on it. Without that, an op appended inside runAtomic keeps saying
    // 'deferred' forever — and because runAtomic flushes before it returns, the
    // caller would be holding a settled write that still reads as unknown. A
    // value that looks like an answer is worse than no value.
    state.queue.push({ kind: 'write', db, args, op })
    return 'deferred'
  }
  const result = withRetry(() => applyLocalWriteNow(db, args))
  if (!result.ok) throw result.error
  return 'applied'
}

export function recordLocalBulkReplace(db, args, op = null) {
  const state = deferStates.get(db)
  if (state && state.depth > 0) {
    state.queue.push({ kind: 'bulk', db, args, op })
    return 'deferred'
  }
  const result = withRetry(() => applyLocalBulkReplaceNow(db, args))
  if (!result.ok) throw result.error
  return 'applied'
}

export function docPathForTests(userDataDir, campId) {
  return docPath(userDataDir, campId)
}
