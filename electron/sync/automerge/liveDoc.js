// Stage 5b/5e live wiring (docs/work/plans/2026-09-06-stage5-live-wiring-design.md §§ 2, 5): the
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
// Stage 5e adds two things on top of 5b's mechanism:
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

// campId -> loaded/created Automerge doc. Keyed by campId (not a single slot) so tests that swap
// camps between cases can't see a stale doc; in production there is exactly one camp per device db
// so this is effectively a single entry.
let docsByCamp = new Map()

// Debounce state for saveDoc (Stage 5e item 3 — see scheduleSave/flushPendingWrites). A per-process
// timer plus the set of campIds with an unsaved in-memory doc: at most one pending timer at a time,
// covering however many camps have pending writes (in production there is exactly one camp per
// device db, so this is never more than one entry in practice, but the structure doesn't assume it).
const SAVE_DEBOUNCE_MS = 250
let pendingTimer = null
let pendingCampIds = new Set()

export function setUserDataDirGetter(getter) {
  userDataDirGetter = getter
}

export function resetForTests() {
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = null
  pendingCampIds = new Set()
  docsByCamp = new Map()
  userDataDirGetter = null
  warnedUnconfigured = false
}

function getCampId(db) {
  return db.prepare('SELECT id FROM camps LIMIT 1').get()?.id ?? null
}

// Stage 5c (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 5): read-only lookup for
// main.js's sync-node startup — "use the doc liveDoc already holds for this camp, if any, rather
// than loading a second independent copy from disk". Returns null (never creates or loads) when
// this module hasn't seen or seeded a doc for the camp yet.
export function getDocIfLoaded(db) {
  const campId = getCampId(db)
  if (campId === null) return null
  return docsByCamp.get(campId) ?? null
}

// Cache-miss path: load the persisted doc, or — if this camp has never been persisted before —
// seed one from the camp's current SQLite rows (never a bare createEmptyDoc(); see the module
// comment and projector.js's assertDocIsSupersetOrEmpty). A freshly seeded doc is saved
// immediately, synchronously, not debounced: this is a one-time event per camp per process, not a
// per-field-op hot path, and it must land on disk before any projectAll can run against it.
function getDoc(db, userDataDir, campId) {
  if (docsByCamp.has(campId)) return docsByCamp.get(campId)
  let doc = loadDoc(userDataDir, campId)
  if (!doc) {
    doc = seedAllFromSqlite(db)
    saveDoc(userDataDir, campId, doc)
  }
  docsByCamp.set(campId, doc)
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

// Stage 5e item 3: coalesce saves. `recordLocalWrite` is called once per field-op — a bulk import
// can call it thousands of times in a tight loop, and a full `A.save` + fsync per call would stall
// the main process. Instead, mark the camp dirty and (if nothing is already scheduled) start one
// timer; when it fires, every dirty camp's CURRENT in-memory doc is written once, however many
// writes accumulated in the window.
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
function scheduleSave(userDataDir, campId) {
  pendingCampIds.add(campId)
  if (pendingTimer) return
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    flushPendingWrites()
  }, SAVE_DEBOUNCE_MS)
  // Never hold the process open just for this timer (matters for app quit / test teardown).
  pendingTimer.unref?.()
}

// Flush every camp with an unsaved in-memory doc to disk immediately, synchronously. Called by
// main.js on app quit (so the debounce window never loses a write the user thinks was saved when
// they quit deliberately) and available to tests that need to observe a debounced save without
// waiting out the timer.
export function flushPendingWrites() {
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  if (pendingCampIds.size === 0) return
  const userDataDir = userDataDirGetter?.()
  const campIds = pendingCampIds
  pendingCampIds = new Set()
  if (!userDataDir) return
  for (const campId of campIds) {
    const doc = docsByCamp.get(campId)
    if (doc) saveDoc(userDataDir, campId, doc)
  }
}

// Mirror one op-log write into the held Automerge doc, if `entity` is modeled. Unmodeled entities
// (day_overrides, parent-scoped entities, template_slots, host-only tables) are a deliberate scope
// fence (see campDocument.js's MODELED_ENTITIES) — they stay op-log-only, silently, not an error.
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
  docsByCamp.set(campId, nextDoc)
  scheduleSave(userDataDir, campId)
}

export function docPathForTests(userDataDir, campId) {
  return docPath(userDataDir, campId)
}
