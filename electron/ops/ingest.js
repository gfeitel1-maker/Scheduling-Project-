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
import { PARENT_SCOPED_ENTITIES } from './campScopedEntities.js'
import { normalizeName } from '../../src/ingest/preview.js'
import { buildPlan } from '../../src/ingest/buildPlan.js'

// ADR §2. Kept here rather than imported from the renderer so the guarantee
// lives with the code that writes; ingest.test.js asserts the two agree.
export const INGESTIBLE_ENTITIES = Object.freeze([
  'cohorts', 'tiers', 'groups', 'days_of_operation', 'time_blocks', 'activities',
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
const COHORT_SCOPED = Object.freeze(new Set(['tiers', 'time_blocks']))

// S2b: the comparable value columns buildPlan diffs a recognized entity's
// proposed fields against (beyond id + name, and the cohort_id already carried
// for scoped entities). These are exactly the columns commitCreate writes and
// fieldsFor derives, so a re-import can tell a changed field from an unchanged
// one. camp_id is deliberately absent — it never changes and would only add
// noise to the diff.
const COMPARABLE_COLUMNS = Object.freeze({
  cohorts: [],
  tiers: ['sort_order'],
  groups: ['availability'],
  days_of_operation: ['day_of_week', 'sort_order'],
  time_blocks: ['start_time', 'end_time', 'sort_order'],
  activities: [],
})

/**
 * The `existing` snapshot buildPlan recognizes against (S1a §1), read from the
 * live DB — the same shape ImportScreen builds for `buildPreview`: rows carry
 * `{ id, name }` (days expose their `label` AS `name` so `normalizeName` sees
 * it), and tiers/time_blocks are filtered to the active Program when one is
 * given, camp-wide otherwise. Entity names come from the frozen whitelist, never
 * a caller, so interpolating them into the query is safe.
 */
function buildExistingSnapshot(db, camp_id, cohort_id) {
  const existing = {}
  for (const entity of INGESTIBLE_ENTITIES) {
    const scoped = COHORT_SCOPED.has(entity)
    const cols = [
      'id',
      `${nameColumnFor(entity)} AS name`,
      ...(scoped ? ['cohort_id'] : []),
      ...(COMPARABLE_COLUMNS[entity] ?? []),
    ].join(', ')
    const rows = db.prepare(`SELECT ${cols} FROM ${entity} WHERE camp_id = ?`).all(camp_id)
    existing[entity] = scoped && cohort_id ? rows.filter((r) => r.cohort_id === cohort_id) : rows
  }
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
 */
export function commitIngest(db, { approved, links, camp_id, cohort_id = null, author_user_id, device_id, fixedEvents = [], activityRules = {}, mode = 'add', resolutions = [] }) {
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
  // recognition does not apply — a null snapshot keeps the blind-create path and
  // its byte-identical op sequence. The pre-teardown rows the snapshot would see
  // are about to be deleted anyway; recognizing them here would falsely hold
  // every item once teardown removed the rows the `unchanged` items point at.
  const existing = mode === 'replace' ? null : buildExistingSnapshot(db, camp_id, cohort_id)
  const plan = buildPlan(
    { approved, links, activityRules, fixedEvents, camp_id, cohort_id, mode },
    existing,
    // T73: a director's per-conflict decisions from a prior held commit. buildPlan
    // consumes only the ambiguous_identity picks; stale picks flow to commitPlan.
    resolutions,
  )

  return commitPlan(db, plan, { author_user_id: author_user_id ?? null, device_id, resolutions })
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
 * @param {{ author_user_id: string|null, device_id: string }} actor
 */
export function commitPlan(db, plan, { author_user_id = null, device_id, resolutions = [] }) {
  const camp_id = plan.camp_id
  const cohort_id = plan.cohort_id ?? null
  const mode = plan.mode ?? 'add'

  // T73: a director's per-conflict decisions, indexed by entity|normalizeName(name)
  // |field?, using the SAME normalizeName the rest of the path uses so the key
  // cannot disagree about "the same name" (ADR §2). buildPlan already consumed the
  // ambiguous_identity picks (pinning identity / forcing create); commitPlan honors
  // the ambiguous 'create' pick's collision bypass here, and the stale picks below.
  const resIndex = new Map()
  for (const r of Array.isArray(resolutions) ? resolutions : []) {
    if (!r || !r.entity) continue
    resIndex.set(`${r.entity}|${normalizeName(r.name)}|${r.field ?? ''}`, r)
  }
  const resolutionFor = (entity, name, field = '') =>
    resIndex.get(`${entity}|${normalizeName(name)}|${field ?? ''}`)

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
        add(entity, normalizeName(row.name), row.id)
      }
    }
    return maps
  }

  const liveName = (entity, id) => {
    const row = db.prepare(`SELECT ${nameColumnFor(entity)} AS name FROM ${entity} WHERE id = ?`).get(id)
    return row ? row.name : null
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

  // Held-import sentinel (S1a §2). A conflict must NOT throw a plain error (that
  // reads as a crash) but the whole import must still write nothing. Throwing a
  // marked error rolls the transaction back atomically — teardown included — so
  // the held path leaves the DB byte-identical; we catch it outside and return a
  // held outcome instead of re-throwing.
  const HELD = Symbol('held')
  const conflicts = []

  const fixedCreated = []
  const fixedSkipped = []
  const fixedPartial = []
  let replaced = null

  // The write of one PlanItem: mint the row id, extract each FieldDelta's `to`
  // in order, resolve the commit-time reference fields (tier_id / activity
  // rules) against the live name maps, then emit one appendOp per non-null
  // field. This is the pre-S0 inner loop, now driven by the plan (ADR §2).
  const commitCreate = (item) => {
    const { entity, _name: name } = item
    const entityId = randomUUID()
    const fields = {}
    for (const [field, delta] of Object.entries(item.fields)) fields[field] = delta.to

    if (entity === 'tiers') tierIdByName.set(name.toLowerCase(), entityId)
    if (entity === 'time_blocks') blockIdByName.set(normalizeName(name), entityId)
    if (entity === 'days_of_operation') dayIdByName.set(normalizeName(name), entityId)
    if (entity === 'groups') groupIdByName.set(normalizeName(name), entityId)
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
    }

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
        source: IMPORT_SOURCE,
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
  const commitUpdate = ({ item, field, delta, parent_op_id }) => {
    appendOp(db, {
      entity: item.entity,
      entity_id: item.entity_id,
      field,
      value: delta.to,
      author_user_id: author_user_id ?? null,
      device_id,
      parent_op_id,
      client_write_id: randomUUID(),
      source: IMPORT_SOURCE,
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
    const toCreate = []
    const toUpdate = []
    for (const item of plan.items) {
      switch (item.op) {
        case 'create': {
          const ids = recognition[item.entity].get(normalizeName(item._name))
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
          // never a silent re-mint — hold it as a conflict, carrying any
          // now-competing same-name row as a candidate.
          if (!idExists(item.entity, item.entity_id)) {
            const ids = recognition[item.entity].get(normalizeName(item._name))
            conflicts.push(makeConflict(item, ids ? [...ids] : []))
          }
          break
        }
        case 'update': {
          // S2b. Its recognized identity must still name a live row (a peer may
          // have deleted it in the window) — same guard as `unchanged`.
          if (!idExists(item.entity, item.entity_id)) {
            const ids = recognition[item.entity].get(normalizeName(item._name))
            conflicts.push(makeConflict(item, ids ? [...ids] : []))
            break
          }
          // Policy A protection gate, per FieldDelta, against the authoritative
          // op-log (ADR §2). Protected iff the field's latest op EXISTS and its
          // source is not 'import' (i.e. 'human' or NULL — S2a's NULL=human). A
          // field with no prior op, or whose last op is import-authored, is
          // unprotected and writes freely.
          for (const [field, delta] of Object.entries(item.fields)) {
            const latest = latestOp(db, item.entity, item.entity_id, field)
            const isProtected = !!latest && latest.source !== 'import'
            if (isProtected) {
              // T73: a director may have resolved this stale field. 'accept'
              // bypasses the Policy-A gate and writes via commitUpdate — which
              // stamps source:'import' and parents on the live human op, exactly
              // S2b's stale_accept semantics, reached through commitPlan (the door
              // that fits a held import). 'keep' drops the FieldDelta entirely (no
              // op). No resolution → the field re-holds as a stale conflict.
              const res = resolutionFor(item.entity, item._name, field)
              if (res?.reason === 'stale' && res.choice === 'accept') {
                toUpdate.push({ item, field, delta, parent_op_id: latest.id })
              } else if (res?.reason === 'stale' && res.choice === 'keep') {
                // dropped — the director keeps their hand-edit, nothing written
              } else {
                conflicts.push(makeStaleConflict(item, field, delta, latest))
              }
            } else {
              toUpdate.push({ item, field, delta, parent_op_id: latest ? latest.id : null })
            }
          }
          break
        }
        case 'conflict':
          // buildPlan surfaces ambiguous_identity (§3); commitPlan itself may
          // produce a `stale` conflict (the update gate above). Both are gated
          // into `conflicts` (no op, no throw). cross_source (S7) and any other
          // reason cannot be produced yet — reaching one is a bug.
          if (item.reason === 'ambiguous_identity' || item.reason === 'stale') conflicts.push(item)
          else throw new Error(`commitPlan: conflict reason "${item.reason}" is not implemented at S1a`)
          break
        case 'clear':
          // S4. A raw source cannot express an explicit clear (a blank is
          // "preserve", never "remove") — reaching this arm now is a bug.
          throw new Error(`commitPlan: op "${item.op}" is not implemented at S1a`)
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
        const anchorId = randomUUID()
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
  })

  let held = false
  try {
    run()
  } catch (e) {
    if (e && e[HELD]) held = true // the transaction rolled back; nothing written
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
      fixedEvents: { created: 0, skipped: [], partial: [] },
    }
  }

  const outcome = {
    held: false,
    conflicts: [],
    created,
    total,
    updated,
    fixedEvents: { created: fixedCreated.length, skipped: fixedSkipped, partial: fixedPartial },
  }
  if (replaced) outcome.replaced = replaced
  return outcome
}
