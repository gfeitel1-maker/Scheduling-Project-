// Automerge generalization slice (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md):
// generalizes Stage 1/2's single-entity (`days_of_operation`) Automerge
// document layer to every entity in DIRECT_CAMP_ENTITIES — the simple,
// id-keyed, per-field camp-scoped entities (electron/ops/campScopedEntities.js).
// Deliberately excludes host-only tables (e.g. compound_cell_decisions),
// parent-scoped tables (e.g. week_activity_exclusions), and the one
// bulk-replace entity (template_slots) — those are out of scope for this
// slice and applyWrite/etc. throw rather than silently modeling them.
//
// The document shape mirrors the op-log's (entity, entity_id, field, value)
// semantics per entity, exactly as Stage 1 did for one entity, so the
// projector (projector.js) can replay each field through the EXISTING
// applyProjection — SQLite projected from this document is byte-identical to
// SQLite projected op-by-op today, structurally, not by re-proving parity for
// every input (regression-proven in projector.test.js).
//
// This module is PURE: no SQLite, no IPC, no Electron. Nothing imports it
// outside these automerge/* files yet.
import * as A from '@automerge/automerge'
import { coerceOpValue, DELETE_FIELD } from '../ops/operations.js'
import { DIRECT_CAMP_ENTITIES } from '../ops/campScopedEntities.js'
import { PROJECTIONS } from '../ops/projections.js'

// Back-compat: Stage 1 code and tests reference these two names for the
// original single-entity slice. STAGE1_FIELDS is derived from PROJECTIONS so
// it cannot silently drift from the op-log's field list.
export const STAGE1_ENTITY = 'days_of_operation'
export const STAGE1_FIELDS = PROJECTIONS[STAGE1_ENTITY].fields

// day_overrides.ensureExists (electron/ops/projections.js) reconstructs its
// four NOT-NULL FK columns by reading PRIOR field values out of the
// `operations` table (see readField there). The doc-replay path never writes
// `operations` — a doc-native replay of day_overrides would call
// ensureExists with none of that history available, and the row's NOT-NULL
// FKs would never be satisfiable, so its rows would silently never
// materialize. day_overrides is therefore deferred out of this document
// layer's modeled set until a doc-native row-construction (independent of
// the op-log) is designed as its own future slice. It is the ONLY one of the
// 15 DIRECT_CAMP_ENTITIES with this op-log coupling.
export const DEFERRED_ENTITIES = new Set(['day_overrides'])

// The entities this document layer actually models: every DIRECT_CAMP_ENTITY
// except the deferred ones above. Every module in electron/automerge/*
// iterates or is scoped against THIS set, not DIRECT_CAMP_ENTITIES directly.
export const MODELED_ENTITIES = new Set(
  [...DIRECT_CAMP_ENTITIES].filter((entity) => !DEFERRED_ENTITIES.has(entity))
)

function assertModeled(entity) {
  if (DEFERRED_ENTITIES.has(entity)) {
    throw new Error(
      `campDocument: '${entity}' is deferred (see DEFERRED_ENTITIES) — its ensureExists reads the ` +
        `op-log, which the doc-replay path never writes; needs its own doc-native row-construction slice`
    )
  }
  if (!MODELED_ENTITIES.has(entity)) {
    throw new Error(
      `campDocument: '${entity}' is not a modeled camp-scoped entity (see MODELED_ENTITIES) — ` +
        `host-only, parent-scoped, and bulk-replace entities are out of scope for this document layer`
    )
  }
}

// SHARED GENESIS (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md, prior art:
// experiments/future-arch/cr-sqlite-libp2p/cr4-node.mjs). Every device's doc must start from ONE
// identical Automerge root: A.from() runs on each device independently, so two devices calling
// A.from(shape) each mint their OWN root map with its own actor-id-scoped op history — even with
// byte-identical `shape`, A.merge of two such roots keeps only one side's root map and silently
// drops the other's entire entity collection (see this file's header comment / the ADR for the
// confirmed regression). A.clone(A.load(bytes)) of the SAME saved bytes, by contrast, gives every
// device a document descending from the exact same root change, so root-level merges are conflict-
// free by construction.
//
// The bytes must therefore never be regenerated at runtime — GENESIS_B64 below is a FROZEN
// constant, computed once and pinned, the same way campIdHash.test.js pins a wire-compatibility
// vector. Two failure modes this guards against:
//   - Deriving genesis from `A.from(shape)` at every app startup would reintroduce the split this
//     fix exists to close — the SAME reasoning above, just moved from "two devices" to "two
//     versions/builds/machines of the app", which is the actual deployment shape (every install
//     independently boots this code). A build-time-deterministic derivation would still need
//     every future build to reproduce the identical bytes forever, which is a strictly harder
//     promise to keep than "never regenerate; ship the fixed constant" — Automerge's own encoding
//     is not a documented stable-forever function of its input, so nothing guarantees a future
//     Automerge version encodes the same shape to the same bytes. A hardcoded constant sidesteps
//     that entirely: it is what it is, forever, regardless of library internals.
//   - MODELED_ENTITIES can gain entries over time (a new camp-scoped entity is added to
//     campScopedEntities.js and un-deferred here). If genesis were derived FROM the current
//     MODELED_ENTITIES, adding an entity would change the genesis root's content and therefore its
//     hash/heads — every device upgrading to that version would mint a NEW incompatible root
//     relative to any device still on the old version (or any not-yet-upgraded persisted doc file),
//     splitting the mesh exactly like the bug this fix closes, just moved from "day 1" to "next
//     entity we add". GENESIS_B64 is pinned to a fixed, frozen entity list (GENESIS_ENTITIES,
//     immediately below) that is NEVER read from — nothing derives it from MODELED_ENTITIES at
//     runtime. createEmptyDoc() clones this fixed root and then TOPS UP any entity in the CURRENT
//     MODELED_ENTITIES that genesis doesn't already contain (a plain A.change, additive-only, never
//     touching the shared root) — so the root itself never moves, only per-entity collections are
//     added on top of it, and every device converges on the same root regardless of which entities
//     its particular app version knows about. applyWrite (below) also lazily creates a missing
//     collection the same way, so an already-persisted document from BEFORE an entity existed keeps
//     working once that entity is added — the root is not read as an oracle of what exists.
//
// GENESIS_ENTITIES is a frozen snapshot of MODELED_ENTITIES as of this slice, sorted for
// determinism. It exists ONLY as documentation of what GENESIS_B64 encodes — changing it does
// nothing at runtime, since GENESIS_B64 is the actual constant used. Do not "fix" this list to
// match a future MODELED_ENTITIES; that would defeat the entire point above.
const GENESIS_ENTITIES = [
  'activities',
  'anchor_activities',
  'camp_maps',
  'cohorts',
  'days_of_operation',
  'elective_sets',
  'events',
  'groups',
  'locations',
  'schedule_templates',
  'schedule_weeks',
  'special_days',
  'tiers',
  'time_blocks',
]

// Frozen base64 of A.save(A.from(shape)) for GENESIS_ENTITIES above, each mapped to `{}`. See
// campDocument.test.js's genesis-pinning test — if that test's expectation ever needs to change to
// pass, that is a wire/document-compatibility break being HIDDEN, not fixed; see that test's own
// comment.
const GENESIS_B64 =
  'hW9Kg5l+Ra8AlgIBEPkJfDcRJBbQf0Ur+OyD0y0BTMXWRIrfbEALtYmHD0HTyMxzNsDQW9/SR+DYltarT0EGAQIDAhMCIwZAAlYCBxWpASECIwI0AUICVgKAAQJ/AH8Bfw5/wcj71AZ/AH8HcgphY3Rpdml0aWVzEWFuY2hvcl9hY3Rpdml0aWVzCWNhbXBfbWFwcwdjb2hvcnRzEWRheXNfb2Zfb3BlcmF0aW9uDWVsZWN0aXZlX3NldHMGZXZlbnRzBmdyb3Vwcwlsb2NhdGlvbnMSc2NoZWR1bGVfdGVtcGxhdGVzDnNjaGVkdWxlX3dlZWtzDHNwZWNpYWxfZGF5cwV0aWVycwt0aW1lX2Jsb2Nrcw4ADgEODgAOAA4AAA=='

function genesisDoc() {
  return A.clone(A.load(Uint8Array.from(Buffer.from(GENESIS_B64, 'base64'))))
}

// A fresh camp document, cloned from the one shared genesis root (see above) so that every device
// merges without a split root, then topped up with an empty collection for any entity in the
// CURRENT MODELED_ENTITIES that the frozen genesis doesn't already carry (additive-only; never
// touches the genesis root itself).
export function createEmptyDoc() {
  const missing = [...MODELED_ENTITIES].filter((entity) => !GENESIS_ENTITIES.includes(entity))
  const doc = genesisDoc()
  if (missing.length === 0) return doc
  return A.change(doc, (d) => {
    for (const entity of missing) d[entity] = {}
  })
}

// Persist / restore the document (append-only binary — this is the thing that
// is authoritative and, in later stages, synced; SQLite is derived from it).
export function saveDoc(doc) {
  return A.save(doc)
}
export function loadDoc(bytes) {
  return A.load(bytes)
}

// Apply one op-shaped write, returning a NEW document (Automerge is immutable
// at this boundary). Semantics intentionally match applyProjection
// (electron/ops/projections.js):
//   - entity must be in DIRECT_CAMP_ENTITIES -> else throw (explicit scope)
//   - field === DELETE_FIELD -> remove the whole entity row
//   - a field not registered in PROJECTIONS[entity].fields -> silent no-op
//   - value is coerced with the op-log's coerceOpValue, so booleans/objects
//     land in the document exactly as they land in the operations table.
export function applyWrite(doc, { entity, entity_id, field, value }) {
  assertModeled(entity)
  const fields = PROJECTIONS[entity].fields
  return A.change(doc, (d) => {
    // Lazy top-up (see genesis comment above): a document persisted before `entity` existed in
    // MODELED_ENTITIES (or a genesis-cloned doc whose frozen entity list predates it) has no
    // collection for it yet. Create it here rather than assuming createEmptyDoc() already did —
    // that keeps old on-disk docs working the moment an entity is un-deferred, without needing a
    // migration step.
    if (!d[entity]) d[entity] = {}
    const coll = d[entity]
    if (field === DELETE_FIELD) {
      delete coll[entity_id]
      return
    }
    if (!fields.includes(field)) return
    if (!coll[entity_id]) coll[entity_id] = {}
    coll[entity_id][field] = coerceOpValue(value)
  })
}
