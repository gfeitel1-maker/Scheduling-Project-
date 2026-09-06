// Stage 1 of the Automerge+libp2p productionization
// (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md).
//
// The Automerge document layer for ONE entity — `days_of_operation` — as the
// first vertical slice. The document shape deliberately MIRRORS the op-log's
// (entity, entity_id, field, value) semantics so that the projector (projector.js)
// can replay each field through the EXISTING applyProjection. SQLite projected
// from this document is therefore byte-identical to SQLite projected op-by-op
// today — structurally, because the projector reuses applyProjection rather
// than re-implementing it; regression-proven in projector.test.js's parity test.
//
// This module is PURE: no SQLite, no IPC, no Electron. It does not touch the
// live app in any way — nothing imports it outside these Stage 1 files yet.
import * as A from '@automerge/automerge'
import { coerceOpValue, DELETE_FIELD } from '../ops/operations.js'

// The single entity modeled in this slice. Widening to more entities is a
// later stage; until then applyWrite refuses anything else, loudly, so the
// scope boundary can't be crossed by accident.
export const STAGE1_ENTITY = 'days_of_operation'

// The projected field set — the SAME list, in the SAME order, as
// PROJECTIONS.days_of_operation.fields (electron/ops/projections.js). Held as
// a local copy on purpose: importing PROJECTIONS would drag the SQLite-coupled
// projection module into this pure layer. campDocument.test.js asserts the two
// stay identical, so they cannot silently drift.
export const STAGE1_FIELDS = ['camp_id', 'label', 'day_of_week', 'sort_order']

// A fresh, empty camp document with the entity collection present.
export function createEmptyDoc() {
  return A.from({ [STAGE1_ENTITY]: {} })
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
//   - field === DELETE_FIELD -> remove the whole entity row
//   - a field not in STAGE1_FIELDS -> silent no-op
//   - value is coerced with the op-log's coerceOpValue, so booleans/objects
//     land in the document exactly as they land in the operations table.
export function applyWrite(doc, { entity, entity_id, field, value }) {
  if (entity !== STAGE1_ENTITY) {
    throw new Error(
      `campDocument (Stage 1): only '${STAGE1_ENTITY}' is modeled in this slice, got '${entity}'`
    )
  }
  return A.change(doc, (d) => {
    const coll = d[entity]
    if (field === DELETE_FIELD) {
      delete coll[entity_id]
      return
    }
    if (!STAGE1_FIELDS.includes(field)) return
    if (!coll[entity_id]) coll[entity_id] = {}
    coll[entity_id][field] = coerceOpValue(value)
  })
}
