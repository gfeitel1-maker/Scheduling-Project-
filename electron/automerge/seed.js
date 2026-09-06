// Automerge generalization slice seeding: safe SQLite -> Automerge document seeding for every
// entity in DIRECT_CAMP_ENTITIES (docs/adr/2026-09-06-productionize-
// automerge-libp2p-sync.md).
//
// The REQUIRED on-ramp before projectEntity/projectAll/rebuildFromDoc may run
// against a live camp. Those operations reconcile deletes — any SQLite row
// not present in the document is removed — which is only safe when the
// document is the authoritative superset of the entity's rows.
// seedDocFromSqlite/seedAllFromSqlite make it so: they read SQLite's current
// rows and write them into the document FIRST, so the very first projection
// can't delete real data (and can't orphan the convention-only referrers
// `anchor_activities.day_id` / `day_overrides`, which have no DB foreign key
// to catch it — see buildSchedule.js:326-339).
//
// Scoped to DIRECT_CAMP_ENTITIES only, same boundary as campDocument.js/
// projector.js.
import { PROJECTIONS } from '../ops/projections.js'
import { STAGE1_ENTITY, MODELED_ENTITIES, DEFERRED_ENTITIES, createEmptyDoc, applyWrite } from './campDocument.js'

function assertModeled(entity) {
  if (DEFERRED_ENTITIES.has(entity)) {
    throw new Error(
      `seedDocFromSqlite: '${entity}' is deferred (see DEFERRED_ENTITIES) — its ensureExists reads the ` +
        `op-log, which the doc-replay path never writes; needs its own doc-native row-construction slice`
    )
  }
  if (!MODELED_ENTITIES.has(entity)) {
    throw new Error(
      `seedDocFromSqlite: '${entity}' is not a modeled camp-scoped entity (see MODELED_ENTITIES)`
    )
  }
}

// Build (or extend) an Automerge document from one entity's current SQLite
// rows. NULL columns are skipped: an absent field in the document projects
// back to the column's default (NULL, for every modeled entity), so the
// round-trip is faithful without storing nulls in the CRDT history.
export function seedDocFromSqlite(db, doc = createEmptyDoc(), entity = STAGE1_ENTITY) {
  assertModeled(entity)
  const fields = PROJECTIONS[entity].fields
  const rows = db.prepare(`SELECT id, ${fields.join(', ')} FROM ${entity}`).all()
  let d = doc
  for (const row of rows) {
    for (const field of fields) {
      const value = row[field]
      if (value === null || value === undefined) continue
      d = applyWrite(d, { entity, entity_id: row.id, field, value })
    }
  }
  return d
}

// Seed every modeled entity from its current SQLite rows into one document.
// Order is irrelevant here (read-only against SQLite, no FK concerns) —
// unlike projectAll, which must respect DOMAIN_SNAPSHOT_ORDER.
export function seedAllFromSqlite(db, doc = createEmptyDoc()) {
  let d = doc
  for (const entity of MODELED_ENTITIES) {
    d = seedDocFromSqlite(db, d, entity)
  }
  return d
}
