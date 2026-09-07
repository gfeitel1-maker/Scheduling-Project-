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
import { applyWrite, MODELED_ENTITIES } from '../../automerge/campDocument.js'
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
let broadcastCallback = null

// Debounce state for saveDoc/broadcast (Stage 5e item 3, extended in 5f to also drive the local-
// write broadcast off the SAME timer — see module comment). Keyed by campId (the persistence unit),
// value is `{ db, local }`: `db` so the flush can look up the current doc in `docRegistry`, `local`
// so the flush knows whether to broadcast (true if ANY write in this window was a local one).
const SAVE_DEBOUNCE_MS = 250
let pendingTimer = null
let pendingSaves = new Map()

export function setUserDataDirGetter(getter) {
  userDataDirGetter = getter
}

export function setLocalWriteBroadcaster(fn) {
  broadcastCallback = fn
}

export function resetForTests() {
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = null
  pendingSaves = new Map()
  docRegistry = new WeakMap()
  userDataDirGetter = null
  warnedUnconfigured = false
  broadcastCallback = null
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
function getDoc(db, userDataDir, campId) {
  const cached = getCurrentDoc(db)
  if (cached) return cached
  let doc = loadDoc(userDataDir, campId)
  if (!doc) {
    doc = seedAllFromSqlite(db)
    saveDoc(userDataDir, campId, doc)
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
// of field-writes exist only in memory, not yet on disk, if the process crashes. This is acceptable
// because the op-log write these mirror has ALREADY committed to SQLite synchronously, inside
// appendOp's own transaction, before recordLocalWrite is ever called (operations.js) — the op-log
// remains the authoritative record regardless of what the Automerge doc file holds. Recovering from
// a crash in this window means the on-disk doc is missing up to a few hundred ms of field-writes
// that SQLite already has; the doc is not corrupted (each save is a complete, valid document), it is
// merely stale by a bounded amount. Because this stage's doc is a test/transition scaffold — not yet
// load-bearing for any real camp — that staleness is closed by re-running seedAllFromSqlite (a
// deliberate operational step), not by an automatic reseed on every restart (which would also
// discard genuine Automerge-only history, e.g. tombstones — see the design doc §5's own reasoning
// against reseeding on every restart).
function scheduleSave(db, userDataDir, campId, { local = false } = {}) {
  const existing = pendingSaves.get(campId)
  pendingSaves.set(campId, { db, local: local || Boolean(existing?.local) })
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
  for (const [campId, { db, local }] of entries) {
    const doc = getCurrentDoc(db)
    if (!doc) continue
    saveDoc(userDataDir, campId, doc)
    if (local && broadcastCallback) broadcastCallback(doc)
  }
}

// Mirror one op-log write into the held Automerge doc, if `entity` is modeled. Unmodeled entities
// (day_overrides, parent-scoped entities, template_slots, host-only tables) are a deliberate scope
// fence (see campDocument.js's MODELED_ENTITIES) — they stay op-log-only, silently, not an error.
//
// This is ALSO the local half of Stage 5f's unification: the doc this reads and writes
// (getDoc/docRegistry) is the exact same one syncNode.js's remote-merge path reads and writes, so a
// local edit always builds on top of whatever the last remote merge left behind, never a stale copy.
export function recordLocalWrite(db, { entity, entity_id, field, value }) {
  if (!MODELED_ENTITIES.has(entity)) return

  // Not wired yet (pre-Stage-5e): stay gracefully inert — warn ONCE, never
  // throw per write. The op-log remains the source of truth regardless.
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
  const nextDoc = applyWrite(doc, { entity, entity_id, field, value })
  docRegistry.set(db, nextDoc)
  scheduleSave(db, userDataDir, campId, { local: true })
}

export function docPathForTests(userDataDir, campId) {
  return docPath(userDataDir, campId)
}
