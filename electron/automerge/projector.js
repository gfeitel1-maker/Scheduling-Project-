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
import { assertNoUnrecordedConflicts } from './reconcile.js'
import { listRecordIds, readRecord, hasAnyRecord } from './campDocument.js'
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

// `camps` and `users` (Stage 6 prep): same reasoning as campDocument.js's EXTRA_MODELED_ENTITIES —
// neither is in DOMAIN_SNAPSHOT_ORDER (that array is shared with the WS full_sync payload, which
// already has its own bespoke camps/users handling — see campDocument.js's comment), so this
// projector needs its own position for them, not a change to the shared registry. `camps` first:
// `users.camp_id` is a (nullable) FK to `camps.id`, so camps must exist first for any FK-checked
// insert to succeed — though in practice `camps` never inserts a new row via this path at all (see
// PROJECTIONS.camps.ensureExists: it only ever matches or refuses, never creates — the singleton
// camps row is created exclusively by bootstrapCamp/the pairing flow, never by doc replay).
const DOMAIN_ORDER_WITH_CAMPS_AND_USERS = ['camps', 'users', ...DOMAIN_ORDER_WITH_SNAPSHOTS]

// FK-safe apply order, filtered to just the entities this document layer models (DOMAIN_SNAPSHOT_
// ORDER, extended above, also lists deferred entities, which are out of scope here).
// `foreign_keys = ON` (openLocalDb) makes this order load-bearing — a table must project after
// every other table whose id it references. template_slots appears once here (its DOMAIN_SNAPSHOT_
// ORDER position, after schedule_templates) and is projected via BOTH upsertEntity's flat pass
// (individual cell edits) AND upsertBulkReplaceEntity's scope pass (whole-schedule regenerate) — see
// upsertEntity/deleteReconcileEntity below.
export const MODELED_ORDER = DOMAIN_ORDER_WITH_CAMPS_AND_USERS.filter(
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
// `camps` convergence (Stage 6 prep — see docs/work/plans/2026-09-07-stage6-cutover-plan.md's
// task brief, "the camps singleton problem"): every device already has its OWN local `camps` row
// before this document layer's `camps` entity is ever projected — liveDoc.js's getCampId(db) is a
// hard gate ahead of every doc read/write (recordLocalWrite, recordLocalBulkReplace, the sync-node
// startup path all `return` immediately when `SELECT id FROM camps LIMIT 1` is empty), so this
// projection path structurally can never be how a device gets its FIRST camps row. That row comes
// from bootstrapCamp (the Host) or the pairing/join flow (a Client receiving the Host's camp
// identity by a mechanism outside this document — today the legacy WS full_sync's
// `INSERT OR REPLACE INTO camps` in syncClient.js; a libp2p-native equivalent is Stage 6's problem,
// not this slice's).
//
// So by the time doc-projection runs, `db`'s camps row already exists and its `id` already matches
// what the rest of the camp's devices agree on — modeling `camps.name` here is about *subsequent*
// field changes (e.g. a future camp-rename feature) converging across devices that already share an
// id, not about creating that shared identity.
//
// The failure mode this guards against is a device somehow ending up with a document containing a
// DIFFERENT camp's row (id mismatch) — never expected in the supported pairing flow, but not
// impossible (a restored backup from the wrong camp, a bug, a merged `.automerge` file that
// shouldn't have been). PROJECTIONS.camps.ensureExists already refuses that case by throwing
// (camps is a true singleton — see its own comment in projections.js). Left uncaught, that throw
// would propagate out of applyProjection and abort projectAll's ONE shared transaction, rolling
// back every OTHER entity's legitimate projection along with it — a single stray foreign camps row
// in the document would then block ALL sync, camp-wide. The deterministic, testable rule
// implemented here: THIS device's own existing camp id always wins; any other id present in the
// document's `camps` collection is permanently ignored (skipped, logged, never inserted, never
// allowed to overwrite the local identity row) rather than crashing the batch.
function upsertCampsEntity(db, doc) {
  const fields = PROJECTIONS.camps.fields
  for (const id of listRecordIds(doc, 'camps')) {
    const row = readRecord(doc, 'camps', id)
    if (!row) continue
    for (const field of fields) {
      if (!(field in row)) continue
      try {
        applyProjection(db, { entity: 'camps', entity_id: id, field, value: row[field], knownRow: row })
      } catch (err) {
        // Expected refusal from PROJECTIONS.camps.ensureExists when `id` doesn't match this
        // device's own camp row (see comment above) — skip just this row, not the whole batch.
        console.error(
          `projector: skipping doc 'camps' row '${id}' — does not match this device's own camp (${err.message})`
        )
      }
    }
  }
}

function upsertEntity(db, doc, entity) {
  if (BULK_REPLACE_MODELED_ENTITIES.has(entity)) upsertBulkReplaceEntity(db, doc, entity)
  if (!MODELED_ENTITIES.has(entity)) return
  if (entity === 'camps') {
    upsertCampsEntity(db, doc)
    return
  }
  const fields = PROJECTIONS[entity].fields
  for (const id of listRecordIds(doc, entity)) {
    const row = readRecord(doc, entity, id)
    if (!row) continue
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
  // `camps` is never delete-reconciled: it is a singleton identity row, not a collection of
  // records the document could legitimately go to zero-of. If this device's own camp id isn't a
  // key in doc.camps (e.g. the document only ever saw a different camp's row — the exact
  // divergence upsertCampsEntity above guards against, or simply a doc that predates this slice
  // and has never had a camps write land in it yet), the generic rule below would delete this
  // device's OWN camps row out from under every `SELECT ... FROM camps LIMIT 1` lookup in the
  // app — instantly breaking the entire device, not a graceful degradation. There is no product
  // flow that deletes a camp; skip entirely.
  if (entity === 'camps') return
  const inDoc = new Set(listRecordIds(doc, entity))
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

// The projection boundary is where an unhandled conflict becomes invisible
// (docs/adr/2026-09-08-crdt-conflict-reconciliation.md). Two people editing the
// same slot produce a document where one of their decisions has already been
// discarded by Automerge into `getConflicts`; if that document projects into
// SQLite without anyone recording the disagreement, both screens show the same
// wrong answer and nobody is told. Under the op-log this wrote a `conflicts`
// row and required an explicit resolution, so leaving it silent is a
// regression, not a CRDT tradeoff.
//
// The requirement is NOT "callers remember to reconcile". It is that the system
// cannot be in a state where a conflict went unhandled — so the check lives
// HERE, at the one place a merged document becomes SQLite, and every export
// below that writes from a document runs it. A future path that merges without
// reconciling fails loudly at a projection it has to perform anyway. Same shape
// as campDocument.js's module-load subset guard: the strength is that there is
// no path around it, not the logic itself.
//
// "Recorded" is read from the `conflicts` table rather than passed in, so no
// caller can satisfy the guard by asserting it complied.
function assertConflictsRecorded(db, doc) {
  const recorded = db
    .prepare("SELECT entity, entity_id, field FROM conflicts WHERE resolved_at IS NULL AND id LIKE 'crdt:%'")
    .all()
    .map((r) => ({ entity: r.entity, entityId: r.entity_id, field: r.field }))
  assertNoUnrecordedConflicts(doc, recorded)
}

export function projectEntity(db, doc, entity = STAGE1_ENTITY) {
  assertModeled(entity)
  assertConflictsRecorded(db, doc)
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
  return hasAnyRecord(doc, entity)
}

// `camps` is excluded from this guard's "does SQLite/the doc have any real data" signal (see
// RECONCILABLE_ORDER below). Every device's SQLite ALWAYS has exactly one camps row — it is a
// structural invariant of this app, not evidence of a seeded/live camp — so including it here would
// make sqliteHasAnyRow trivially and near-universally true regardless of whether any actual domain
// data exists, defeating the guard's whole purpose. camps also has its own bespoke never-delete
// handling (deleteReconcileEntity's early return) and convergence handling (upsertCampsEntity) — see
// those comments; it doesn't participate in the empty-doc-vs-live-data question this guard asks.
const RECONCILABLE_ORDER = MODELED_ORDER.filter((entity) => entity !== 'camps')

function assertDocIsSupersetOrEmpty(db, doc) {
  const docHasAnyRow = RECONCILABLE_ORDER.some((entity) => entityHasAnyDocRow(doc, entity))
  if (docHasAnyRow) return
  const sqliteHasAnyRow = RECONCILABLE_ORDER.some(
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
  assertConflictsRecorded(db, doc)
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
  assertConflictsRecorded(db, doc)
  if (entity !== undefined) {
    assertModeled(entity)
    const run = db.transaction(() => {
      // `camps` is never wiped — see RECONCILABLE_ORDER's comment above. A raw DELETE here would
      // remove the device's own singleton identity row, and PROJECTIONS.camps.ensureExists
      // refuses to ever re-create it (by design — see projections.js), permanently breaking every
      // `SELECT ... FROM camps LIMIT 1` lookup in the app.
      if (entity !== 'camps') db.prepare(`DELETE FROM ${entity}`).run()
      projectEntity(db, doc, entity)
    })
    run()
    return
  }
  const reverseOrder = [...RECONCILABLE_ORDER].reverse()
  const run = db.transaction(() => {
    for (const e of reverseOrder) db.prepare(`DELETE FROM ${e}`).run()
    projectAll(db, doc)
  })
  run()
}
