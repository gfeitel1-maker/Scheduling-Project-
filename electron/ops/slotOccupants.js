import { appendOp } from './operations.js'

// What happens to a `template_slots` row when the entity it points at is
// permanently deleted.
//
// A slot is a grid cell. Some of its columns say WHERE the cell is (group,
// day, time block — deleting one of those destroys the cell's position, so the
// row itself goes), and some say WHAT is in it (activity, anchor, elective
// set, event — deleting one of those empties the cell but the cell stays).
// Before this registry existed, each of those decisions was made once per
// delete path, in a different file, in hand-copied code; adding a fourth
// occupant kind silently required remembering to write another copy.
//
// Three policies, and every column must pick one:
//
//   'clear'       null the field on every referencing row, one per-field op
//                 each, via clearSlotOccupant below. The cell survives and
//                 reads as empty.
//   'delete-row'  the referencing template_slots row is deleted outright,
//                 because the cell's position no longer exists.
//   'dangle'      nothing is written. The reference is resolved by id at read
//                 time, so a dangling id renders as nothing — which is the
//                 intended behavior, not an oversight.
//
// slotOccupantCascadeParity.test.js scans a migrated db and fails if a
// template_slots reference column is missing from this table, and fails if a
// 'clear' entry names a module that does not actually call clearSlotOccupant
// for that field.
export const SLOT_OCCUPANT_CASCADES = Object.freeze({
  activity_id: Object.freeze({
    policy: 'clear',
    deletedEntity: 'activities',
    implementedIn: 'deleteRecord.js',
    reason:
      'The slots are grid positions that happen to hold this activity. Null the column and each cell reads as "not filled yet"; the week keeps its shape, so this is the non-destructive case and no version is saved.',
  }),
  event_id: Object.freeze({
    policy: 'clear',
    deletedEntity: 'events',
    implementedIn: 'deleteEvent.js',
    reason:
      'A dangling event_id renders "Event (removed)" rather than an empty cell, so unlike elective_set_id it must be actively cleared (docs/adr/2026-08-22-events-overlay-placement.md).',
  }),
  group_id: Object.freeze({
    policy: 'delete-row',
    deletedEntity: 'groups',
    implementedIn: 'deleteRecord.js',
    reason:
      'The slots ARE the deleted group’s week, one row per day × block per route. There is nothing to empty; the column ceases to exist, so the rows are deleted.',
  }),
  day_id: Object.freeze({
    policy: 'delete-row',
    deletedEntity: 'days_of_operation',
    implementedIn: 'deleteRecord.js',
    reason:
      'Deleting a day removes one column-day from every group’s week, the same destructive class as a group. day_id carries no FK, so without this the rows would be silently orphaned but still counted and rendered.',
  }),
  time_block_id: Object.freeze({
    policy: 'dangle',
    deletedEntity: 'time_blocks',
    implementedIn: null,
    reason:
      'Time blocks have no deleteRecord branch at all (CLEARABLE_ENTITIES in deleteRecord.js covers groups/activities/days/locations only). No delete path exists to cascade from; if one is ever added this entry must be revisited.',
  }),
  anchor_id: Object.freeze({
    policy: 'dangle',
    deletedEntity: 'anchor_activities',
    implementedIn: null,
    reason:
      'Two delete paths, neither of which can leave a live dangling anchor_id. U2 undo refuses the delete outright while a template_slots row still points at the anchor (undoReferences.js registers template_slots.anchor_id). deleteRecord.js’s day branch deletes a day’s anchors and that same day’s template_slots rows in one transaction, so the pointing rows go with them.',
  }),
  elective_set_id: Object.freeze({
    policy: 'dangle',
    deletedEntity: 'elective_sets',
    implementedIn: null,
    reason:
      'DELIBERATE ASYMMETRY, do not "fix": docs/work/specs/2026-08-20-group-electives-design.md says template_slots pointing at a deleted set "render empty (soft, like any deleted reference)". Render resolves elective_set_id by id at read time, so a dangling id renders nothing and no cascade write is correct.',
  }),
})

// template_slots reference columns that are structure, not an occupant, and so
// are outside this registry's remit.
export const SLOT_OCCUPANT_STRUCTURAL_COLUMNS = Object.freeze(
  new Set([
    // Points at schedule_templates — the slot's own parent. A template is
    // never deleted out from under its slots; deleting the route deletes them
    // together, which is bulkReplace/deleteWeek territory, not a cascade.
    'template_id',
  ])
)

// Clear one occupant field to null on every template_slots row that references
// `entityId`, recording one per-field op per row so the change replicates and
// is auditable. Returns the ops for the caller to broadcast after commit;
// callers run this inside their own transaction.
//
// `rows` is optional: a caller that already read the affected rows (to count
// them, to snapshot their routes) passes them so the rows it showed the
// director and the rows it changes cannot drift apart within one transaction.
// Omit it and the rows are read here.
export function clearSlotOccupant(db, { field, entityId, rows, author_user_id, device_id } = {}) {
  const entry = SLOT_OCCUPANT_CASCADES[field]
  if (!entry) throw new Error(`clearSlotOccupant: '${field}' is not a declared slot occupant`)
  if (entry.policy !== 'clear') {
    throw new Error(`clearSlotOccupant: '${field}' policy is '${entry.policy}', not 'clear'`)
  }

  const affected =
    rows ?? db.prepare(`SELECT id FROM template_slots WHERE ${field} = ?`).all(entityId)

  return affected.map((row) =>
    appendOp(db, {
      entity: 'template_slots',
      entity_id: row.id,
      field,
      value: null,
      author_user_id,
      device_id,
    })
  )
}
