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
import { BULK_REPLACE_ENTITIES } from '../ops/campScopedEntities.js'
import {
  STAGE1_ENTITY,
  MODELED_ENTITIES,
  BULK_REPLACE_MODELED_ENTITIES,
  DEFERRED_ENTITIES,
  createEmptyDoc,
  applyWrite,
  applyBulkReplace,
} from './campDocument.js'

function assertModeled(entity) {
  if (DEFERRED_ENTITIES.has(entity)) {
    throw new Error(
      `seedDocFromSqlite: '${entity}' is deferred (see DEFERRED_ENTITIES) — its ensureExists reads the ` +
        `op-log, which the doc-replay path never writes; needs its own doc-native row-construction slice`
    )
  }
  if (!MODELED_ENTITIES.has(entity) && !BULK_REPLACE_MODELED_ENTITIES.has(entity)) {
    throw new Error(
      `seedDocFromSqlite: '${entity}' is not a modeled camp-scoped entity (see MODELED_ENTITIES)`
    )
  }
}

// Seed a bulk-replace entity's SCOPE collection (doc[`${entity}_scopes`]) from SQLite's current
// rows, one scope (e.g. one template_id) at a time — the counterpart of seedDocFromSqlite's flat
// per-row/per-field loop below, needed so projectAll's scope-level delete-reconcile
// (projector.js's deleteReconcileBulkReplaceEntity) treats the doc as an authoritative superset
// immediately after seeding, not as "every scope was deleted." Column values are coerced to
// string-or-null with String() — validateBulkReplaceRows (reused by applyBulkReplace) requires
// exactly that shape, matching the wire contract every real bulk_replace write already produces
// (operations.js's coerceOpValue/ScheduleScreen's writeFields), but a raw better-sqlite3 row read
// back from an INTEGER-affinity column (is_anchor/is_span_head) comes back as a JS number, not the
// '1'/'0' string a real write would have sent — String() closes that gap.
function seedBulkReplaceEntityFromSqlite(db, doc, entity) {
  const config = BULK_REPLACE_ENTITIES[entity]
  const scopeIds = db.prepare(`SELECT DISTINCT ${config.scopeColumn} AS scope_id FROM ${config.table}`).all()
  let d = doc
  for (const { scope_id } of scopeIds) {
    const rawRows = db
      .prepare(`SELECT ${config.columns.join(', ')} FROM ${config.table} WHERE ${config.scopeColumn} = ?`)
      .all(scope_id)
    const rows = rawRows.map((raw) => {
      const row = {}
      for (const col of config.columns) {
        const value = raw[col]
        row[col] = value === null || value === undefined ? null : String(value)
      }
      return row
    })
    d = applyBulkReplace(d, { entity, scope_id, rows })
  }
  return d
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
//
// Also seeds every BULK_REPLACE_MODELED_ENTITIES entity's SCOPE collection (template_slots_scopes),
// not just its flat collection above — both must be seeded, or projectAll's scope-level
// delete-reconcile (deleteReconcileBulkReplaceEntity) would treat a freshly-seeded doc as having
// deleted every existing schedule (see that function's "doc is authoritative superset" requirement).
export function seedAllFromSqlite(db, doc = createEmptyDoc()) {
  let d = doc
  for (const entity of MODELED_ENTITIES) {
    d = seedDocFromSqlite(db, d, entity)
  }
  for (const entity of BULK_REPLACE_MODELED_ENTITIES) {
    d = seedBulkReplaceEntityFromSqlite(db, d, entity)
  }
  return d
}
