// Stage 1 projector: materialize an Automerge document's slice into SQLite
// (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md).
//
// SQLite is DERIVED, not authoritative: this projector rebuilds it from the
// document. It does NOT re-implement the op-log's projection logic — it REUSES
// it. Each field present in the document is replayed through the existing
// `applyProjection` (electron/ops/projections.js) as a synthetic op, so a row
// projected from the document travels the exact same code path as a row
// projected op-by-op from the op-log. Parity is therefore structural, not a
// property that has to be re-proven for every input:
//   - ensureExists placeholder + per-field UPDATE: inherited, cannot drift.
//   - the camp_id tenant guard (applyProjection rejects a camp_id write whose
//     value isn't this device's camp): inherited — a foreign/null camp_id is
//     rejected identically instead of crashing on the FK or writing a foreign
//     row. (This is why the projector no longer touches camp_id itself.)
//   - DELETE_FIELD row-delete semantics: inherited.
// The whole pass runs in one transaction, so a throw mid-projection rolls the
// entire pass back rather than leaving SQLite half-materialized (matching the
// all-or-nothing discipline every op-log write path in operations.js uses).
//
// Scoped to the one Stage 1 entity, `days_of_operation`. Widening to more
// entities (driving the field list from PROJECTIONS) is a later stage; this
// module refuses any other entity loudly rather than guessing.
import { applyProjection } from '../ops/projections.js'
import { DELETE_FIELD } from '../ops/operations.js'
import { STAGE1_ENTITY, STAGE1_FIELDS } from './campDocument.js'

function assertStage1(entity) {
  if (entity !== STAGE1_ENTITY) {
    throw new Error(`projector (Stage 1): only '${STAGE1_ENTITY}' is projected in this slice, got '${entity}'`)
  }
}

// Project the entity's slice of `doc` into SQLite: replay every field present in
// the document through applyProjection, then DELETE (also via applyProjection's
// DELETE_FIELD path) any SQLite row for this entity the document no longer
// contains. Idempotent, transactional, and — because it reuses applyProjection
// — byte-identical to the op-log projection for the same field values.
export function projectEntity(db, doc, entity = STAGE1_ENTITY) {
  assertStage1(entity)
  const coll = doc[entity] ?? {}
  const ids = Object.keys(coll)
  const inDoc = new Set(ids)

  const run = db.transaction(() => {
    for (const id of ids) {
      const row = coll[id]
      for (const field of STAGE1_FIELDS) {
        if (!(field in row)) continue
        applyProjection(db, { entity, entity_id: id, field, value: row[field] })
      }
    }
    // Reconcile deletes: any SQLite row not present in the document is removed,
    // so SQLite converges to exactly the document's contents.
    for (const { id } of db.prepare(`SELECT id FROM ${entity}`).all()) {
      if (!inDoc.has(id)) applyProjection(db, { entity, entity_id: id, field: DELETE_FIELD, value: 1 })
    }
  })
  run()
}

// Prove SQLite is disposable: wipe the entity's table and re-derive it from the
// document alone. This is the operation that makes "SQLite is a rebuildable
// projection" a fact rather than a claim.
//
// CAUTION (documented Stage-2 requirement, see the ADR's rules-layer section):
// this deletes every row not in the document. It is safe ONLY when the document
// is the authoritative superset of the entity's rows. Before this is ever run
// against a live camp's existing SQLite data, a "seed the document from current
// SQLite" step must run first — otherwise an empty/partial document would
// delete real rows and silently orphan convention-only referrers
// (anchor_activities.day_id, day_overrides). Nothing in Stage 1 wires this to
// live data; it runs only against documents built in-process.
export function rebuildFromDoc(db, doc, entity = STAGE1_ENTITY) {
  assertStage1(entity)
  db.prepare(`DELETE FROM ${entity}`).run()
  projectEntity(db, doc, entity)
}
