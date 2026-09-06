// Stage 1 projector: materialize an Automerge document's slice into SQLite
// (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md).
//
// SQLite is DERIVED, not authoritative: this projector rebuilds it from the
// document. The per-row write shape (INSERT OR IGNORE a placeholder, then
// UPDATE each field) deliberately mirrors applyProjection's ensureExists +
// per-field UPDATE (electron/ops/projections.js) so a row projected from the
// document is byte-identical to one projected op-by-op from the op-log —
// proven in projector.test.js.
//
// Scoped to the one Stage 1 entity, `days_of_operation`. Widening to more
// entities (and generalizing the column list from PROJECTIONS) is a later
// stage; this module refuses any other entity loudly rather than guessing.
import { STAGE1_ENTITY, STAGE1_FIELDS } from './campDocument.js'

function assertStage1(entity) {
  if (entity !== STAGE1_ENTITY) {
    throw new Error(`projector (Stage 1): only '${STAGE1_ENTITY}' is projected in this slice, got '${entity}'`)
  }
}

// Project the entity's slice of `doc` into SQLite: upsert every row present in
// the document and DELETE any SQLite row for this entity that the document no
// longer contains. Idempotent — running it twice is a no-op.
export function projectEntity(db, doc, entity = STAGE1_ENTITY) {
  assertStage1(entity)
  const coll = doc[entity] ?? {}
  const ids = Object.keys(coll)

  // Mirror applyProjection.ensureExists for days_of_operation: a placeholder
  // row carrying the device's own camp_id and an empty label, so a row exists
  // before the per-field UPDATEs run (and so camp_id defaults identically to
  // the op-log path when the document carries no explicit camp_id write).
  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  const ensure = db.prepare(`INSERT OR IGNORE INTO ${entity} (id, camp_id, label) VALUES (?, ?, '')`)

  for (const id of ids) {
    const row = coll[id]
    ensure.run(id, camp?.id ?? null)
    for (const field of STAGE1_FIELDS) {
      if (!(field in row)) continue
      db.prepare(`UPDATE ${entity} SET ${field} = ? WHERE id = ?`).run(row[field], id)
    }
  }

  // Reconcile deletes: any SQLite row not present in the document is dropped,
  // so SQLite converges to exactly the document's contents.
  const inDoc = new Set(ids)
  const del = db.prepare(`DELETE FROM ${entity} WHERE id = ?`)
  for (const { id } of db.prepare(`SELECT id FROM ${entity}`).all()) {
    if (!inDoc.has(id)) del.run(id)
  }
}

// Prove SQLite is disposable: wipe the entity's table and re-derive it from the
// document alone. This is the operation that makes "SQLite is a rebuildable
// projection" a fact rather than a claim.
export function rebuildFromDoc(db, doc, entity = STAGE1_ENTITY) {
  assertStage1(entity)
  db.prepare(`DELETE FROM ${entity}`).run()
  projectEntity(db, doc, entity)
}
