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

// A fresh, empty camp document with every modeled entity's collection present.
export function createEmptyDoc() {
  const shape = {}
  for (const entity of MODELED_ENTITIES) shape[entity] = {}
  return A.from(shape)
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
