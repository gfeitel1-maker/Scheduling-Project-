// Automerge generalization slice projector: materialize an Automerge document into SQLite, for
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
import { DELETE_FIELD, applyBulkReplaceProjection } from '../ops/operations.js'
import { DOMAIN_SNAPSHOT_ORDER, BULK_REPLACE_ENTITIES } from '../ops/campScopedEntities.js'
import { PROJECTIONS } from '../ops/projections.js'
import { STAGE1_ENTITY, MODELED_ENTITIES, BULK_REPLACE_MODELED_ENTITIES, DEFERRED_ENTITIES } from './campDocument.js'

function assertModeled(entity) {
  if (DEFERRED_ENTITIES.has(entity)) {
    throw new Error(
      `projector: '${entity}' is deferred (see DEFERRED_ENTITIES) — its ensureExists reads the ` +
        `op-log, which the doc-replay path never writes; needs its own doc-native row-construction slice`
    )
  }
  if (!MODELED_ENTITIES.has(entity) && !BULK_REPLACE_MODELED_ENTITIES.has(entity)) {
    throw new Error(
      `projector: '${entity}' is not a modeled camp-scoped entity (see MODELED_ENTITIES)`
    )
  }
}

// Parent-scoped entities slice: DOMAIN_SNAPSHOT_ORDER deliberately EXCLUDES schedule_snapshots
// (campScopedEntities.js's own comment: "unbounded historical growth over a season" — that
// exclusion is about the first-pairing full_sync WS payload, a completely different concern from
// this projector's FK-safe apply order). schedule_snapshots.template_id IS a real NOT NULL FK to
// schedule_templates(id) though, so THIS projector still needs a position for it — immediately
// after schedule_templates, its only FK target. Do not "fix" this by adding schedule_snapshots to
// DOMAIN_SNAPSHOT_ORDER itself — that array is shared with syncServer.js/syncClient.js's full_sync
// payload and changing it would reintroduce the unbounded-growth problem that exclusion exists to
// avoid.
const DOMAIN_ORDER_WITH_SNAPSHOTS = (() => {
  const idx = DOMAIN_SNAPSHOT_ORDER.indexOf('schedule_templates')
  return [
    ...DOMAIN_SNAPSHOT_ORDER.slice(0, idx + 1),
    'schedule_snapshots',
    ...DOMAIN_SNAPSHOT_ORDER.slice(idx + 1),
  ]
})()

// FK-safe apply order, filtered to just the entities this document layer models (DOMAIN_SNAPSHOT_
// ORDER, extended above, also lists deferred entities, which are out of scope here).
// `foreign_keys = ON` (openLocalDb) makes this order load-bearing — a table must project after
// every other table whose id it references. template_slots appears once here (its DOMAIN_SNAPSHOT_
// ORDER position, after schedule_templates) and is projected via BOTH upsertEntity's flat pass
// (individual cell edits) AND upsertBulkReplaceEntity's scope pass (whole-schedule regenerate) — see
// upsertEntity/deleteReconcileEntity below.
export const MODELED_ORDER = DOMAIN_ORDER_WITH_SNAPSHOTS.filter(
  (entity) => MODELED_ENTITIES.has(entity) || BULK_REPLACE_MODELED_ENTITIES.has(entity)
)

// Bulk-replace scope projection: reuses applyBulkReplaceProjection (electron/ops/operations.js)
// UNCHANGED — same reuse-not-reimplement discipline as the flat path above. Each scope's stored
// value (doc[`${entity}_scopes`][scopeId], a JSON string — see campDocument.js's applyBulkReplace)
// is exactly the `op.value` shape applyBulkReplaceProjection already expects, so a synthetic op
// object `{ entity, entity_id: scopeId, value }` replays through the SAME delete-then-insert-all
// transaction a real op-log bulk_replace op does.
function upsertBulkReplaceEntity(db, doc, entity) {
  const collectionName = `${entity}_scopes`
  const scopes = doc[collectionName] ?? {}
  for (const scopeId of Object.keys(scopes)) {
    applyBulkReplaceProjection(db, { entity, entity_id: scopeId, value: scopes[scopeId] })
  }
}

// Delete-reconcile for a bulk-replace entity: any SCOPE (not row) present in SQLite but absent from
// the document's scope collection is cleared entirely — e.g. a template whose schedule_templates row
// (and template_slots_scopes entry) were both removed from the doc together. Reuses
// applyBulkReplaceProjection with an empty row set, rather than a bespoke DELETE, for the same
// atomicity/validation guarantees a real op-log delete-via-empty-bulk-replace would get.
function deleteReconcileBulkReplaceEntity(db, doc, entity) {
  const config = BULK_REPLACE_ENTITIES[entity]
  const collectionName = `${entity}_scopes`
  const inDoc = new Set(Object.keys(doc[collectionName] ?? {}))
  const rows = db.prepare(`SELECT DISTINCT ${config.scopeColumn} AS scope_id FROM ${config.table}`).all()
  for (const { scope_id } of rows) {
    if (!inDoc.has(scope_id)) {
      applyBulkReplaceProjection(db, { entity, entity_id: scope_id, value: '[]' })
    }
  }
}

// Upsert step: replay every field present in the document for this entity
// through applyProjection. Does NOT delete-reconcile — see deleteReconcile
// below for why that has to run as a separate, later pass across ALL
// entities rather than inline here.
//
// template_slots is dual-modeled (see campDocument.js's applyBulkReplace comment): the bulk-replace
// scope pass runs FIRST (it is the authoritative baseline — every row a whole-schedule regenerate
// produced), then the ordinary flat pass runs SECOND as an OVERLAY of individual per-cell edits onto
// rows the scope pass already inserted. Order matters and mirrors real usage: a director generates a
// schedule (bulk-replace), then may tweak individual cells afterward (field-level writes) — never
// the other way around. The flat pass's per-field UPDATE matches zero rows for any id the scope pass
// didn't insert (a harmless no-op — see deleteReconcileEntity's skip below for why those can exist).
function upsertEntity(db, doc, entity) {
  if (BULK_REPLACE_MODELED_ENTITIES.has(entity)) upsertBulkReplaceEntity(db, doc, entity)
  if (!MODELED_ENTITIES.has(entity)) return
  const fields = PROJECTIONS[entity].fields
  const coll = doc[entity] ?? {}
  for (const id of Object.keys(coll)) {
    const row = coll[id]
    // knownRow = row: every field the document currently holds for this id, all at once — unlike
    // op-log replay's true one-field-at-a-time arrival. Some entities' ensureExists (projections.js's
    // ensureWeekJoinRow and its hand-written equivalents for special_day_slots/
    // elective_set_activities/event_slots/day_overrides) reconstruct sibling NOT-NULL FK columns to
    // satisfy a multi-column INSERT; passed the full row, they resolve those siblings directly
    // instead of querying the `operations` table, which the doc-replay path never writes.
    for (const field of fields) {
      if (!(field in row)) continue
      applyProjection(db, { entity, entity_id: id, field, value: row[field], knownRow: row })
    }
  }
}

// Delete-reconcile step: any SQLite row for this entity not present in the
// document is removed, so SQLite converges to exactly the document's
// contents.
//
// template_slots is deliberately EXCLUDED from the flat delete-reconcile below (it only gets the
// scope-level reconcile above). Its flat collection (doc.template_slots) holds individual-cell-edit
// overlays, not row existence — a row's existence is owned entirely by which scope's bulk-replace
// last ran. Running the flat delete-reconcile too would delete every row NOT ALSO present in
// doc.template_slots (nearly all of them — a real schedule's rows are rarely individually edited),
// wiping out the bulk-replace baseline this exact same projectAll pass just inserted above. It would
// also (see the concurrent-regenerate design in campDocument.js) delete the WINNING generation's rows
// whose per-row flat entries came from the LOSING generation's now-orphaned ids, or vice versa — the
// scope-level reconcile alone is the correct, complete ownership boundary for this table's existence.
function deleteReconcileEntity(db, doc, entity) {
  if (BULK_REPLACE_MODELED_ENTITIES.has(entity)) {
    deleteReconcileBulkReplaceEntity(db, doc, entity)
    return
  }
  const coll = doc[entity] ?? {}
  const inDoc = new Set(Object.keys(coll))
  for (const { id } of db.prepare(`SELECT id FROM ${entity}`).all()) {
    if (!inDoc.has(id)) applyProjection(db, { entity, entity_id: id, field: DELETE_FIELD, value: 1 })
  }
}

// Project one entity's slice of `doc` into SQLite: upsert then
// delete-reconcile, both in one transaction. Idempotent, and — because it
// reuses applyProjection — byte-identical to the op-log projection for the
// same field values.
//
// Safe as a single-entity, single-pass operation (unlike projectAll below):
// with only one table in play there is no cross-entity FK ordering for the
// delete-reconcile half to violate.
export function projectEntity(db, doc, entity = STAGE1_ENTITY) {
  assertModeled(entity)
  const run = db.transaction(() => {
    upsertEntity(db, doc, entity)
    deleteReconcileEntity(db, doc, entity)
  })
  run()
}

// Finding 1 defense-in-depth guard (docs/work/plans/2026-09-06-stage5-live-wiring-design.md §5,
// review round on Stage 5c): delete-reconcile treats the document as an authoritative superset of
// SQLite's modeled-entity rows (see rebuildFromDoc's CAUTION comment above). Empirically confirmed:
// calling projectAll with a freshly createEmptyDoc() against a live camp db silently deletes every
// row for every modeled entity — no throw, no signal, because "the doc has nothing for this entity"
// and "the doc legitimately has zero rows for this entity" are indistinguishable to
// deleteReconcileEntity by design. The only call sites that can produce this are things that resolve
// "the current doc" without proving it was ever seeded from SQLite (main.js's startup fallback chain
// before Stage 5e's seeding lands; a from-scratch doc handed to syncNode.handleReceived).
//
// Deliberately narrow rule, not a heuristic: refuse ONLY when the doc holds zero rows across EVERY
// modeled entity while SQLite holds at least one row in some modeled entity's table. This is the one
// case that is unambiguously always wrong — a document that has never been seeded and is not
// currently building a legitimately-empty fresh camp. It is intentionally not a size-ratio or
// per-entity check:
//   - A per-entity check (doc has 0 rows for entity X, SQLite has rows for X) would misfire on a
//     real, legitimate state — an entity a camp genuinely has zero rows for while the doc is
//     otherwise fully seeded and correct.
//   - A "doc smaller than SQLite by some threshold" heuristic would either be too strict (flags
//     ordinary partial edits mid-sync) or too loose (misses a doc seeded for only some entities).
// What this does NOT catch, by design: a PARTIALLY-empty document — seeded for some modeled
// entities but missing others entirely — will pass this guard (it has SOME rows somewhere) and can
// still silently delete-reconcile away the SQLite rows for whichever entities it's missing. Closing
// that gap requires actual seeding-completeness tracking (a real "has this camp's doc ever been
// fully seeded" fact), which is Stage 5e's job, not a guess bolted on here.
// Reads the right collection for the guard above's "does this entity have any rows" check: the
// flat doc[entity] map for an ordinary entity, or the `${entity}_scopes` map for a bulk-replace
// entity (template_slots) — its OWN flat collection only ever holds individual-cell-edit overlays,
// which can legitimately be empty even while a bulk-replace baseline exists (see upsertEntity's
// comment above), so checking doc[entity] alone would misreport a seeded template_slots as unseeded.
function entityHasAnyDocRow(doc, entity) {
  if (BULK_REPLACE_MODELED_ENTITIES.has(entity)) {
    return Object.keys(doc[`${entity}_scopes`] ?? {}).length > 0
  }
  return Object.keys(doc[entity] ?? {}).length > 0
}

function assertDocIsSupersetOrEmpty(db, doc) {
  const docHasAnyRow = MODELED_ORDER.some((entity) => entityHasAnyDocRow(doc, entity))
  if (docHasAnyRow) return
  const sqliteHasAnyRow = MODELED_ORDER.some(
    (entity) => db.prepare(`SELECT 1 FROM ${entity} LIMIT 1`).get() !== undefined
  )
  if (sqliteHasAnyRow) {
    throw new Error(
      'projectAll: refusing to delete-reconcile — the Automerge document is completely empty for ' +
        'every modeled entity while SQLite already holds rows for at least one of them. This document ' +
        'has not been seeded from SQLite (see automerge/seed.js) and is not an authoritative superset; ' +
        'projecting it would delete live camp data. See docs/work/plans/2026-09-06-stage5-live-wiring-design.md §5.'
    )
  }
}

// Project every modeled entity, all inside one transaction.
//
// Upserts run in forward MODELED_ORDER (FK-safe: a row is inserted only
// after every table its FKs point at already has that row) and
// delete-reconciles run afterward in REVERSE MODELED_ORDER (also FK-safe: a
// parent row is deleted only after every child table that could reference it
// has already had its own stale rows removed). Doing both passes as ONE
// upsert-then-delete pair, rather than projectEntity's interleaved
// upsert-then-delete per entity, is what makes a coherent delete of a parent
// and its children (e.g. the document drops a cohort AND its tiers together)
// succeed: entity-by-entity in forward order would try to delete the cohort
// while its tiers still exist and hit foreign_keys=ON.
export function projectAll(db, doc) {
  assertDocIsSupersetOrEmpty(db, doc)
  const run = db.transaction(() => {
    for (const entity of MODELED_ORDER) upsertEntity(db, doc, entity)
    for (const entity of [...MODELED_ORDER].reverse()) deleteReconcileEntity(db, doc, entity)
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
//     FK order, then projectAll (Automerge generalization slice's full-camp round-trip).
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
