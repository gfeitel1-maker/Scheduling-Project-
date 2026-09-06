// Stage 3 projector: materialize an Automerge document into SQLite, for
// every entity in DIRECT_CAMP_ENTITIES (docs/adr/2026-09-06-productionize-
// automerge-libp2p-sync.md).
//
// SQLite is DERIVED, not authoritative: this projector rebuilds it from the
// document. It does NOT re-implement the op-log's projection logic — it
// REUSES it. Each field present in the document is replayed through the
// existing `applyProjection` (electron/ops/projections.js) as a synthetic
// op, so a row projected from the document travels the exact same code path
// as a row projected op-by-op from the op-log. Parity is therefore
// structural, not a property that has to be re-proven for every input:
//   - ensureExists placeholder + per-field UPDATE: inherited, cannot drift.
//   - the camp_id tenant guard (applyProjection rejects a camp_id write whose
//     value isn't this device's camp): inherited.
//   - DELETE_FIELD row-delete semantics: inherited.
// Each entity's pass runs in its own transaction (better-sqlite3 nests these
// as savepoints when called from within an outer transaction — see
// projectAll/rebuildFromDoc below), so a throw mid-projection rolls that
// entity's pass back rather than leaving SQLite half-materialized.
//
// Scoped to DIRECT_CAMP_ENTITIES only — refuses any other entity loudly
// rather than guessing (host-only tables, parent-scoped tables, and the one
// bulk-replace entity, template_slots, are out of scope for this document
// layer; see campDocument.js).
import { applyProjection } from '../ops/projections.js'
import { DELETE_FIELD } from '../ops/operations.js'
import { DIRECT_CAMP_ENTITIES, DOMAIN_SNAPSHOT_ORDER } from '../ops/campScopedEntities.js'
import { PROJECTIONS } from '../ops/projections.js'
import { STAGE1_ENTITY } from './campDocument.js'

function assertModeled(entity) {
  if (!DIRECT_CAMP_ENTITIES.has(entity)) {
    throw new Error(
      `projector: '${entity}' is not a modeled camp-scoped entity (see DIRECT_CAMP_ENTITIES)`
    )
  }
}

// FK-safe apply order, filtered to just the entities this document layer
// models (DOMAIN_SNAPSHOT_ORDER also lists parent-scoped tables, which are
// out of scope here). `foreign_keys = ON` (openLocalDb) makes this order
// load-bearing — a table must project after every other table whose id it
// references.
const MODELED_ORDER = DOMAIN_SNAPSHOT_ORDER.filter((entity) => DIRECT_CAMP_ENTITIES.has(entity))

// Project one entity's slice of `doc` into SQLite: replay every field present
// in the document through applyProjection, then DELETE (also via
// applyProjection's DELETE_FIELD path) any SQLite row for this entity the
// document no longer contains. Idempotent, transactional, and — because it
// reuses applyProjection — byte-identical to the op-log projection for the
// same field values.
export function projectEntity(db, doc, entity = STAGE1_ENTITY) {
  assertModeled(entity)
  const fields = PROJECTIONS[entity].fields
  const coll = doc[entity] ?? {}
  const ids = Object.keys(coll)
  const inDoc = new Set(ids)

  const run = db.transaction(() => {
    for (const id of ids) {
      const row = coll[id]
      for (const field of fields) {
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

// Project every modeled entity in FK-safe order, all inside one transaction.
export function projectAll(db, doc) {
  const run = db.transaction(() => {
    for (const entity of MODELED_ORDER) projectEntity(db, doc, entity)
  })
  run()
}

// Prove SQLite is disposable: wipe table(s) and re-derive them from the
// document alone. This is the operation that makes "SQLite is a rebuildable
// projection" a fact rather than a claim.
//
// Two shapes, both preserved:
//   - rebuildFromDoc(db, doc, entity): wipes ONE entity's table, then
//     projectEntity for just that entity (Stage 1's original behavior).
//   - rebuildFromDoc(db, doc): wipes EVERY modeled entity's table in REVERSE
//     FK order, then projectAll (Stage 3's full-camp round-trip).
//
// CAUTION (documented Stage-2 requirement, see the ADR's rules-layer section):
// this deletes every row not in the document. It is safe ONLY when the
// document is the authoritative superset of the modeled entities' rows.
// Before this is ever run against a live camp's existing SQLite data, a
// "seed the document from current SQLite" step must run first (see
// seed.js's seedDocFromSqlite/seedAllFromSqlite) — otherwise an empty/partial
// document would delete real rows and silently orphan convention-only
// referrers (anchor_activities.day_id, day_overrides). Nothing here wires
// this to live data; it runs only against documents built in-process.
export function rebuildFromDoc(db, doc, entity) {
  if (entity !== undefined) {
    assertModeled(entity)
    const run = db.transaction(() => {
      db.prepare(`DELETE FROM ${entity}`).run()
      projectEntity(db, doc, entity)
    })
    run()
    return
  }
  const reverseOrder = [...MODELED_ORDER].reverse()
  const run = db.transaction(() => {
    for (const e of reverseOrder) db.prepare(`DELETE FROM ${e}`).run()
    projectAll(db, doc)
  })
  run()
}
