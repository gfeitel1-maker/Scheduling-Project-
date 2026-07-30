import { randomUUID } from 'node:crypto'
import { appendOp, DELETE_FIELD } from './operations.js'
import { nameFieldFor } from './restore.js'

// Deleting a setup record that a schedule uses.
// docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
//
// template_slots references groups(id) and activities(id) with no ON DELETE, so
// the projection's DELETE is refused for any record a schedule uses — which is
// exactly the record a director wants gone. This module clears what blocks the
// delete, in APPLICATION CODE, deliberately rather than by changing the foreign
// keys to cascade:
//
//   - A cascade fires inside the parent DELETE, so the count shown to the
//     director and the rows actually destroyed would be two independent
//     mechanisms rather than one row set (see the expected_slot_count contract
//     below).
//   - A cascade writes no ops for the children, so peers re-derive the child
//     effects from their own row set instead of replaying what happened here.
//     The op log is the replication mechanism; a delete whose effects are
//     absent from it is invisible to history, to Trash, and to every peer whose
//     rows differ from this device's.
//
// The `ON DELETE NO ACTION` on template_slots is therefore RETAINED, and after
// this module exists it means something useful: an FK violation on a parent
// delete now means the clearing step missed rows, i.e. a bug.
//
// HOST ONLY, following restore.js. A Client cannot express a multi-op atomic
// transaction over `submit_op`, and — unlike a restore — a Client's delete is
// never queued for later: a queued delete would execute against a count the
// director was shown hours earlier, which is precisely the drift the count
// contract forbids.

// Which entities this module deletes. Every other entity keeps the ordinary
// localClient.deleteEntity path; nothing else has slots pointing at it.
export const CLEARABLE_ENTITIES = Object.freeze(new Set(['groups', 'activities', 'days_of_operation']))

// Deleting a GROUP or a DAY removes rows that are somebody's week — a group's
// column, or a day's column across every group. Deleting an ACTIVITY only
// empties cells that stay where they are. Only the first class needs a version
// saved first, and only the first class may be blocked by unprotectable rows.
const DESTRUCTIVE = Object.freeze(new Set(['groups', 'days_of_operation']))

// ONE query per entity, shared by previewDelete and deleteRecord so the number
// the director was shown and the rows that get destroyed cannot drift apart
// under maintenance. Do not inline a second copy of any of these.
const SLOT_QUERY = Object.freeze({
  groups: 'SELECT id, template_id FROM template_slots WHERE group_id = ?',
  activities: 'SELECT id, template_id FROM template_slots WHERE activity_id = ?',
  days_of_operation: 'SELECT id, template_id FROM template_slots WHERE day_id = ?',
})

const NAME_QUERY = Object.freeze({
  groups: 'SELECT name FROM groups WHERE id = ?',
  activities: 'SELECT name FROM activities WHERE id = ?',
  days_of_operation: 'SELECT label FROM days_of_operation WHERE id = ?',
})

function slotRows(db, entity, entity_id) {
  return db.prepare(SLOT_QUERY[entity]).all(entity_id)
}

function recordName(db, entity, entity_id) {
  const row = db.prepare(NAME_QUERY[entity]).get(entity_id)
  return row ? (row[nameFieldFor(entity)] ?? null) : null
}

// Distinct template_ids among the rows that are about to change, resolved
// against schedule_templates. A template_id with no row is "unprotected": there
// is no route to snapshot it into (schedule_snapshots.template_id is a real FK)
// and no screen renders it, but the slots are real and the parent FK counts
// them. That is a pre-existing drift defect, not something to trample through.
function routesFor(db, rows) {
  const counts = new Map()
  for (const row of rows) counts.set(row.template_id, (counts.get(row.template_id) ?? 0) + 1)

  const routes = []
  let unprotected_count = 0
  for (const [template_id, count] of counts) {
    const template = db.prepare('SELECT id, kind FROM schedule_templates WHERE id = ?').get(template_id)
    if (!template) {
      unprotected_count += count
      continue
    }
    routes.push({ template_id, kind: template.kind, count })
  }
  return { routes, unprotected_count }
}

function anchorRows(db, day_id) {
  return db.prepare('SELECT id FROM anchor_activities WHERE day_id = ?').all(day_id)
}

function overlayRows(db, day_id) {
  return db.prepare('SELECT id FROM template_overlays WHERE day_id = ?').all(day_id)
}

// activities.weather_alternative_id self-references activities(id), so another
// activity naming this one as its rainy-day alternative blocks the delete too.
function weatherDependents(db, activity_id) {
  return db.prepare('SELECT id FROM activities WHERE weather_alternative_id = ?').all(activity_id)
}

// What the confirmation is built from. Read-only, but gated by the caller with
// the SAME permission as the delete — a preview enumerates schedule shape.
export function previewDelete(db, { entity, entity_id }) {
  if (!CLEARABLE_ENTITIES.has(entity)) return { error: 'not-clearable' }
  if (typeof entity_id !== 'string' || entity_id.length === 0) return { error: 'no-record' }

  const name = recordName(db, entity, entity_id)
  if (name === null && !db.prepare(`SELECT 1 FROM ${entity} WHERE id = ?`).get(entity_id)) {
    return { error: 'no-record' }
  }

  const rows = slotRows(db, entity, entity_id)
  const { routes, unprotected_count } = routesFor(db, rows)

  return {
    ok: true,
    entity,
    entity_id,
    name,
    destructive: DESTRUCTIVE.has(entity),
    slot_count: rows.length,
    routes,
    unprotected_count,
    anchor_count: entity === 'days_of_operation' ? anchorRows(db, entity_id).length : 0,
    overlay_count: entity === 'days_of_operation' ? overlayRows(db, entity_id).length : 0,
    weather_dependent_count: entity === 'activities' ? weatherDependents(db, entity_id).length : 0,
  }
}

// A version of one whole route, written the way ScheduleScreen's saveSnapshot
// writes one — same table, same ops, same is_auto category, so it appears in
// the Versions list the director already knows rather than a second concept.
//
// THE WHOLE ROUTE, not the deleted record's slice: restoreSnapshot bulk-replaces
// the entire template scope, so a partial payload would restore this record's
// week by deleting everyone else's.
//
// template_id MUST be written first — schedule_snapshots.ensureExists only
// inserts the row on that field, and any other field arriving first is a silent
// no-op against zero rows. That is how the "Empty" snapshots already in the dev
// camp were produced. Asserted by deleteRecord.test.js, not merely commented.
function writeRouteSnapshot(db, { template_id, name, author_user_id, device_id }) {
  const id = randomUUID()
  const slots = db
    .prepare(
      `SELECT group_id, day_id, time_block_id, activity_id, anchor_id, is_anchor, flags
         FROM template_slots WHERE template_id = ?`
    )
    .all(template_id)
    .map((s) => ({
      group_id: s.group_id,
      day_id: s.day_id,
      time_block_id: s.time_block_id,
      activity_id: s.activity_id,
      anchor_id: s.anchor_id,
      is_anchor: s.is_anchor,
      flags: s.flags ? JSON.parse(s.flags) : {},
    }))
  const overlays = db
    .prepare(
      `SELECT unit_id, day_id, from_block_order, to_block_order, label
         FROM template_overlays WHERE template_id = ?`
    )
    .all(template_id)

  const ops = []
  const push = (field, value) =>
    ops.push(appendOp(db, { entity: 'schedule_snapshots', entity_id: id, field, value, author_user_id, device_id }))

  push('template_id', template_id)
  push('name', name)
  push('is_auto', true)
  push('created_at', new Date().toISOString())
  push('slots', JSON.stringify(slots))
  push('overlays', JSON.stringify(overlays))

  // A write that returned without throwing is not evidence that a payload was
  // recorded. Re-read it before anything is destroyed.
  const saved = db.prepare('SELECT template_id, slots FROM schedule_snapshots WHERE id = ?').get(id)
  if (!saved || saved.template_id !== template_id || !saved.slots || saved.slots.length <= 2) {
    const err = new Error('snapshot-failed')
    err.code = 'SNAPSHOT_FAILED'
    throw err
  }

  return { id, template_id, slot_count: slots.length, ops }
}

// Deleting an ACTIVITY: the slots are grid positions that happen to hold it.
// Null the column and each cell reads as "not filled yet". The week keeps its
// shape, so no version is saved — this is the non-destructive case and must not
// be made to feel like the other one.
function clearActivityPlacements(db, rows, { author_user_id, device_id }) {
  return rows.map((row) =>
    appendOp(db, {
      entity: 'template_slots',
      entity_id: row.id,
      field: 'activity_id',
      value: null,
      author_user_id,
      device_id,
    })
  )
}

// Deleting a GROUP: the slots ARE the group's week, one row per day × block per
// route. There is nothing to empty; the column ceases to exist.
//
// Per-row delete ops rather than bulkReplace: bulkReplace would need the caller
// to hold the whole surviving row set, would reissue every other row's id, and
// its scope-level conflict detection would fire for any unrelated concurrent
// edit anywhere in the schedule.
function removeSlotRows(db, rows, { author_user_id, device_id }) {
  return rows.map((row) =>
    appendOp(db, {
      entity: 'template_slots',
      entity_id: row.id,
      field: DELETE_FIELD,
      value: 1,
      author_user_id,
      device_id,
    })
  )
}

// Deleting a DAY removes one column-day from every group's week, so it is in
// the same destructive class as a group. Its anchors and overlays block the
// delete through real FKs; its template_slots rows do NOT (day_id carries no
// FK) and today are silently orphaned instead. An orphan is not harmless — it
// is counted by latestScopeOpSeq, carried by bulkReplace, and rendered in a
// grid position that no longer exists — so it is deleted here too.
function removeDayFromWeek(db, { day_id, slots, author_user_id, device_id }) {
  const del = (entity, entity_id) =>
    appendOp(db, { entity, entity_id, field: DELETE_FIELD, value: 1, author_user_id, device_id })

  const ops = []
  for (const row of anchorRows(db, day_id)) ops.push(del('anchor_activities', row.id))
  for (const row of overlayRows(db, day_id)) ops.push(del('template_overlays', row.id))
  ops.push(...removeSlotRows(db, slots, { author_user_id, device_id }))
  return ops
}

// Delete a record a schedule uses, clearing what blocks it first.
//
// `expected_slot_count` is the number the director was shown. It is re-counted
// inside the transaction from the same query, and a mismatch ABORTS rather than
// proceeding — on a two-device camp a peer can add or move slots between the
// preview and the confirmation, and a count the director did not agree to is
// not a count.
//
// Order inside the one transaction is fixed and load-bearing:
//   snapshot → verify snapshot → clear children → delete parent
// The parent delete is LAST so it carries the highest seq and is broadcast last;
// a peer applying in order has already removed the children when it arrives, and
// its own foreign_keys = ON is satisfied. Appending the parent delete first
// would be silently correct here and silently broken on every peer.
//
// Returns { ok, ... } or { error }. The ops are returned rather than broadcast
// so the caller can broadcast after the transaction commits.
export function deleteRecord(db, { entity, entity_id, expected_slot_count, author_user_id, device_id }) {
  if (!CLEARABLE_ENTITIES.has(entity)) return { error: 'not-clearable' }
  if (typeof entity_id !== 'string' || entity_id.length === 0) return { error: 'no-record' }
  if (!db.prepare(`SELECT 1 FROM ${entity} WHERE id = ?`).get(entity_id)) return { error: 'no-record' }

  const name = recordName(db, entity, entity_id)
  const destructive = DESTRUCTIVE.has(entity)

  let outcome
  try {
    outcome = db.transaction(() => {
      const rows = slotRows(db, entity, entity_id)

      if (Number.isInteger(expected_slot_count) && rows.length !== expected_slot_count) {
        return { error: 'count-changed', slot_count: rows.length }
      }

      const { routes, unprotected_count } = routesFor(db, rows)
      if (destructive && unprotected_count > 0) {
        return { error: 'unprotected-slots', unprotected_count, slot_count: rows.length }
      }

      const snapshots = []
      if (destructive && rows.length > 0) {
        for (const route of routes) {
          snapshots.push(
            writeRouteSnapshot(db, {
              template_id: route.template_id,
              name: `Before ${name ?? 'a record'} was deleted`,
              author_user_id,
              device_id,
            })
          )
        }
      }

      const ops = []
      if (entity === 'activities') {
        for (const dependent of weatherDependents(db, entity_id)) {
          ops.push(
            appendOp(db, {
              entity: 'activities',
              entity_id: dependent.id,
              field: 'weather_alternative_id',
              value: null,
              author_user_id,
              device_id,
            })
          )
        }
        ops.push(...clearActivityPlacements(db, rows, { author_user_id, device_id }))
      } else if (entity === 'groups') {
        ops.push(...removeSlotRows(db, rows, { author_user_id, device_id }))
      } else {
        ops.push(...removeDayFromWeek(db, { day_id: entity_id, slots: rows, author_user_id, device_id }))
      }

      ops.push(
        appendOp(db, { entity, entity_id, field: DELETE_FIELD, value: 1, author_user_id, device_id })
      )

      return {
        ok: true,
        entity,
        entity_id,
        name,
        destructive,
        cleared: rows.length,
        routes,
        snapshots: snapshots.map(({ id, template_id, slot_count }) => ({ id, template_id, slot_count })),
        ops: [...snapshots.flatMap((s) => s.ops), ...ops],
      }
    })()
  } catch (err) {
    if (err.code === 'SNAPSHOT_FAILED') return { error: 'snapshot-failed' }
    throw err
  }

  return outcome
}
