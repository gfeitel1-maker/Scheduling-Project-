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
import { appendOp, DELETE_FIELD } from './operations.js'
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
export function replaceScope(db, { camp_id, author_user_id = null, device_id }) {
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
export function commitIngest(db, { approved, links, camp_id, cohort_id = null, author_user_id, device_id, fixedEvents = [], activityRules = {}, mode = 'add' }) {
  if (!approved || typeof approved !== 'object') throw new Error('ingest: nothing to commit')
  if (!camp_id) throw new Error('ingest: camp_id is required')

  for (const entity of Object.keys(approved)) {
    if (!INGESTIBLE_ENTITIES.includes(entity)) {
      throw new Error(`ingest: ${entity} cannot be created by an import`)
    }
  }

  // The PURE decision layer (ADR §1). buildPlan holds no DB handle and writes
  // nothing; `existing` is null so every approved name is a `create` — the
  // importer's blind-create path, where a same-name collision surfaces at the
  // UNIQUE constraint inside commitPlan's transaction exactly as before.
  const plan = buildPlan(
    { approved, links, activityRules, fixedEvents, camp_id, cohort_id, mode },
    null,
  )

  return commitPlan(db, plan, { author_user_id: author_user_id ?? null, device_id })
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
export function commitPlan(db, plan, { author_user_id = null, device_id }) {
  const camp_id = plan.camp_id
  const cohort_id = plan.cohort_id ?? null
  const mode = plan.mode ?? 'add'

  const created = {}
  for (const entity of INGESTIBLE_ENTITIES) created[entity] = 0
  let total = 0

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
      })
    }
    created[entity] += 1
    total += 1
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
      replaced = replaceScope(db, { camp_id, author_user_id, device_id })
    }
    seedNameMaps()

    // Plan items are emitted in INGESTIBLE_ENTITIES order, so tiers land before
    // groups (tier_id resolvable) and groups before activities (group ids
    // resolvable) — the same registration-before-use the pre-S0 loop relied on.
    for (const item of plan.items) {
      switch (item.op) {
        case 'create':
          commitCreate(item)
          break
        case 'unchanged':
          // Resolved to a live entity, nothing to write (type doc b).
          break
        case 'update':
        case 'clear':
        case 'conflict':
          // S1+. The type carries these arms; their merge/staleness/alias
          // semantics are built in later slices. Reaching one at S0 is a bug.
          throw new Error(`commitPlan: op "${item.op}" is not implemented at S0`)
        default:
          throw new Error(`commitPlan: unknown op "${item.op}"`)
      }
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
          })
        }
        fixedCreated.push(anchorId)
      }
    }
  })

  run()
  const outcome = { created, total, fixedEvents: { created: fixedCreated.length, skipped: fixedSkipped, partial: fixedPartial } }
  if (replaced) outcome.replaced = replaced
  return outcome
}
