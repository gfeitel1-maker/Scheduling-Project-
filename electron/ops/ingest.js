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

const DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

// "08:40–09:00" / "9:15-9:40" -> { start_time, end_time }. Returns nulls when
// the label is not a range, which is normal — a period may be named "Block 2".
function parseTimeRange(label) {
  const match = String(label ?? '').match(/(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/)
  if (!match) return { start_time: null, end_time: null }
  const pad = (h, m) => `${String(h).padStart(2, '0')}:${m}`
  return { start_time: pad(match[1], match[2]), end_time: pad(match[3], match[4]) }
}

// The fields each entity needs beyond its name, derived rather than guessed.
// A director approved a list of names; they did not approve a day-of-week
// number, so it is computed from the name and nothing else is invented.
//
// `cohortId` is the Program the director is importing into. Units and time
// blocks are scoped to a Program in this app — the Units and Time Blocks
// screens only show rows whose `cohort_id` matches the active Program
// (TiersScreen/TimeBlocksScreen), so an import that left it null created rows
// that existed but were invisible, and a unit the director could not see could
// not appear tied to its groups (T33). A null `cohortId` is skipped by the
// op-writer below, preserving the pre-T33 behaviour for callers that pass none.
// Groups, activities and days are camp-scoped in the UI, so they take no
// cohort_id — matching how GroupsScreen/ActivitiesScreen/DaysScreen create them.
function fieldsFor(entity, name, campId, index, cohortId) {
  switch (entity) {
    case 'cohorts':
      return { camp_id: campId, name }
    case 'tiers':
      return { camp_id: campId, name, sort_order: index, cohort_id: cohortId }
    case 'groups':
      return { camp_id: campId, name, availability: 'all' }
    case 'days_of_operation': {
      const dow = DAY_INDEX[String(name).trim().toLowerCase()]
      return {
        camp_id: campId,
        label: name,
        day_of_week: dow ?? index,
        sort_order: dow ?? index,
      }
    }
    case 'time_blocks': {
      const { start_time, end_time } = parseTimeRange(name)
      return { camp_id: campId, name, start_time, end_time, sort_order: index, cohort_id: cohortId }
    }
    case 'activities':
      return { camp_id: campId, name }
    default:
      // Unreachable — commitIngest rejects before this point. Kept as a second
      // gate so a future caller cannot slip past by adding a case above.
      throw new Error(`ingest: ${entity} is not an ingestible entity`)
  }
}

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
 * Create the approved records, all together or not at all.
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
 * anchors are writable only through the validated branch below. Each ticked
 * event fans out to one `anchor_activities` row per resolved day, cohort-scoped,
 * mirroring the Fixed Events screen's create shape.
 *
 * `activityRules` is a dedicated payload (T35), NOT a key in `approved`, keyed
 * by activity name -> `{ eligible_group_names, min_per_week, max_per_week,
 * priority }`. Rules travel as group NAMES for the same reason fixed events
 * do — proposed groups have no IDs until this transaction mints them — and
 * are resolved against `groupIdByName` right here, after that map is fully
 * populated by the entity loop's `groups` pass (INGESTIBLE_ENTITIES runs
 * `groups` before `activities`). A name that does not resolve (the director
 * unticked that group) is dropped; if none resolve, no `eligible_group_ids`
 * is written at all (null = all groups), never `'[]'`.
 *
 * Returns `{ created: { [entity]: count }, total,
 *            fixedEvents: { created: number, skipped: [{ name, reason }] } }`.
 */
export function commitIngest(db, { approved, links, camp_id, cohort_id = null, author_user_id, device_id, fixedEvents = [], activityRules = {}, mode = 'add' }) {
  if (!approved || typeof approved !== 'object') throw new Error('ingest: nothing to commit')
  if (!camp_id) throw new Error('ingest: camp_id is required')

  for (const entity of Object.keys(approved)) {
    if (!INGESTIBLE_ENTITIES.includes(entity)) {
      throw new Error(`ingest: ${entity} cannot be created by an import`)
    }
  }

  const created = {}
  let total = 0

  // Unit name -> tier id, so a group created in this same transaction can be
  // filed under a unit created moments earlier. Seeded with the units the camp
  // already has, because a second import must reuse them rather than making a
  // duplicate the director then has to merge by hand.
  //
  // Seeded only from units in the SAME Program we are importing into: a "Rimon"
  // in another Program is a different unit, and reusing it would file this
  // import's bunks under a unit the director cannot see here (T33). When no
  // cohort is given (older callers), every existing unit is null-cohort too, so
  // the match still holds and behaviour is unchanged.
  const tierIdByName = new Map()
  const groupUnits = links?.groups ?? {}

  // Fixed events resolve their block/day/groups BY NAME against rows that exist
  // in scope OR are created this run. Seed from existing rows first — a block
  // that was a skipped duplicate (not created this run) still has to resolve to
  // the row already in the camp — then extend as the entity loop creates rows.
  //
  // time_blocks are Program-scoped (seed only this Program's, matching
  // tierIdByName's cohort filter); days and groups are camp-scoped.
  const blockIdByName = new Map()
  const dayIdByName = new Map()
  const groupIdByName = new Map()

  // Populated INSIDE the transaction, after any teardown: in replace mode the
  // rows these maps would name are about to be destroyed, and seeding first
  // would file a new bunk under a unit that no longer exists. In add mode
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
  // Surfaced in the result, never silent (ADR §1): a fixed event whose block,
  // day, or groups the director did not import is skipped, not fatal (§5.3).
  const fixedSkipped = []
  // A fixed event that resolves only PARTIALLY — some of its days or groups
  // were not imported, but at least one of each was — is written for what
  // resolved AND its shortfall is reported. Writing the subset is correct (an
  // un-imported day has no anchor), but claiming full creation would be the
  // silent omission ADR §1 forbids, so the dropped days/groups are surfaced.
  const fixedPartial = []
  // Absent in add mode — there is nothing to report having destroyed.
  let replaced = null

  // One transaction for the whole import. Any throw below — a constraint, a
  // bad field, a disk error — rolls back every op and every projected row
  // together, so the camp is either fully imported or untouched.
  const run = db.transaction(() => {
    // T61. Anything that is not the literal 'replace' is an add, so every
    // pre-T61 caller keeps working untouched. This runs FIRST and inside the
    // existing transaction — better-sqlite3 nests as savepoints, so the one
    // outer transaction stays the rollback boundary for teardown and create
    // alike. Deletes precede creates, which is also what lets the new records
    // reuse the old names against UNIQUE(camp_id, name).
    if (mode === 'replace') {
      replaced = replaceScope(db, { camp_id, author_user_id, device_id })
    }
    seedNameMaps()

    for (const entity of INGESTIBLE_ENTITIES) {
      const names = Array.isArray(approved[entity]) ? approved[entity] : []
      created[entity] = 0
      names.forEach((rawName, index) => {
        const name = String(rawName ?? '').trim()
        if (!name) return
        const entityId = randomUUID()
        const fields = fieldsFor(entity, name, camp_id, index, cohort_id)

        if (entity === 'tiers') tierIdByName.set(name.toLowerCase(), entityId)
        // Extend the fixed-event resolution maps as their target rows are born.
        if (entity === 'time_blocks') blockIdByName.set(normalizeName(name), entityId)
        if (entity === 'days_of_operation') dayIdByName.set(normalizeName(name), entityId)
        if (entity === 'groups') groupIdByName.set(normalizeName(name), entityId)
        if (entity === 'groups') {
          // The file said which unit this bunk is in; file it there rather
          // than leaving the director to assign 33 bunks by hand.
          const unit = groupUnits[name]
          const tierId = unit ? tierIdByName.get(String(unit).trim().toLowerCase()) : null
          if (tierId) fields.tier_id = tierId
        }
        if (entity === 'activities') {
          // Inferred (or director-edited) rules, keyed by the exact activity
          // name the director approved. Absent = no rule was proposed/kept for
          // this activity, so nothing is written — same as pre-T35 behaviour.
          //
          // The op log is the boundary that owns validation here (round 2
          // review, Fix 4) — a caller is never trusted to have sent something
          // the engine can act on. buildSchedule.js's runRound only ever
          // matches priority === 'high' or 'low'; anything else is silently
          // unplaceable forever with no error, so a non-'high'/'low' value is
          // dropped rather than written. Same reasoning for min/max: a
          // negative or non-integer count is nonsense the UI should never
          // produce, but the write boundary does not trust that it never will.
          const rule = activityRules?.[name]
          if (rule) {
            if (Number.isInteger(rule.min_per_week) && rule.min_per_week >= 1) fields.min_per_week = rule.min_per_week
            if (Number.isInteger(rule.max_per_week) && rule.max_per_week >= 1) fields.max_per_week = rule.max_per_week
            if (rule.priority === 'high' || rule.priority === 'low') fields.priority = rule.priority
            const groupIds = Array.isArray(rule.eligible_group_names)
              ? rule.eligible_group_names
                  .map((n) => groupIdByName.get(normalizeName(n)))
                  .filter(Boolean)
              : []
            // Names that failed to resolve (the director unticked that group)
            // are dropped. If NONE resolved, write nothing rather than '[]' —
            // an empty JSON array reads as "restricted to nothing", not "all
            // groups" (src/utils/normalizeActivityEligibility.js).
            if (groupIds.length > 0) fields.eligible_group_ids = JSON.stringify(groupIds)
            // T61. An activity somebody is eligible for, asked for zero times
            // a week, is scheduled zero times — correct and silently useless.
            // Observed as every Friday slot UNFILLABLE after an import. Data
            // normalization, not a scheduler rule, and applied on both import
            // paths so the invariant holds however the camp was set up.
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
      })
    }

    // Fixed events, after the entity loop and INSIDE the same transaction, so
    // the whole import stays one atomic unit (ADR §4). anchor_activities is
    // written here and nowhere else in ingest; the generic whitelist above
    // never lets it through.
    for (const fe of Array.isArray(fixedEvents) ? fixedEvents : []) {
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
      // what resolved (the un-imported ones legitimately have no anchor) but
      // report the shortfall, or the result would silently claim more than it
      // created (ADR §1; Red Hat round-1).
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
