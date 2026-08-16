// Commit an approved import proposal, or commit nothing.
//
// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §2, §4.
//
// Two guarantees, both of them the point of this file:
//
//   • **Whitelist.** Only the six setup entities can be created here. The
//     placements are sitting right there in the parsed grid, and "entities
//     only" is a scope decision that will come under pressure; a whitelist is
//     the difference between reopening it deliberately and doing it by
//     accident.
//
//   • **All or nothing.** The whole import runs in one SQLite transaction. A
//     partial ingest that half-populates a camp is worse than one that fails
//     cleanly — T16 — and better-sqlite3's transaction gives that for free
//     provided every write goes through this one function.

import { randomUUID } from 'node:crypto'
import { appendOp, DELETE_FIELD, latestOp } from './operations.js'
import { latestOpForEntity, lastKnownFields, lastKnownFieldSources } from './restore.js'
import { PARENT_SCOPED_ENTITIES } from './campScopedEntities.js'
import { normalizeName, recognitionKey } from '../../src/ingest/preview.js'
import { buildPlan, CLEAR } from '../../src/ingest/buildPlan.js'
import { foldApprovedToRecords, enrichSnapshotRow, resolveFieldWrite, dbFieldFor } from '../../src/ingest/fieldUpdate.js'
import { deriveLocationId } from './locationId.js'

// ADR §2. Kept here rather than imported from the renderer so the guarantee
// lives with the code that writes; ingest.test.js asserts the two agree.
// M4 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D2): 'locations'
// sits immediately after 'time_blocks', before 'activities' — order is
// normative (commitPlan's create loop follows it), not just set membership.
export const INGESTIBLE_ENTITIES = Object.freeze([
  'cohorts', 'tiers', 'groups', 'days_of_operation', 'time_blocks', 'locations', 'activities',
])

// What a Replace clears: everything an import can create except Programs.
// cohorts is never deleted — tiers and time_blocks reference it and Programs
// are not part of a year's schedule.
//
// The order is normative and belongs here rather than in a caller's payload:
// it is a property of the schema, and PRAGMA foreign_keys is ON, so a wrong
// order throws. docs/work/specs/S-replace-ingest-atomic-transaction.md
// §"Deletion order".
const REPLACEABLE_ENTITIES = Object.freeze([
  'activities', 'groups', 'time_blocks', 'days_of_operation', 'tiers',
])

// Dependents, cleared first, each scoped to the camp through its parent by
// PARENT_SCOPED_ENTITIES rather than a join written out a second time here.
const PARENT_SCOPED_DEPENDENTS = Object.freeze([
  'template_slots',
  'template_overlays',
  'week_activity_exclusions',
  'week_group_exclusions',
  'week_location_exclusions',
  'day_override_template_slots',
])

/**
 * Clear the camp's importable setup and everything that points at it.
 *
 * Called ONLY as the first statement inside commitIngest's transaction, so the
 * teardown and the create half share one rollback boundary — that is the whole
 * of T61. Exported for the tests that prove the ordering, not as a second
 * write path.
 *
 * Every removal is an ordinary `__deleted__` op, so each cleared row stays
 * restorable from Trash and replicates to peers. Deliberately NOT a raw SQL
 * DELETE and NOT `ON DELETE CASCADE`: a cascade writes no ops, and the op log
 * is the replication mechanism
 * (docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md).
 *
 * Returns `{ entities: { [entity]: count }, dependents: { [table]: count } }`.
 */
// `source` (S2a) tags the field-value writes this teardown makes as import
// provenance. Only the weather_alternative_id null-out below is a field-value
// write; the `__deleted__` tombstone ops carry no field value and stay NULL
// (ADR §2 census). Passed by commitPlan as 'import'; defaults to null so a
// direct/test caller behaves as before.
export function replaceScope(db, { camp_id, author_user_id = null, device_id, source = null }) {
  const entities = {}
  const dependents = {}

  const remove = (entity, entity_id) => appendOp(db, {
    entity,
    entity_id,
    field: DELETE_FIELD,
    value: 1,
    author_user_id: author_user_id ?? null,
    device_id,
    parent_op_id: null,
    client_write_id: randomUUID(),
  })

  // Steps 1–5. Table and column names come from the frozen registries above
  // and from campScopedEntities.js — never from a caller — so the only
  // caller-supplied value in these statements is the bound camp_id.
  for (const entity of PARENT_SCOPED_DEPENDENTS) {
    const { table, parentTable, parentKey } = PARENT_SCOPED_ENTITIES[entity]
    const rows = db.prepare(
      `SELECT child.id AS id FROM ${table} child
         JOIN ${parentTable} parent ON parent.id = child.${parentKey}
        WHERE parent.camp_id = ?`
    ).all(camp_id)
    for (const row of rows) remove(entity, row.id)
    dependents[entity] = rows.length
  }

  // Step 6 — anchors are camp-scoped directly, and anchor_activities.day_id
  // references days_of_operation, so they must go before step 8.
  const anchors = db.prepare('SELECT id FROM anchor_activities WHERE camp_id = ?').all(camp_id)
  for (const row of anchors) remove('anchor_activities', row.id)
  dependents.anchor_activities = anchors.length

  // Step 7 — unhook the activity self-reference before deleting activities.
  // schema.sql declares weather_alternative_id plain TEXT, but deleteRecord.js
  // treats it as blocking and a db migrated through localDb.js v15 may carry
  // the real FK. Nulling first makes the delete order independent of which
  // schema variant this file is on — and a mutually-referencing pair (A→B,
  // B→A) has no safe order at all otherwise.
  const linked = db.prepare(
    'SELECT id FROM activities WHERE camp_id = ? AND weather_alternative_id IS NOT NULL'
  ).all(camp_id)
  for (const row of linked) {
    appendOp(db, {
      entity: 'activities',
      entity_id: row.id,
      field: 'weather_alternative_id',
      value: null,
      author_user_id: author_user_id ?? null,
      device_id,
      parent_op_id: null,
      client_write_id: randomUUID(),
      source,
    })
  }

  // Step 8.
  for (const entity of REPLACEABLE_ENTITIES) {
    const rows = db.prepare(`SELECT id FROM ${entity} WHERE camp_id = ?`).all(camp_id)
    for (const row of rows) remove(entity, row.id)
    entities[entity] = rows.length
  }

  // A violation here means the clearing above missed a table, and committing
  // would leave a torn camp. It covers REAL foreign keys only — it says
  // nothing about the plain-TEXT soft references (day_override_template_slots
  // .activity_id, template_overlays.unit_id) or the snapshot JSON blobs.
  const violations = db.pragma('foreign_key_check')
  if (violations.length > 0) {
    throw new Error(`ingest: replace left ${violations.length} foreign key violation(s); nothing was imported`)
  }

  return { entities, dependents }
}

// The name column each ingestible entity carries. Only days_of_operation names
// its label something other than `name`.
const NAME_COLUMN = Object.freeze({ days_of_operation: 'label' })
const nameColumnFor = (entity) => NAME_COLUMN[entity] ?? 'name'

// Program-scoped for duplicate-recognition, exactly as ImportScreen treats them.
// Exported: confirmAlias.js (the alias committer) and listAliasMap below both
// need the same cohort-scoping decision, and a second copy could drift.
export const COHORT_SCOPED = Object.freeze(new Set(['tiers', 'time_blocks']))

// S2b: the comparable value columns buildPlan diffs a recognized entity's
// proposed fields against (beyond id + name, and the cohort_id already carried
// for scoped entities). These are exactly the columns commitCreate writes and
// fieldsFor derives, so a re-import can tell a changed field from an unchanged
// one. camp_id is deliberately absent — it never changes and would only add
// noise to the diff.
// S2c §3 widens activities/groups so a recognized entity's rule/unit fields are
// diffable. For the foreign-key fields the snapshot ALSO carries a resolved
// LABEL form (`eligible_group_names`, `unit_name`) so the pure buildPlan can
// compare without a DB — see buildExistingSnapshot. `eligible_group_ids`/
// `tier_id` are selected only to resolve those labels; buildPlan never diffs the
// raw-id columns.
const COMPARABLE_COLUMNS = Object.freeze({
  cohorts: [],
  tiers: ['sort_order'],
  groups: ['availability', 'tier_id'],
  days_of_operation: ['day_of_week', 'sort_order'],
  time_blocks: ['start_time', 'end_time', 'sort_order'],
  // M4 §D4: 'location' -> 'location_id'. The frozen `activities.location`
  // string (D5 of the parent ADR) is never written after v32 and stays out of
  // this diff — comparing against it would only ever be stale.
  activities: ['priority', 'min_per_week', 'max_per_week', 'location_id', 'eligible_group_ids'],
  // No comparable fields — a locations plan item is only ever create/unchanged
  // (§D3: exact-match recognition means it can never surface an update either).
  locations: [],
})

/**
 * The `existing` snapshot buildPlan recognizes against (S1a §1), read from the
 * live DB — the same shape ImportScreen builds for `buildPreview`: rows carry
 * `{ id, name }` (days expose their `label` AS `name` so `normalizeName` sees
 * it), and tiers/time_blocks are filtered to the active Program when one is
 * given, camp-wide otherwise. Entity names come from the frozen whitelist, never
 * a caller, so interpolating them into the query is safe.
 */
// S1b §4. entity_type -> table map, FIXED (never string-built from input) —
// entity_type is attacker-influenced (sourced from the imported file that
// originally produced the alias), so every identifier slot it could reach
// goes through this frozen lookup, never interpolation. Table names happen to
// equal the INGESTIBLE_ENTITIES entity name for all six types today, but the
// map is kept explicit (not derived from INGESTIBLE_ENTITIES) so a future
// entity whose table name diverges from its entity_type doesn't silently
// mis-target this lookup.
const ALIAS_ENTITY_TABLE = Object.freeze({
  cohorts: 'cohorts',
  tiers: 'tiers',
  groups: 'groups',
  days_of_operation: 'days_of_operation',
  time_blocks: 'time_blocks',
  locations: 'locations',
  activities: 'activities',
})

/**
 * S1b §4. Host-local read of confirmed aliases, filtered to LIVE targets only
 * (a Trashed target is dropped — liveness is evaluated at read time, never
 * cached, so a restore makes the alias fire again with no re-confirmation —
 * ADR §5). Returns `{ [entity]: Map(normalizeName(source_label) -> entity_id) }`,
 * scoped by entity_type and, for cohort-scoped types, by cohort_id exactly as
 * buildExistingSnapshot scopes tiers/time_blocks (no filter when cohort_id is
 * falsy, matching that same function).
 *
 * A row whose entity_type is not in ALIAS_ENTITY_TABLE is skipped per-row —
 * it never reaches an identifier slot, and it never aborts the read for the
 * rest of the map (ADR §3).
 */
function listAliasMap(db, camp_id, cohort_id) {
  const map = {}
  for (const entity of INGESTIBLE_ENTITIES) map[entity] = new Map()

  const rows = db
    .prepare(`SELECT entity_type, cohort_id, source_label, entity_id FROM source_aliases WHERE camp_id = ? AND status = 'active'`)
    .all(camp_id)

  for (const row of rows) {
    const table = ALIAS_ENTITY_TABLE[row.entity_type]
    if (!table) continue
    if (COHORT_SCOPED.has(row.entity_type) && cohort_id && row.cohort_id !== cohort_id) continue
    const live = db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND camp_id = ?`).get(row.entity_id, camp_id)
    if (!live) continue
    map[row.entity_type].set(normalizeName(row.source_label), row.entity_id)
  }
  return map
}

// B4 (docs/adr/2026-08-10-ingestion-evidence-persistence.md). entity_type is
// attacker-influenced (sourced from the imported file, same as
// ALIAS_ENTITY_TABLE above), so it is validated against a FIXED set rather
// than trusted — the two entity types inferActivityRules/inferFixedEvents
// produce support for today.
const EVIDENCE_ENTITY_TYPES = new Set(['activities', 'anchor_activities'])
const EVIDENCE_TAGS = new Set(['observed', 'inferred'])
const EVIDENCE_CONFIDENCE = new Set(['high', 'low'])

/**
 * B4: persist one field's inference support, latest-wins per
 * (camp_id, entity_type, entity_id, field). Called ONLY from inside
 * commitPlan's transaction (never appendOp'd — host-local, never synced,
 * same discipline as confirmAlias). Silently refuses anything outside the
 * frozen enums rather than trusting file-derived input into a write.
 */
function writeEvidence(db, { camp_id, entity_type, entity_id, field, tag, confidence, support, import_run_id, committed_at }) {
  if (!EVIDENCE_ENTITY_TYPES.has(entity_type)) return
  if (!EVIDENCE_TAGS.has(tag)) return
  if (!EVIDENCE_CONFIDENCE.has(confidence)) return
  if (!entity_id || !field) return

  db.prepare(
    `INSERT INTO import_evidence (id, camp_id, entity_type, entity_id, field, tag, confidence, support, import_run_id, committed_at)
     VALUES (@id, @camp_id, @entity_type, @entity_id, @field, @tag, @confidence, @support, @import_run_id, @committed_at)
     ON CONFLICT (camp_id, entity_type, entity_id, field) DO UPDATE SET
       tag = excluded.tag,
       confidence = excluded.confidence,
       support = excluded.support,
       import_run_id = excluded.import_run_id,
       committed_at = excluded.committed_at`
  ).run({
    id: randomUUID(),
    camp_id,
    entity_type,
    entity_id,
    field,
    tag,
    confidence,
    support: JSON.stringify(support ?? {}),
    import_run_id,
    committed_at,
  })
}

/**
 * B4: read-only lookup, sibling to listAliasMap. Returns the evidence rows
 * for one entity (or every evidence row for the camp when entity_id/type is
 * omitted), with `support` parsed back to an object. No consumer wired to
 * this yet (Phase C/D's "why?" panel) — read path only.
 *
 * `entity_id` is a polymorphic key (its meaning depends on `entity_type`, per
 * the table's own schema comment) — passing entity_id WITHOUT entity_type is
 * not a supported "look up regardless of type" query, just an unenforced
 * filter that happens to work when ids never collide across the two types.
 */
export function listImportEvidence(db, camp_id, { entity_type, entity_id } = {}) {
  const conditions = ['camp_id = ?']
  const params = [camp_id]
  if (entity_type) { conditions.push('entity_type = ?'); params.push(entity_type) }
  if (entity_id) { conditions.push('entity_id = ?'); params.push(entity_id) }

  const rows = db
    .prepare(`SELECT * FROM import_evidence WHERE ${conditions.join(' AND ')}`)
    .all(...params)

  // Defense-in-depth: a malformed blob (direct-DB tampering, or a future
  // writer bug) degrades to {} on read rather than throwing — writeEvidence
  // is the only writer and always JSON.stringifies a real object, so this
  // path is not expected to fire in practice.
  return rows.map((row) => {
    let support
    try { support = JSON.parse(row.support) } catch { support = {} }
    return { ...row, support }
  })
}

// C2b assembly helper (docs/adr/2026-08-10-ingestion-phaseC-compression-layer.md).
// Finds activities whose CURRENT priority was last written with
// source='import' — the legacy pre-B2 backfill that
// docs/adr/2026-08-10-legacy-import-priority-backfill.md rejected auto-
// clearing for. Reuses lastKnownFieldSources (the S2a primitive) rather than
// a parallel provenance system. A priority whose last op has no recorded
// source (or is 'human') is EXCLUDED — S2a's documented over-protection:
// never surface a value a human definitively authored.
export function listLegacyPriorityActivities(db, camp_id) {
  const candidates = db
    .prepare('SELECT id, name FROM activities WHERE camp_id = ? AND priority IS NOT NULL ORDER BY name, id')
    .all(camp_id)

  const result = []
  for (const { id, name } of candidates) {
    const sources = lastKnownFieldSources(db, 'activities', id)
    if (sources.get('priority') === 'import') result.push({ entity_id: id, name })
  }
  return result
}

// C4 assembly helper (docs/adr/2026-08-10-ingestion-phaseC-compression-layer.md,
// OQ2 resolved EXTRACT): builds the `fieldProvenance` input
// buildReconciliationReport's C4 rule needs. Reuses the SAME isProtected
// primitive decideFieldItem already runs inline per-field at commit time
// (`latest.source !== 'import'` — see decideFieldItem's isProtected gate) —
// not a parallel provenance system. This is read-only, caller-side glue that
// assembles Phase C's input; it does not touch and is never called from the
// live commit-path gate, which is deliberately left untouched (extracting
// the gate itself out of decideFieldItem's closure was judged riskier than
// adding this sibling read for a not-yet-wired consumer).
//
// CONTRACT (Phase-D wiring): any DB-backed caller that invokes
// buildReconciliationReport against a REAL import MUST build fieldProvenance
// via this function and pass it through. Omitting it silently classifies
// every 'human'-owned field as non-human (buildReconciliationReport degrades
// additively to pre-C4 behavior — see that function's own contract comment),
// so a director-confirmed value can be silently overwritten with no CHANGED
// decision ever surfaced. That data-safety obligation belongs to the caller,
// not to this pure function.
//
// The map is keyed by the PLAN item's field name (e.g. 'unit',
// 'eligible_groups') because that's what buildReconciliationReport sees in
// item.fields — but provenance is read against the STORED column via
// dbFieldFor(field), the same mapping decideFieldItem uses (eligible_groups
// -> eligible_group_ids, unit -> tier_id). 'human' = a latest op exists and
// its source isn't 'import'; 'import' otherwise, including when the field
// was never written (absent latest) — matching isProtected's definition.
export function buildFieldProvenanceMap(db, planItems) {
  const map = new Map()
  for (const item of planItems) {
    if (item.op !== 'update' && item.op !== 'clear') continue
    if (item.entity_id == null) continue
    for (const field of Object.keys(item.fields ?? {})) {
      const dbField = dbFieldFor(field)
      const latest = latestOp(db, item.entity, item.entity_id, dbField)
      const provenance = !!latest && latest.source !== 'import' ? 'human' : 'import'
      map.set(`${item.entity}:${item.entity_id}:${field}`, provenance)
    }
  }
  return map
}

// M4 §D2: 'locations' is durable camp infrastructure — it is excluded from
// REPLACEABLE_ENTITIES (below) and, unlike the six schedule-content entities,
// is recognized in EVERY mode, not just 'add'. A blind-create against a
// still-live location in replace mode would land on `deriveLocationId`'s own
// PRIMARY KEY, no-op the INSERT OR IGNORE, and silently let the field UPDATEs
// overwrite the existing row — the exact hazard this carve-out exists to avoid.
const ALWAYS_SCANNED_ENTITIES = Object.freeze(['locations'])

function buildExistingSnapshot(db, camp_id, cohort_id, mode) {
  // S2c §3: live id->name maps so the snapshot can carry FK fields in the LABEL
  // form buildPlan compares against (it holds no DB handle and cannot resolve).
  const groupNameById = new Map()
  for (const r of db.prepare('SELECT id, name FROM groups WHERE camp_id = ?').all(camp_id)) {
    groupNameById.set(r.id, r.name)
  }
  const tierNameById = new Map()
  for (const r of db.prepare('SELECT id, name FROM tiers WHERE camp_id = ?').all(camp_id)) {
    tierNameById.set(r.id, r.name)
  }
  // M4 §D4: locations' own id->name map, so an activity's location_id can be
  // enriched to location_name (mirrors tierNameById/groupNameById exactly).
  const locationNameById = new Map()
  for (const r of db.prepare('SELECT id, name FROM locations WHERE camp_id = ?').all(camp_id)) {
    locationNameById.set(r.id, r.name)
  }

  // M4 §D2: in replace mode, only the always-scanned entities (locations) are
  // read live; the six schedule-content entities scan nothing — their
  // pre-teardown rows are about to be deleted, and recognizing them here would
  // falsely hold every item once teardown removes what the `unchanged` items
  // point at (the ORIGINAL S1a rationale, now scoped instead of blanket-null).
  const entitiesToScan = mode === 'replace' ? ALWAYS_SCANNED_ENTITIES : INGESTIBLE_ENTITIES

  const existing = {}
  for (const entity of entitiesToScan) {
    const scoped = COHORT_SCOPED.has(entity)
    const cols = [
      'id',
      `${nameColumnFor(entity)} AS name`,
      ...(scoped ? ['cohort_id'] : []),
      ...(COMPARABLE_COLUMNS[entity] ?? []),
    ].join(', ')
    const rows = db.prepare(`SELECT ${cols} FROM ${entity} WHERE camp_id = ?`).all(camp_id)
    const scopedRows = scoped && cohort_id ? rows.filter((r) => r.cohort_id === cohort_id) : rows
    // S2c §3: resolve the FK columns to the LABEL forms buildPlan compares
    // against (shared with the mock so the two snapshots cannot diverge).
    for (const row of scopedRows) enrichSnapshotRow(entity, row, groupNameById, tierNameById, locationNameById)
    existing[entity] = scopedRows
  }
  // S1b §4: the confirmed-alias tier reads this out of the snapshot, exactly
  // as buildPlan reads the recognition rows above — buildPlan stays pure (no
  // DB), this host-local read happens once, here, inside the same host-only
  // ingest code path that builds the rest of the snapshot. Replace mode skips
  // it too (mirrors the pre-M4 `mode === 'replace' ? null : ...` behavior for
  // the six schedule-content entities — aliases target those, not locations).
  existing.aliases = mode === 'replace' ? {} : listAliasMap(db, camp_id, cohort_id)
  return existing
}

/**
 * Commit an approved import proposal, or commit nothing.
 *
 * `approved` is `{ [entity]: [name, ...] }` — exactly what the director
 * confirmed in the preview, not the raw proposal. Anything outside
 * INGESTIBLE_ENTITIES is a hard error rather than a silent skip: a caller
 * asking to ingest placements has misunderstood something, and quietly
 * dropping the request would hide that.
 *
 * `fixedEvents` is a dedicated payload of proposed recurring fixed events
 * (docs/adr/2026-08-03-ingesting-recurring-fixed-events.md), NOT a key in
 * `approved`: the generic whitelist above still rejects `anchor_activities`, and
 * anchors are writable only through commitPlan's validated fixed-event branch.
 *
 * `activityRules` is a dedicated payload (T35), NOT a key in `approved`, keyed
 * by activity name -> `{ eligible_group_names, min_per_week, max_per_week,
 * priority }`.
 *
 * S0 (ADR 2026-08-08): commitIngest is now a THIN adapter. It validates the
 * whitelist, then produces a pure `ReconciliationPlan` via `buildPlan` (renderer
 * side, no DB) and hands it to `commitPlan` — the single privileged committer
 * that resolves against the live DB and writes. The op sequence is byte-identical
 * to the pre-S0 importer, proven by the golden-ops characterization test.
 *
 * Returns `{ created: { [entity]: count }, total,
 *            fixedEvents: { created, skipped, partial }, replaced? }`.
 *
 * D1 (dry-run reconciliation): pass `dryRun: true` and the transaction runs
 * to completion, then rolls back the same way a HELD import does — nothing is
 * written. The returned shape gains `dryRun: true` and, when the dry run did
 * NOT hold, three more fields computed AFTER the rollback (see the dryRun
 * branch below, and commitPlan's own doc comment for the rollback mechanism):
 * `planItems` (the resolved plan.items), `fieldProvenance` (from
 * buildFieldProvenanceMap, entity:entityId:field -> 'human'|'import'), and
 * `legacyPriorityActivities` (from listLegacyPriorityActivities). A dry run
 * that DOES hold returns the normal `{ held: true, conflicts, ... }` shape,
 * with none of these three fields present — same as a real held commit.
 */
export function commitIngest(db, { approved, links, clears = {}, humanEditedFields = {}, camp_id, cohort_id = null, author_user_id, device_id, fixedEvents = [], activityRules = {}, mode = 'add', resolutions = [], base_generation = 0, dryRun = false }) {
  if (!approved || typeof approved !== 'object') throw new Error('ingest: nothing to commit')
  if (!camp_id) throw new Error('ingest: camp_id is required')

  for (const entity of Object.keys(approved)) {
    if (!INGESTIBLE_ENTITIES.includes(entity)) {
      throw new Error(`ingest: ${entity} cannot be created by an import`)
    }
  }

  // The PURE decision layer (ADR §1). buildPlan holds no DB handle; we hand it
  // the SAME `existing` snapshot ImportScreen builds for preview (S1a §1), so a
  // name the camp already has becomes `unchanged` (zero ops) IN THE PLAN, not a
  // blind create de-duped downstream. tiers/time_blocks are scoped to the active
  // Program exactly as ImportScreen.jsx ~150–153; everything else is camp-wide.
  // Replace mode intentionally wipes the camp's setup and recreates it, so
  // recognition does not apply to the six schedule-content entities — their
  // pre-teardown rows are about to be deleted anyway; recognizing them here
  // would falsely hold every item once teardown removed the rows the
  // `unchanged` items point at. M4 §D2: 'locations' is the one exception —
  // it is durable, never torn down by replace mode, so buildExistingSnapshot
  // now takes `mode` itself and scans locations live in every mode.
  const existing = buildExistingSnapshot(db, camp_id, cohort_id, mode)
  // S2c §1: fold the rule/unit side-channels into per-row records at THIS
  // boundary; buildPlan sees only records. `links`/`activityRules` are still
  // passed for the create path's back-compat fallback (a bare-string caller).
  const recordApproved = foldApprovedToRecords(approved, activityRules, links, clears)
  const plan = buildPlan(
    // S4b §4: base_generation (the workbook's exported op-log seq) flows into the
    // plan so commitPlan can gate import-over-import staleness. 0 for the raw
    // schedule/clipboard path leaves the clock gate inert.
    // ADR 2026-08-09 Decision 2: humanEditedFields flows straight through as a
    // top-level source key — buildPlan attaches it per-item as _humanFields.
    { approved: recordApproved, links, activityRules, fixedEvents, camp_id, cohort_id, mode, base_generation, humanEditedFields },
    existing,
    // T73: a director's per-conflict decisions from a prior held commit. buildPlan
    // consumes only the ambiguous_identity picks; stale picks flow to commitPlan.
    resolutions,
  )

  // B4: minted once per commitIngest call, threaded into commitPlan so every
  // import_evidence row this commit writes carries the same run id/timestamp
  // (docs/adr/2026-08-10-ingestion-evidence-persistence.md).
  const import_run_id = randomUUID()
  const committed_at = new Date().toISOString()

  const outcome = commitPlan(db, plan, { author_user_id: author_user_id ?? null, device_id, resolutions, import_run_id, committed_at, dryRun })

  // D1: these run strictly AFTER commitPlan returns — the dry-run transaction
  // has already rolled back by this point. Computing them earlier, inside the
  // still-open transaction, would let the dry run's own not-yet-rolled-back
  // ops masquerade as prior 'import' provenance and corrupt the C4 signal.
  if (dryRun && !outcome.held) {
    outcome.fieldProvenance = Object.fromEntries(buildFieldProvenanceMap(db, plan.items))
    outcome.legacyPriorityActivities = listLegacyPriorityActivities(db, camp_id)
    outcome.planItems = plan.items
  }

  return outcome
}

/**
 * The SINGLE privileged committer (ADR 2026-08-08 §1). commitPlan is the only
 * writer of field-delta ops in the reconciliation path: it resolves the plan
 * against the LIVE db (extending seedNameMaps: name->id, cohort filter) and
 * translates each FieldDelta 1:1 into an `appendOp`, inside one
 * `db.transaction()`. The only other appendOp caller reachable from here is
 * `replaceScope`, the replace-mode teardown, preserved verbatim (its
 * `__deleted__` tombstone ops are not field deltas).
 *
 * S0 exercises only the `create` and `unchanged` arms. `update`/`clear`/
 * `conflict` are typed by the plan but rejected here until their later slices
 * build the merge/staleness/alias semantics — routing one to commit today is a
 * programming error, not a runtime input, so it throws.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('../../src/ingest/buildPlan.js').ReconciliationPlan} plan
 * @param {{ author_user_id: string|null, device_id: string, import_run_id?: string, committed_at?: string, dryRun?: boolean }} actor
 */
export function commitPlan(db, plan, { author_user_id = null, device_id, resolutions = [], import_run_id = null, committed_at = null, dryRun = false }) {
  // B4: a direct commitPlan caller (tests, or any future caller that skips
  // commitIngest) still gets evidence rows minted with a run id/timestamp of
  // their own, rather than writing NOT NULL columns as null.
  const evidenceRunId = import_run_id ?? randomUUID()
  const evidenceCommittedAt = committed_at ?? new Date().toISOString()
  const camp_id = plan.camp_id
  const cohort_id = plan.cohort_id ?? null
  const mode = plan.mode ?? 'add'

  // T73: a director's per-conflict decisions, indexed by entity|recognitionKey(name)
  // |field?, using the SAME recognitionKey the rest of the path uses so the key
  // cannot disagree about "the same name" (ADR §2; M4 §D3 extends this to be
  // entity-aware). buildPlan already consumed the ambiguous_identity picks
  // (pinning identity / forcing create); commitPlan honors the ambiguous
  // 'create' pick's collision bypass here, and the stale picks below.
  const resIndex = new Map()
  for (const r of Array.isArray(resolutions) ? resolutions : []) {
    if (!r || !r.entity) continue
    resIndex.set(`${r.entity}|${recognitionKey(r.entity, r.name)}|${r.field ?? ''}`, r)
  }
  const resolutionFor = (entity, name, field = '') =>
    resIndex.get(`${entity}|${recognitionKey(entity, name)}|${field ?? ''}`)

  // S2a: every field-value op this committer writes is import-authored. Set once
  // here and threaded into EVERY appendOp commitPlan makes — commitCreate's
  // field loop, the fixed-events anchor writes, and replaceScope's field-value
  // write (its `__deleted__` tombstones stay NULL). This is the commitPlan-WIDE
  // seam the ADR §2 census requires: 'import' is producible ONLY from here.
  const IMPORT_SOURCE = 'import'

  const created = {}
  for (const entity of INGESTIBLE_ENTITIES) created[entity] = 0
  let total = 0
  // S2b: field-level writes to an existing (recognized) entity. Distinct from
  // `total`, which counts newly-created entities — an update writes ops to a row
  // that already exists, not a new row.
  let updated = 0

  // Unit name -> tier id, so a group created in this same transaction can be
  // filed under a unit created moments earlier; seeded (below) with units the
  // camp already has, in the SAME Program only (T33). blockIdByName/dayIdByName/
  // groupIdByName resolve fixed events by name against rows in scope OR born
  // this run.
  const tierIdByName = new Map()
  const blockIdByName = new Map()
  const dayIdByName = new Map()
  const groupIdByName = new Map()
  // M4 §D1b/§13: TRIM-only, case-sensitive keys — NOT normalizeName — matching
  // deriveLocationId's own normalization contract exactly, so a lookup here
  // agrees with the id a create/mint would derive for the same name.
  const locationIdByName = new Map()

  // Populated INSIDE the transaction, after any teardown (ADR §4): in replace
  // mode the rows these maps would name are about to be destroyed, and seeding
  // first would file a new bunk under a unit that no longer exists. In add mode
  // nothing has changed — the same queries, the same results.
  function seedNameMaps() {
    for (const row of db.prepare('SELECT id, name, cohort_id FROM tiers WHERE camp_id = ?').all(camp_id)) {
      if (row.name && (row.cohort_id ?? null) === (cohort_id ?? null)) {
        tierIdByName.set(String(row.name).trim().toLowerCase(), row.id)
      }
    }
    for (const row of db.prepare('SELECT id, name, cohort_id FROM time_blocks WHERE camp_id = ?').all(camp_id)) {
      if (row.name && (row.cohort_id ?? null) === (cohort_id ?? null)) blockIdByName.set(normalizeName(row.name), row.id)
    }
    for (const row of db.prepare('SELECT id, label FROM days_of_operation WHERE camp_id = ?').all(camp_id)) {
      if (row.label) dayIdByName.set(normalizeName(row.label), row.id)
    }
    for (const row of db.prepare('SELECT id, name FROM groups WHERE camp_id = ?').all(camp_id)) {
      if (row.name) groupIdByName.set(normalizeName(row.name), row.id)
    }
    for (const row of db.prepare('SELECT id, name FROM locations WHERE camp_id = ?').all(camp_id)) {
      if (row.name) locationIdByName.set(String(row.name).trim(), row.id)
    }
  }

  // Recognition maps for commit-time re-resolution (S1a §2): per entity, a
  // normalized-name -> SET of live row ids. A SET (not a single id) so fact 3's
  // "Art"/"art " collision is visible. Cohort-scoped for tiers/time_blocks
  // EXACTLY as buildExistingSnapshot scopes them, so the two layers cannot
  // disagree about "the same name". Built once from the LIVE DB after teardown.
  function seedRecognitionMaps() {
    const maps = {}
    for (const entity of INGESTIBLE_ENTITIES) maps[entity] = new Map()
    const add = (entity, key, id) => {
      if (!key) return
      if (!maps[entity].has(key)) maps[entity].set(key, new Set())
      maps[entity].get(key).add(id)
    }
    for (const entity of INGESTIBLE_ENTITIES) {
      const scoped = COHORT_SCOPED.has(entity)
      const cols = scoped
        ? `id, ${nameColumnFor(entity)} AS name, cohort_id`
        : `id, ${nameColumnFor(entity)} AS name`
      for (const row of db.prepare(`SELECT ${cols} FROM ${entity} WHERE camp_id = ?`).all(camp_id)) {
        if (scoped && cohort_id && row.cohort_id !== cohort_id) continue
        add(entity, recognitionKey(entity, row.name), row.id)
      }
    }
    return maps
  }

  const liveName = (entity, id) => {
    const row = db.prepare(`SELECT ${nameColumnFor(entity)} AS name FROM ${entity} WHERE id = ?`).get(id)
    return row ? row.name : null
  }
  // B4: one activity's inferred rule -> up to two evidence rows (the two
  // fields buildPlan can write from a rule: eligible_group_names, min_per_week).
  // Confidence is derived honestly rather than invented — activity rules carry
  // no explicit confidence tier today (ADR OQ3 permits this to flex): 'high'
  // when the rule's eligibility was actually observed AND resolved to a
  // concrete list, 'low' otherwise (no signal, or the ambiguous-fallback null).
  // D3: the SAME support objects already handed to writeEvidence, collected
  // in-memory so commitIngest's dry-run branch can surface them for the "why
  // does Shoresh think this" disclosure — no recompute, no extra DB read.
  // Survives a dryRun rollback because it's plain JS, not a DB write.
  // Activities key by entity_id (matches planItems' item.entity_id, the D3
  // join key); fixed events key by name (their decisions carry no entity_id
  // — see reconciliationReport.js's addFixedEventDecision). Declared here,
  // right above their first writer, rather than down by `conflicts` — both
  // writeActivityEvidence below and the fixed-event writeEvidence call site
  // close over these directly.
  const evidenceSupportActivities = {}
  const evidenceSupportFixedEvents = {}

  const writeActivityEvidence = (entityId, rule) => {
    if (!rule?.support) return
    const confidence = rule.eligibility_known && Array.isArray(rule.eligible_group_names) ? 'high' : 'low'
    for (const field of ['eligible_group_names', 'min_per_week']) {
      writeEvidence(db, {
        camp_id, entity_type: 'activities', entity_id: entityId, field,
        tag: 'inferred', confidence, support: rule.support,
        import_run_id: evidenceRunId, committed_at: evidenceCommittedAt,
      })
    }
    evidenceSupportActivities[entityId] = rule.support
  }

  const idExists = (entity, id) =>
    !!db.prepare(`SELECT 1 FROM ${entity} WHERE id = ? AND camp_id = ?`).get(id, camp_id)
  const makeConflict = (item, candidateIds) => ({
    op: 'conflict',
    entity: item.entity,
    entity_id: null,
    reason: 'ambiguous_identity',
    fields: {},
    evidence: {
      tier: 'exact_name',
      candidates: candidateIds.map((id) => ({ id, name: liveName(item.entity, id) })),
    },
    _name: item._name,
  })

  // S2b: a protected (human-authored) field on an `update` item becomes a gated
  // `stale` FieldConflict — surfaced, never written — collected into the SAME
  // conflicts array S1a uses, so it trips the SAME hold-the-whole sentinel. The
  // decision for a raw source is made by provenance (latestOp.source); the clock
  // is carried only as evidence (field_last_seq shows WHEN the human wrote), so
  // the shape stays forward-compatible with S4. Shape is RECONCILIATION_PLAN_TYPE
  // §2(e), unchanged.
  const makeStaleConflict = (item, field, delta, latest) => ({
    op: 'conflict',
    entity: item.entity,
    entity_id: item.entity_id,
    reason: 'stale',
    fields: {
      [field]: {
        from: delta.from ?? null,
        to: delta.to,
        source: 'import',
        conflict: {
          reason: 'stale',
          clock: { field_last_seq: latest.seq, source_base_seq: plan.base_generation ?? 0 },
          competing: [
            { value: delta.from ?? null, source: 'human', seq: latest.seq },
            { value: delta.to, source: 'import' },
          ],
        },
      },
    },
    evidence: { tier: 'exact_name', matched_name: item.evidence?.matched_name ?? item._name },
    _name: item._name,
  })

  // S2c §4. A held field conflict from the update path — validation failure, an
  // unresolvable eligibility label, or an unresolvable unit. Collected into the
  // SAME `conflicts` array (never thrown), tripping the SAME hold-the-whole
  // sentinel as `stale`/`ambiguous_identity`. `dbFieldFor`/`resolveFieldWrite`
  // are shared with the dev mock (src/ingest/fieldUpdate.js) so they cannot drift.
  const makeFieldConflict = (item, reason, field, delta, detail) => ({
    op: 'conflict',
    entity: item.entity,
    entity_id: item.entity_id,
    reason,
    fields: {
      [field]: {
        from: delta.from ?? null,
        to: delta.to,
        source: 'import',
        conflict: { reason, ...detail },
      },
    },
    evidence: { tier: 'exact_name', matched_name: item.evidence?.matched_name ?? item._name },
    _name: item._name,
  })

  // S4b §2 (RISK H). A uuid-matched row whose target is absent from the live camp
  // (a foreign/hand-mangled id, or an entity a peer deleted in the review window):
  // surfaced as `missing_target`, never silently downgraded to a create (that would
  // duplicate an entity the director meant to edit). Gated into `conflicts` → HELD.
  const makeMissingTarget = (item) => ({
    op: 'conflict',
    entity: item.entity,
    entity_id: item.entity_id ?? null,
    reason: 'missing_target',
    fields: {},
    evidence: { tier: 'uuid' },
    _name: item._name,
  })

  // Held-import sentinel (S1a §2). A conflict must NOT throw a plain error (that
  // reads as a crash) but the whole import must still write nothing. Throwing a
  // marked error rolls the transaction back atomically — teardown included — so
  // the held path leaves the DB byte-identical; we catch it outside and return a
  // held outcome instead of re-throwing.
  const HELD = Symbol('held')
  // D1 (dry-run reconciliation, docs/adr/2026-08-10-...). Thrown ONLY after the
  // run() closure has done all its work (see the end of run(), below) so every
  // count/drift array is already computed when we roll back and read them.
  const DRY_RUN = Symbol('dryRun')
  const conflicts = []

  const fixedCreated = []
  const fixedSkipped = []
  const fixedPartial = []
  const fixedUnchanged = []
  const fixedRejected = []
  const fixedMoved = []
  const fixedScopeChanged = []

  // T72: slot identity of a fixed-event occurrence — "this activity, in this
  // block, on this day, for this cohort." is_all_groups/group_ids are attributes
  // of the occurrence, deliberately NOT part of the key (ADR §1). camp is fixed
  // by the camp-scoped query. Used to recognize-then-skip an anchor already live.
  const anchorSlotKey = (cohortId, dayId, tbId, name) =>
    `${cohortId ?? ''}|${dayId}|${tbId}|${normalizeName(name)}`

  // C1b: the drift-pairing group is (cohort_id, normalizeName(name)) — the
  // dimension a director's move CAN'T change (saveAnchor mutates day_id/
  // time_block_id, never cohort_id or name; AnchorsScreen.jsx:315 vs :326).
  // day_id/time_block_id are the two coordinates that CAN drift, hence the
  // pairing key below one level under anchorSlotKey.
  const anchorGroupKey = (cohortId, name) => `${cohortId ?? ''}|${normalizeName(name)}`
  const anchorDaySlot = (dayId, tbId) => `${dayId}|${tbId}`

  // Fixed-event reimport tombstone fix: slot keys of anchor_activities whose
  // LATEST op is a DELETE_FIELD written with source==='human' — a director's
  // deliberate rejection (local delete or a replicated peer delete, both
  // forced 'human' by syncServer). Import teardown deletes write source=null
  // and are STRICTLY excluded by this === check, so replace-mode does not
  // tombstone its own re-creates. Reconstructs the dead row's identity from
  // its op history via restore.js's lastKnownFields (same mechanism the trash
  // can uses to restore a deleted record).
  // Unlike the Policy-A protection gate below (isProtected, which treats NULL
  // source as human to over-protect edits), this predicate requires an
  // EXPLICIT source==='human' delete: a NULL/legacy delete is ambiguous
  // between director-rejection and import-teardown, so it must NOT suppress
  // re-import.
  const rejectedSlotKeys = (db, camp_id) => {
    const rejected = new Set()
    const entityIds = db
      .prepare("SELECT DISTINCT entity_id FROM operations WHERE entity = 'anchor_activities'")
      .all()
      .map((r) => r.entity_id)
    for (const entity_id of entityIds) {
      const latest = latestOpForEntity(db, 'anchor_activities', entity_id)
      if (!latest || latest.field !== DELETE_FIELD || latest.source !== 'human') continue
      const fields = lastKnownFields(db, 'anchor_activities', entity_id)
      if (fields.get('camp_id') !== camp_id) continue
      const dayId = fields.get('day_id')
      const tbId = fields.get('time_block_id')
      const name = fields.get('name')
      if (!dayId || !tbId || !name) continue
      rejected.add(anchorSlotKey(fields.get('cohort_id') ?? null, dayId, tbId, name))
    }
    return rejected
  }
  let replaced = null

  // M4 §D1c. The ONE place an activity's location genuinely needs resolve-OR-
  // create: a brand-new activity, created via commitCreate, whose location
  // value was never separately proposed as its own `locations` entity item —
  // the S4 enrichment-workbook path's real shape (a director types a room name
  // directly into an editable cell, no corresponding "Locations" review row).
  // The common path (Q8's own gated flow, or an ordinary new-camp import) never
  // reaches the mint branch here: locations precedes activities in
  // INGESTIBLE_ENTITIES order (§D2), so a location approved as a create THIS
  // import is already live — and in locationIdByName — by the time this runs;
  // this is then a cache hit, not an actual create. Cross-device deterministic
  // (INV-1): the id is a pure function of (camp_id, trimmedName), same as D1a.
  const resolveOrCreateLocationId = (db, { camp_id, name, locationIdByName, author_user_id, device_id }) => {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) return null
    const cached = locationIdByName.get(trimmed)
    if (cached) return cached
    const id = deriveLocationId(camp_id, trimmed)
    if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(id)) {
      appendOp(db, { entity: 'locations', entity_id: id, field: 'camp_id', value: camp_id, author_user_id: author_user_id ?? null, device_id, parent_op_id: null, client_write_id: randomUUID(), source: IMPORT_SOURCE })
      appendOp(db, { entity: 'locations', entity_id: id, field: 'name', value: trimmed, author_user_id: author_user_id ?? null, device_id, parent_op_id: null, client_write_id: randomUUID(), source: IMPORT_SOURCE })
    }
    locationIdByName.set(trimmed, id)
    return id
  }

  // The write of one PlanItem: mint the row id, extract each FieldDelta's `to`
  // in order, resolve the commit-time reference fields (tier_id / activity
  // rules) against the live name maps, then emit one appendOp per non-null
  // field. This is the pre-S0 inner loop, now driven by the plan (ADR §2).
  const commitCreate = (item) => {
    const { entity, _name: name } = item
    // M4 §D1a: the ONE line that differs from every other entity's create —
    // deriveLocationId, never randomUUID, so the id is a pure function of
    // (camp_id, trimmedName) and identical across devices (INV-1).
    const entityId = entity === 'locations' ? deriveLocationId(camp_id, name) : randomUUID()
    const fields = {}
    for (const [field, delta] of Object.entries(item.fields)) fields[field] = delta.to

    if (entity === 'tiers') tierIdByName.set(name.toLowerCase(), entityId)
    if (entity === 'time_blocks') blockIdByName.set(normalizeName(name), entityId)
    if (entity === 'days_of_operation') dayIdByName.set(normalizeName(name), entityId)
    if (entity === 'groups') groupIdByName.set(normalizeName(name), entityId)
    // M4 §D1a/§D2: registered BEFORE any activities create runs, in the same
    // toCreate loop — INGESTIBLE_ENTITIES order places locations before
    // activities, so this is always populated by the time an activity's
    // location resolves (§D1c below reads this map).
    if (entity === 'locations') locationIdByName.set(String(name).trim(), entityId)
    if (entity === 'groups') {
      // The file said which unit this bunk is in; file it there rather than
      // leaving the director to assign 33 bunks by hand.
      const unit = item._link_unit
      const tierId = unit ? tierIdByName.get(String(unit).trim().toLowerCase()) : null
      if (tierId) fields.tier_id = tierId
    }
    if (entity === 'activities') {
      // Inferred (or director-edited) rules, keyed by the exact activity name
      // the director approved. The op log is the boundary that owns validation
      // (round 2 review, Fix 4): buildSchedule.js's runRound only matches
      // priority 'high'/'low', so anything else is dropped rather than written
      // to a silently-unplaceable state; likewise a min/max that is not a
      // positive integer is nonsense the write boundary refuses to trust.
      const rule = item._rule
      if (rule) {
        if (Number.isInteger(rule.min_per_week) && rule.min_per_week >= 1) fields.min_per_week = rule.min_per_week
        if (Number.isInteger(rule.max_per_week) && rule.max_per_week >= 1) fields.max_per_week = rule.max_per_week
        if (rule.priority === 'high' || rule.priority === 'low') fields.priority = rule.priority
        const groupIds = Array.isArray(rule.eligible_group_names)
          ? rule.eligible_group_names
              .map((n) => groupIdByName.get(normalizeName(n)))
              .filter(Boolean)
          : []
        // Unresolved names (director unticked that group) are dropped. If NONE
        // resolved, write nothing rather than '[]' — an empty JSON array reads
        // as "restricted to nothing", not "all groups".
        if (groupIds.length > 0) fields.eligible_group_ids = JSON.stringify(groupIds)
        // T61. An eligible activity asked for zero times a week is scheduled
        // zero times — correct and silently useless. Floored on both paths.
        if (groupIds.length > 0 && !(Number.isInteger(fields.min_per_week) && fields.min_per_week >= 1)) {
          fields.min_per_week = 1
        }
      }
      // M4 §D1c: a brand-new activity's location, resolved (or minted if truly
      // absent) inline — the ONE call site that genuinely needs resolve-OR-
      // create (see resolveOrCreateLocationId's own doc comment for why: a
      // director-typed room name with no separate `locations` create/review
      // item to have resolved it first, the S4 workbook path's real shape).
      if (rule?.location != null && rule.location !== '') {
        const locationId = resolveOrCreateLocationId(db, {
          camp_id, name: rule.location, locationIdByName, author_user_id, device_id,
        })
        if (locationId) {
          fields.location_id = locationId
          // Registry row 24 (Governor: ship in M4) — the captured/typed text
          // this activity's place came from, so a future "why?" panel can
          // answer it the same way eligible_group_names/min_per_week already can.
          writeEvidence(db, {
            camp_id, entity_type: 'activities', entity_id: entityId, field: 'location',
            tag: 'observed', confidence: 'high', support: { location: rule.location },
            import_run_id: evidenceRunId, committed_at: evidenceCommittedAt,
          })
        }
      }
      // B4: evidence for the observation this rule came from, keyed to the
      // entity id just minted above. Independent of which fields the rule
      // above actually resolved to a write — the "why" answers "what did the
      // source show", not "what got written" (ADR "On protected/CONFIRMED fields").
      writeActivityEvidence(entityId, rule)
    }

    // ADR 2026-08-09 Decision 2 — a field the director explicitly authored in
    // review (not the file's own inference) is stamped 'human', so a LATER
    // re-import proposing a different value holds a stale conflict instead of
    // silently overwriting it (Policy A, S2b), starting from this very first
    // write. Already normalized to stored-column names by buildPlan.
    const humanFields = new Set(item._humanFields ?? [])
    for (const [field, value] of Object.entries(fields)) {
      if (value === null || value === undefined) continue
      appendOp(db, {
        entity,
        entity_id: entityId,
        field,
        value,
        author_user_id: author_user_id ?? null,
        device_id,
        parent_op_id: null,
        client_write_id: randomUUID(),
        source: humanFields.has(field) ? 'human' : IMPORT_SOURCE,
      })
    }
    created[entity] += 1
    total += 1
  }

  // S2b: write ONE unprotected FieldDelta of an `update` item. The Policy A gate
  // (in the re-resolution loop) has already confirmed this field is import-owned
  // or never-set, so it writes freely: value = delta.to, source = 'import', and
  // parent_op_id = the field's prior op id (null only when the field had no prior
  // op). Direct appendOp — the same host-local committer path commitCreate uses;
  // detectConflict runs only on the WS submit_op path, not here (ADR §2 R6).
  // S2c §4: `field`/`value` are already the STORED column and the
  // validated/resolved value (resolveFieldWrite), so this stays a thin writer.
  const commitUpdate = ({ item, field, value, parent_op_id }) => {
    // S4b §3 (RISK I): the CLEAR sentinel must NEVER reach appendOp as a value —
    // that would append a Symbol and corrupt the op. A clear writes ONE field-null
    // op (the same field-null path replaceScope uses for weather_alternative_id).
    // The decide-phase already translates CLEAR→null, so this is belt-and-braces.
    const storedValue = value === CLEAR ? null : value
    // ADR 2026-08-09 Decision 2 — the SAME per-field human/import stamp as
    // commitCreate, on the update/clear path. `field` here is already the
    // dbField (decideFieldItem passes the stored column), matching how
    // buildPlan normalized `item._humanFields`.
    const isHuman = (item._humanFields ?? []).includes(field)
    appendOp(db, {
      entity: item.entity,
      entity_id: item.entity_id,
      field,
      value: storedValue,
      author_user_id: author_user_id ?? null,
      device_id,
      parent_op_id,
      client_write_id: randomUUID(),
      source: isHuman ? 'human' : IMPORT_SOURCE,
    })
    updated += 1
  }

  // One transaction for the whole import. Any throw below rolls back every op
  // and every projected row together, so the camp is either fully imported or
  // untouched (ADR §4).
  const run = db.transaction(() => {
    // T61. Replace-mode teardown runs FIRST and inside this transaction —
    // better-sqlite3 nests as savepoints, so the one outer transaction stays
    // the rollback boundary for teardown and create alike. Deletes precede
    // creates, which also lets the new records reuse the old names against
    // UNIQUE(camp_id, name).
    if (mode === 'replace') {
      replaced = replaceScope(db, { camp_id, author_user_id, device_id, source: IMPORT_SOURCE })
    }
    seedNameMaps()

    // Commit-time re-resolution (S1a §2). buildPlan set each item's identity
    // from the snapshot it saw at emit time; the review window between preview
    // and commit is exactly where a peer device can create or delete a same-name
    // row, so FINAL identity binding happens here, against the live DB. We
    // decide every item and collect conflicts BEFORE writing anything — nothing
    // is created until we know the import is not held.
    const recognition = seedRecognitionMaps()

    // T72 anchor recognition set: slot keys of every live anchor row in the camp
    // (ADR §2). Built once, after teardown, inside the transaction — same
    // discipline as seedRecognitionMaps. A held import rolls this back with all.
    const anchorSlots = new Set()
    // C1a: slotKey -> live group scope, built in the same scan (ADR Phase C,
    // C1a). anchorSlotKey deliberately excludes scope, so a director's scope
    // edit (AnchorsScreen) is invisible to the recognize-then-skip branch
    // above unless compared separately here. Read-only per ADR §4 — this map
    // is consulted below to REPORT a drift, never to write one.
    const liveAnchorScope = new Map()
    for (const row of db
      .prepare('SELECT cohort_id, day_id, time_block_id, name, is_all_groups, group_ids FROM anchor_activities WHERE camp_id = ?')
      .all(camp_id)) {
      const slotKey = anchorSlotKey(row.cohort_id, row.day_id, row.time_block_id, row.name)
      anchorSlots.add(slotKey)
      // Malformed group_ids (partial sync / hand-edited SQLite / old
      // migration) must not crash an unrelated import — mirror
      // AnchorsScreen.jsx's parseIdList defensive posture: a parse failure
      // makes this slot's scope "uncomparable" (null sentinel), so the
      // compare block below skips the drift check for it rather than
      // throwing a raw SyntaxError past the transaction.
      let groupIds
      try {
        const parsed = JSON.parse(row.group_ids ?? '[]')
        groupIds = Array.isArray(parsed) ? parsed : null
      } catch {
        groupIds = null
      }
      liveAnchorScope.set(slotKey, { is_all_groups: row.is_all_groups, group_ids: groupIds })
    }

    // Fixed-event reimport tombstone fix: built right after the live-anchor
    // scan, inside the same transaction, so a held import rolls it back too.
    // Replace mode is an intentional clean slate — the director asked to rebuild
    // the camp from this source — so it CLEARS prior rejections (product owner
    // 2026-08-10): an add-mode re-import honors a human rejection, a replace-mode
    // re-import brings rejected events back.
    const rejectedSlots = mode === 'replace' ? new Set() : rejectedSlotKeys(db, camp_id)

    const toCreate = []
    const toUpdate = []

    // S2b/S2c/S4b: decide one `update` OR `clear` item's field writes. A clear
    // carries `to: CLEAR` deltas; both flow through the SAME per-field gate.
    const decideFieldItem = (item) => {
      // Its recognized identity must still name a live row (a peer may have
      // deleted it in the window). A uuid-matched row re-holds as missing_target;
      // a name-matched row re-holds as ambiguous, carrying any competing row.
      if (!idExists(item.entity, item.entity_id)) {
        if (item.evidence?.tier === 'uuid') { conflicts.push(makeMissingTarget(item)); return }
        const ids = recognition[item.entity].get(recognitionKey(item.entity, item._name))
        conflicts.push(makeConflict(item, ids ? [...ids] : []))
        return
      }
      for (const [field, delta] of Object.entries(item.fields)) {
        const isClear = delta.to === CLEAR
        // S2c §4: provenance + parent op read against the STORED column
        // (eligible_groups -> eligible_group_ids, unit -> tier_id).
        const dbField = dbFieldFor(field)
        const latest = latestOp(db, item.entity, item.entity_id, dbField)
        // S4b §3: a clear on a NEVER-SET field is a no-op — nothing to remove, no
        // spurious null op (prevents a wall of empty clears becoming empty ops).
        if (isClear && !latest) continue
        const res = resolutionFor(item.entity, item._name, field)
        // S4b §4 (RISK C): the ACTIVE base_generation staleness gate. For a
        // workbook (base_generation > 0), a field written AFTER the workbook was
        // exported (its op seq > base_generation) is stale — held — EVEN when the
        // field is import-owned, which Policy-A alone waves through. For a raw
        // schedule (base_generation 0) this is inert.
        const staleByClock = !!(plan.base_generation && latest && latest.seq > plan.base_generation)
        // Policy A protection gate: protected iff the field's latest op EXISTS and
        // its source is not 'import' (human/NULL). A clear on a human-authored
        // field is the most destructive delta, so it is gated ≥ an update (§3).
        const isProtected = !!latest && latest.source !== 'import'
        // S2c §4 / S4b §3: enqueue the write. A clear writes null (no validation);
        // a value is validated/resolved, a failure holds the field.
        const enqueue = (parent_op_id) => {
          if (isClear) { toUpdate.push({ item, field: dbField, value: null, parent_op_id }); return }
          const resolved = resolveFieldWrite(field, delta.to, { groupIdByName, tierIdByName, locationIdByName })
          if (!resolved.ok) conflicts.push(makeFieldConflict(item, resolved.reason, field, delta, resolved.detail))
          else {
            toUpdate.push({ item, field: resolved.field, value: resolved.value, parent_op_id })
            // Registry row 24 — the re-import's own observation of this
            // (already-recognized) activity's place, same channel as the
            // create-path evidence write above.
            if (field === 'location') {
              writeEvidence(db, {
                camp_id, entity_type: 'activities', entity_id: item.entity_id, field: 'location',
                tag: 'observed', confidence: 'high', support: { location: delta.to },
                import_run_id: evidenceRunId, committed_at: evidenceCommittedAt,
              })
            }
          }
        }
        if (isProtected || staleByClock) {
          // T73: 'accept' bypasses the gate (stamps source:'import', parents on the
          // live op); 'keep' drops the delta; no resolution → re-hold as stale.
          if (res?.reason === 'stale' && res.choice === 'accept') enqueue(latest.id)
          else if (res?.reason === 'stale' && res.choice === 'keep') { /* dropped — hand-edit kept */ }
          else conflicts.push(makeStaleConflict(item, field, delta, latest))
        } else {
          enqueue(latest ? latest.id : null)
        }
      }
    }

    for (const item of plan.items) {
      switch (item.op) {
        case 'create': {
          const ids = recognition[item.entity].get(recognitionKey(item.entity, item._name))
          if (ids && ids.size >= 1) {
            // T73: a director who resolved an ambiguity to "create new" pinned
            // this create; honor it by bypassing the normalize-collision→conflict
            // conversion — UNLESS a candidate now shares the RAW name (UNIQUE
            // would throw). A raw-name duplicate re-holds rather than throwing
            // (ADR §2/§4); a genuinely-new raw name (the "Art" vs "art " case)
            // creates cleanly.
            const res = resolutionFor(item.entity, item._name)
            const pinnedCreate = res?.reason === 'ambiguous_identity' && res.choice === 'create'
            const rawDuplicate = pinnedCreate && [...ids].some((id) => liveName(item.entity, id) === item._name)
            if (pinnedCreate && !rawDuplicate) {
              toCreate.push(item)
            } else {
              // A peer created this same-name entity (one row), or the camp holds
              // two rows that normalize alike (>1). Either way the world changed
              // under the plan — never commitCreate (that throws at UNIQUE),
              // never auto-pick. Surface the colliding row(s) for review.
              conflicts.push(makeConflict(item, [...ids]))
            }
          } else {
            toCreate.push(item)
          }
          break
        }
        case 'unchanged': {
          // Its recognized identity must still name a live row. If a peer
          // deleted it in the window, whether to re-create is a human decision,
          // never a silent re-mint — hold it as a conflict. A uuid-matched row
          // re-holds as missing_target (S4b); a name-matched row as ambiguous,
          // carrying any now-competing same-name row as a candidate.
          if (!idExists(item.entity, item.entity_id)) {
            if (item.evidence?.tier === 'uuid') { conflicts.push(makeMissingTarget(item)); break }
            const ids = recognition[item.entity].get(recognitionKey(item.entity, item._name))
            conflicts.push(makeConflict(item, ids ? [...ids] : []))
          }
          break
        }
        // S2b/S2c update AND S4b clear share the same per-field gate (decideFieldItem).
        case 'update':
        case 'clear':
          decideFieldItem(item)
          break
        case 'conflict':
          // buildPlan surfaces ambiguous_identity (§3) and, at S4b, the id-tier's
          // missing_target plus the workbook adapter's duplicate_id/possible_lost_id;
          // commitPlan itself may produce a `stale` conflict (the field gate above).
          // All are gated into `conflicts` (no op, no throw). S2c §4 adds validation
          // / eligibility_unresolved / unit_unresolved. Any other reason is a bug.
          // S1b §4: alias_divergence — a single-host preview→commit race (the
          // alias map said label->A, but a live different-entity exact-name
          // match B now exists), NOT the cross-device divergence the
          // superseded S1b ADRs solved for (there is no second writer). Same
          // held-not-thrown treatment as every other conflict reason here.
          if (['ambiguous_identity', 'stale', 'validation', 'eligibility_unresolved', 'unit_unresolved', 'location_unresolved', 'missing_target', 'duplicate_id', 'possible_lost_id', 'alias_divergence'].includes(item.reason)) conflicts.push(item)
          else throw new Error(`commitPlan: conflict reason "${item.reason}" is not implemented at S1a`)
          break
        default:
          throw new Error(`commitPlan: unknown op "${item.op}"`)
      }
    }

    // Hold-the-whole-import (product owner, 2026-08-08): any conflict means the
    // WHOLE commit writes nothing. Throwing the sentinel rolls back everything —
    // including replace-mode teardown — so a held import is atomically a no-op,
    // distinguishable from a real error by the marker (caught below).
    if (conflicts.length > 0) {
      const held = new Error('commitPlan: import held for review')
      held[HELD] = true
      throw held
    }

    // No conflicts — commit the plan in full. Items are emitted in
    // INGESTIBLE_ENTITIES order, so tiers land before groups (tier_id
    // resolvable) and groups before activities (group ids resolvable) — the
    // same registration-before-use the pre-S0 loop relied on.
    for (const item of toCreate) commitCreate(item)
    // S2b: unprotected field updates, after creates. commitUpdate targets rows
    // that already exist, so ordering against creates is immaterial.
    for (const u of toUpdate) commitUpdate(u)

    // B4: recognized activities (re-imported, 'unchanged' or 'update'/'clear')
    // upsert their evidence too, keyed to the id buildPlan already resolved —
    // the required demonstration of latest-wins re-import (ADR "On re-import").
    // A conflict on any of these items would already have held the whole
    // transaction above, so reaching here means entity_id is live.
    for (const item of plan.items) {
      if (item.entity !== 'activities') continue
      if (item.op !== 'unchanged' && item.op !== 'update' && item.op !== 'clear') continue
      writeActivityEvidence(item.entity_id, item._rule)
    }

    // C1b: read-only slot-drift MOVED signal (docs/work/tickets/
    // C1b-anchor-slot-drift-moved-signal.md). A director who moves a live
    // anchor via AnchorsScreen (day_id/time_block_id, never cohort_id or
    // name — saveAnchor, AnchorsScreen.jsx:315) leaves T72's exact-slot
    // recognize-then-skip blind to the drift: re-importing the ORIGINAL file
    // would silently mint a duplicate at the old slot. A naive "match by name
    // at a different slot" is unsafe (names aren't unique, per-day fan-out
    // breaks 1:1 cardinality) so this is a set-cardinality pre-pass, computed
    // once here — after the live-anchor scan/teardown and name-map resolution,
    // before ANY fixed-event write — partitioning both sides by (cohort_id,
    // normalizeName(name)) (ADR §1: is_all_groups/group_ids are occurrence
    // attributes, never part of slot identity, so they never enter this key
    // either). Read-only: this pre-pass NEVER appends an op to an anchor row,
    // it only decides which file slot the loop below reports as moved instead
    // of creating.
    const liveByGroup = new Map() // groupKey -> Set("dayId|tbId")
    for (const row of db
      .prepare('SELECT cohort_id, day_id, time_block_id, name FROM anchor_activities WHERE camp_id = ?')
      .all(camp_id)) {
      const g = anchorGroupKey(row.cohort_id, row.name)
      if (!liveByGroup.has(g)) liveByGroup.set(g, new Set())
      liveByGroup.get(g).add(anchorDaySlot(row.day_id, row.time_block_id))
    }

    // Deliberately re-derives tbId/dayId from blockIdByName/dayIdByName here,
    // duplicating the write loop's resolution below: this pre-pass must be a
    // self-contained, side-effect-free pass over the file that completes BEFORE
    // any create decision, so it cannot share the write loop's single walk
    // without entangling the cardinality analysis with the writes it gates.
    const fileByGroup = new Map() // groupKey -> Map("dayId|tbId" -> fe.name)
    for (const fe of plan.fixedEvents) {
      const tbId = blockIdByName.get(normalizeName(fe.time_block))
      if (!tbId) continue
      const g = anchorGroupKey(cohort_id, fe.name)
      if (!fileByGroup.has(g)) fileByGroup.set(g, new Map())
      const slots = fileByGroup.get(g)
      for (const d of fe.days ?? []) {
        const dayId = dayIdByName.get(normalizeName(d))
        if (!dayId) continue
        const slot = anchorDaySlot(dayId, tbId)
        if (!slots.has(slot)) slots.set(slot, fe.name)
      }
    }

    // anchorSlotKey(cohort, day, tb, name) of the FILE's slot -> reason, for
    // the single file slot each qualifying group pairs against the single
    // live slot it left unmatched. Keyed by the FULL slot identity (not just
    // day|tb) so two different-named events sharing a day/time-block can
    // never collide. Consulted (and suppresses the create) in the loop below.
    const movedBySlot = new Map()
    const groupKeys = new Set([...liveByGroup.keys(), ...fileByGroup.keys()])
    for (const g of groupKeys) {
      const liveSet = liveByGroup.get(g) ?? new Set()
      const fileMap = fileByGroup.get(g) ?? new Map()
      const liveUnmatched = [...liveSet].filter((s) => !fileMap.has(s))
      // A tombstoned file slot already resolves via the existing rejectedSlots
      // check below — it must never double as a move candidate, or a
      // deliberate director rejection reads as a drift (case 7).
      const fileUnmatched = [...fileMap.keys()].filter((s) => {
        if (liveSet.has(s)) return false
        const [dayId, tbId] = s.split('|')
        return !rejectedSlots.has(anchorSlotKey(cohort_id, dayId, tbId, fileMap.get(s)))
      })
      if (liveUnmatched.length !== 1 || fileUnmatched.length !== 1) continue // every other cardinality: no guess
      // The file still shows the OLD (stale) slot; the live row already lives
      // at the new one. Reason reads from the director's perspective: "the
      // file's slot" -> "where it actually is now".
      const [fromDay, fromTb] = fileUnmatched[0].split('|')
      const [toDay, toTb] = liveUnmatched[0].split('|')
      const name = fileMap.get(fileUnmatched[0])
      const reason = `moved from ${liveName('days_of_operation', fromDay)}/${liveName('time_blocks', fromTb)}`
        + ` to ${liveName('days_of_operation', toDay)}/${liveName('time_blocks', toTb)}`
      movedBySlot.set(anchorSlotKey(cohort_id, fromDay, fromTb, name), { name, reason })
    }

    // Fixed events, after the entity loop and INSIDE the same transaction, so
    // the whole import stays one atomic unit (ADR §4). anchor_activities is
    // written here and nowhere else in ingest; the generic whitelist never lets
    // it through.
    for (const fe of plan.fixedEvents) {
      const tbId = blockIdByName.get(normalizeName(fe.time_block))
      const requestedDays = (fe.days ?? []).length
      const dayIds = (fe.days ?? []).map((d) => dayIdByName.get(normalizeName(d))).filter(Boolean)
      if (!tbId || dayIds.length === 0) {
        fixedSkipped.push({ name: fe.name, reason: 'time block or day not created' })
        continue
      }
      const isAll = fe.scope?.is_all_groups ? 1 : 0
      let groupIds = []
      const requestedGroups = isAll ? 0 : (fe.scope?.groups ?? []).length
      if (!isAll) {
        groupIds = (fe.scope?.groups ?? []).map((g) => groupIdByName.get(normalizeName(g))).filter(Boolean)
        if (groupIds.length === 0) {
          fixedSkipped.push({ name: fe.name, reason: 'groups not created' })
          continue
        }
      }
      // Some — but not all — of the event's days or groups were imported. Write
      // what resolved but report the shortfall, or the result would silently
      // claim more than it created (ADR §1; Red Hat round-1).
      const droppedDays = requestedDays - dayIds.length
      const droppedGroups = requestedGroups - groupIds.length
      if (droppedDays > 0 || droppedGroups > 0) {
        const bits = []
        if (droppedDays > 0) bits.push(`${droppedDays} of ${requestedDays} day${requestedDays === 1 ? '' : 's'}`)
        if (droppedGroups > 0) bits.push(`${droppedGroups} of ${requestedGroups} group${requestedGroups === 1 ? '' : 's'}`)
        fixedPartial.push({ name: fe.name, reason: `${bits.join(' and ')} not imported` })
      }
      // Per-day fan-out — one row per resolved day, each its own uuid. Matches
      // AnchorsScreen: is_all_groups 1|0, group_ids a JSON string.
      for (const dayId of dayIds) {
        // T72: recognize-then-skip. If this slot is already live (or was just
        // created by an earlier day-row this same import), emit no ops and mint
        // no id — the occurrence is unchanged. Group-scope changes on an existing
        // slot are recognized here and left untouched (anchor updates are out of
        // scope per ADR §4).
        const slotKey = anchorSlotKey(cohort_id, dayId, tbId, fe.name)
        // C1b: this exact file slot is the one the cardinality pre-pass
        // paired against a single unmatched live slot elsewhere — report the
        // drift and suppress the create. No op is appended for either side.
        const moved = movedBySlot.get(slotKey)
        if (moved) {
          fixedMoved.push({ name: moved.name, reason: moved.reason })
          continue
        }
        // Live wins over tombstone — load-bearing for the restore escape
        // hatch: a director who un-deletes the anchor via the trash can must
        // see it recognized as unchanged, not rejected, on the next import.
        if (anchorSlots.has(slotKey)) {
          // C1a: group-scope drift, read-only (ADR Phase C, C1a; ADR §4 keeps
          // anchor updates out of scope). Slot identity is unchanged — this
          // still counts as `unchanged` (no create) — but the incoming
          // resolved scope may differ from the live row's scope, which is an
          // ORTHOGONAL fact worth surfacing alongside "unchanged", not a
          // replacement for it: B3 protection (ingest.b3-protection.test.js)
          // already asserts a hand-narrowed live scope re-imported against
          // its original file counts as unchanged, and that must keep
          // holding. Gated on droppedGroups === 0: a partial group
          // resolution makes groupIds incomplete, so comparing it would
          // report a false drift.
          // Round 2 fix 1: a live row with unparseable group_ids sets
          // liveScope.group_ids to the `null` sentinel — that slot's scope is
          // uncomparable, so skip the drift check for it rather than crash or
          // guess.
          const liveScope = liveAnchorScope.get(slotKey)
          if (droppedGroups === 0 && liveScope?.group_ids !== null) {
            // Round 2 fix 2: dedup both sides before compare — upstream import
            // sources are not guaranteed to dedup, and a duplicate group name
            // in the incoming scope must not read as a scope change.
            const dedupSort = (ids) => [...new Set(ids)].sort()
            const incomingGroupIds = dedupSort(groupIds)
            const liveGroupIds = dedupSort(liveScope?.group_ids ?? [])
            const scopeDiffers = Boolean(liveScope) && (
              Boolean(liveScope.is_all_groups) !== Boolean(isAll)
              || JSON.stringify(incomingGroupIds) !== JSON.stringify(liveGroupIds)
            )
            if (scopeDiffers) {
              const describe = (allGroups, ids) =>
                allGroups ? 'all groups' : ids.map((id) => liveName('groups', id)).join(', ')
              const from = describe(Boolean(liveScope.is_all_groups), liveGroupIds)
              const to = describe(Boolean(isAll), incomingGroupIds)
              fixedScopeChanged.push({ name: fe.name, reason: `scope changed from ${from} to ${to}` })
            }
          }
          fixedUnchanged.push({ name: fe.name })
          continue
        }
        if (rejectedSlots.has(slotKey)) {
          fixedRejected.push({ name: fe.name })
          continue
        }
        anchorSlots.add(slotKey)
        const anchorId = randomUUID()
        // B4: evidence for a CREATED anchor only (ADR scope: unchanged-anchor
        // recompute is deferred — the skip branch above has only a slotKey,
        // not a live anchor id, resolving it cleanly is a later slice).
        // `fe.support` describes the WHOLE inferred event (days/scope across
        // all its occurrences), not this one day-row — the SAME support
        // object is written against every anchor this fe's per-day fan-out
        // creates, deliberately, so a future "why?" read is not misread as a
        // per-day-specific observation.
        if (fe.support) {
          for (const field of ['days', 'scope']) {
            writeEvidence(db, {
              camp_id, entity_type: 'anchor_activities', entity_id: anchorId, field,
              tag: 'inferred', confidence: fe.confidence, support: fe.support,
              import_run_id: evidenceRunId, committed_at: evidenceCommittedAt,
            })
          }
          evidenceSupportFixedEvents[fe.name] = fe.support
        }
        const fields = {
          camp_id,
          cohort_id,
          day_id: dayId,
          time_block_id: tbId,
          name: String(fe.name ?? '').trim(),
          is_all_groups: isAll,
          group_ids: JSON.stringify(isAll ? [] : groupIds),
        }
        for (const [field, value] of Object.entries(fields)) {
          if (value === null || value === undefined) continue
          appendOp(db, {
            entity: 'anchor_activities',
            entity_id: anchorId,
            field,
            value,
            author_user_id: author_user_id ?? null,
            device_id,
            parent_op_id: null,
            client_write_id: randomUUID(),
            source: IMPORT_SOURCE,
          })
        }
        fixedCreated.push(anchorId)
      }
    }

    // D1: everything above ran and every count/drift array is populated —
    // abort the transaction now so dryRun writes nothing, same rollback
    // mechanism as HELD. Ordering matters: this fires AFTER the HELD throw's
    // earlier point (~:1069), so a would-be-held dry run still returns the
    // normal held shape, never reaching here.
    if (dryRun) {
      const abort = new Error('commitPlan: dry run')
      abort[DRY_RUN] = true
      throw abort
    }
  })

  let held = false
  let dryRunAborted = false
  try {
    run()
  } catch (e) {
    if (e && e[HELD]) held = true // the transaction rolled back; nothing written
    else if (e && e[DRY_RUN]) dryRunAborted = true // rolled back; report computed outcome
    else throw e
  }

  if (held) {
    // Everything rolled back — no rows, no ops, no teardown. Report the held
    // conflicts for the director to resolve, clearly NOT a thrown error.
    return {
      held: true,
      conflicts,
      created,
      total,
      updated: 0,
      fixedEvents: { created: 0, unchanged: 0, skipped: [], partial: [], rejected: [], moved: [], scopeChanged: [] },
    }
  }

  const outcome = {
    held: false,
    conflicts: [],
    created,
    total,
    updated,
    fixedEvents: {
      created: fixedCreated.length,
      unchanged: fixedUnchanged.length,
      skipped: fixedSkipped,
      partial: fixedPartial,
      rejected: fixedRejected,
      moved: fixedMoved,
      scopeChanged: fixedScopeChanged,
    },
  }
  if (replaced) outcome.replaced = replaced
  if (dryRunAborted) outcome.dryRun = true
  if (dryRunAborted) {
    outcome.evidenceSupport = { activities: evidenceSupportActivities, fixedEvents: evidenceSupportFixedEvents }
  }
  return outcome
}
