// Stage 2 slice 1: safe SQLite -> Automerge document seeding
// (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md).
//
// The REQUIRED on-ramp before projectEntity/rebuildFromDoc may run against a
// live camp. Those operations reconcile deletes — any SQLite row not present in
// the document is removed — which is only safe when the document is the
// authoritative superset of the entity's rows. seedDocFromSqlite makes it so:
// it reads the entity's current SQLite rows and writes them into the document
// FIRST, so the very first projection can't delete real data (and can't orphan
// the convention-only referrers `anchor_activities.day_id` / `day_overrides`,
// which have no DB foreign key to catch it — see buildSchedule.js:326-339).
//
// Scoped to the one Stage 1 entity, `days_of_operation`; widening travels with
// the projector's own generalization in a later stage.
import { STAGE1_ENTITY, STAGE1_FIELDS, createEmptyDoc, applyWrite } from './campDocument.js'

// Build (or extend) an Automerge document from the entity's current SQLite rows.
// NULL columns are skipped: an absent field in the document projects back to the
// column's default (NULL for this entity), so the round-trip is faithful without
// storing nulls in the CRDT history.
export function seedDocFromSqlite(db, doc = createEmptyDoc(), entity = STAGE1_ENTITY) {
  if (entity !== STAGE1_ENTITY) {
    throw new Error(`seedDocFromSqlite (Stage 2): only '${STAGE1_ENTITY}' is seedable in this slice, got '${entity}'`)
  }
  const rows = db.prepare(`SELECT id, ${STAGE1_FIELDS.join(', ')} FROM ${entity}`).all()
  let d = doc
  for (const row of rows) {
    for (const field of STAGE1_FIELDS) {
      const value = row[field]
      if (value === null || value === undefined) continue
      d = applyWrite(d, { entity, entity_id: row.id, field, value })
    }
  }
  return d
}
