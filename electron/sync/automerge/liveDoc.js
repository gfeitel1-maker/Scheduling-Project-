// Stage 5b live wiring (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 2): the
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
import { docPath, loadDoc, saveDoc } from './docStore.js'
import { createEmptyDoc, applyWrite, MODELED_ENTITIES } from '../../automerge/campDocument.js'

// null until wired: production startup wiring is Stage 5e (main.js will call
// setUserDataDirGetter with the real userData path); tests call it directly. If
// the flag is turned on BEFORE 5e wires this, recordLocalWrite is gracefully
// inert (one warning, never a per-write throw) rather than throwing on every
// write — see recordLocalWrite. This keeps 5b a pure mechanism slice.
let userDataDirGetter = null
let warnedUnconfigured = false

// campId -> loaded/created Automerge doc. Keyed by campId (not a single slot) so tests that swap
// camps between cases can't see a stale doc; in production there is exactly one camp per device db
// so this is effectively a single entry.
let docsByCamp = new Map()

export function setUserDataDirGetter(getter) {
  userDataDirGetter = getter
}

export function resetForTests() {
  docsByCamp = new Map()
  userDataDirGetter = null
  warnedUnconfigured = false
}

function getCampId(db) {
  return db.prepare('SELECT id FROM camps LIMIT 1').get()?.id ?? null
}

function getDoc(userDataDir, campId) {
  if (docsByCamp.has(campId)) return docsByCamp.get(campId)
  const loaded = loadDoc(userDataDir, campId) ?? createEmptyDoc()
  docsByCamp.set(campId, loaded)
  return loaded
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
  const doc = getDoc(userDataDir, campId)
  const nextDoc = applyWrite(doc, { entity, entity_id, field, value })
  docsByCamp.set(campId, nextDoc)
  saveDoc(userDataDir, campId, nextDoc)
}

export function docPathForTests(userDataDir, campId) {
  return docPath(userDataDir, campId)
}
