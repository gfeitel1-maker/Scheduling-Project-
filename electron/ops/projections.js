export const PROJECTIONS = {
  camps: {
    table: 'camps',
    key: 'id',
    fields: ['name'],
    // Deliberate deviation from the generic ensureExists pattern used by
    // every other entity below: `camps` is a true singleton table, not a
    // collection. Every other entity's ensureExists is safe to
    // INSERT-OR-IGNORE with whatever id the caller supplies, because
    // multiple rows are legitimate there. For `camps`, blindly doing the
    // same with a caller-supplied entity_id could create a SECOND camps
    // row with an empty signing_secret — corrupting the single-camp
    // invariant every other subsystem (esp. getSigningSecret's
    // `SELECT signing_secret FROM camps LIMIT 1`) depends on, which would
    // silently break session-token verification camp-wide.
    //
    // So instead of inserting on mismatch, this looks up the one real
    // existing camp row and only proceeds if the caller's id matches it.
    // If there is no existing camp row, or the id doesn't match, it throws
    // rather than silently creating/corrupting a row — bootstrapCamp is the
    // only code path allowed to create the camps row in the first place.
    ensureExists: (db, id) => {
      const existing = db.prepare('SELECT id FROM camps LIMIT 1').get()
      if (!existing || existing.id !== id) {
        throw new Error(
          'camps.ensureExists: refusing to write — no existing camp row matches the given id (camps is a singleton table; use bootstrapCamp to create it)'
        )
      }
      // No-op in practice: the row already exists and matches. Kept as an
      // explicit branch (rather than removed) so the guard above stays the
      // single source of truth for "is this write allowed."
    },
  },
  users: {
    table: 'users',
    key: 'id',
    fields: ['camp_id', 'name', 'pin_hash', 'pin_salt', 'role'],
    ensureExists: (db, id) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, NULL, '', '', '', 'staff')"
        )
        .run(id),
  },
  cohorts: {
    table: 'cohorts',
    key: 'id',
    fields: [
      'camp_id',
      'name',
      'session_week_start',
      'session_week_end',
      'capacity_source',
      'anchor_model',
      'sort_order',
    ],
    ensureExists: (db, id) => {
      // MEDIUM (deferred per Sub-plan B Task 2 round 1 Red Hat review,
      // revisit in Task 3): a zero-camps db makes camp?.id resolve to null,
      // which is silently inserted rather than surfaced as an error.
      const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      db.prepare("INSERT OR IGNORE INTO cohorts (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  groups: {
    table: 'groups',
    key: 'id',
    fields: ['camp_id', 'name', 'tier_id', 'availability'],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts.ensureExists above.
      const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      db.prepare("INSERT OR IGNORE INTO groups (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  days_of_operation: {
    table: 'days_of_operation',
    key: 'id',
    fields: ['camp_id', 'label', 'day_of_week', 'sort_order'],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups.ensureExists above.
      const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      db.prepare("INSERT OR IGNORE INTO days_of_operation (id, camp_id, label) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  time_blocks: {
    table: 'time_blocks',
    key: 'id',
    fields: ['camp_id', 'cohort_id', 'name', 'start_time', 'end_time', 'part_of_day', 'sort_order'],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/days_of_operation.ensureExists above.
      const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      db.prepare("INSERT OR IGNORE INTO time_blocks (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  tiers: {
    table: 'tiers',
    key: 'id',
    fields: ['camp_id', 'cohort_id', 'name', 'sort_order'],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/days_of_operation/time_blocks.ensureExists above.
      const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      db.prepare("INSERT OR IGNORE INTO tiers (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  activities: {
    table: 'activities',
    key: 'id',
    // is_locked is deliberately excluded — ScheduleScreen.jsx (not migrated
    // until a later sub-plan) still writes activities.is_locked directly via
    // Supabase, against the now-separate Supabase `activities` table. That
    // is an intentional transition-window gap, not something this
    // projection should paper over by accepting writes it doesn't yet own.
    fields: [
      'camp_id',
      'name',
      'location',
      'is_outdoor',
      'max_groups_per_slot',
      'min_per_week',
      'max_per_week',
      'same_tier_only',
      'priority',
      'eligible_tier_ids',
      'eligible_group_ids',
      'prefer_before_day',
      'prefer_before_day_min',
      'weather_alternative_id',
      'notes',
      'span_blocks',
    ],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/days_of_operation/time_blocks/tiers.ensureExists above.
      const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      db.prepare("INSERT OR IGNORE INTO activities (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  anchor_activities: {
    table: 'anchor_activities',
    key: 'id',
    fields: ['camp_id', 'cohort_id', 'day_id', 'time_block_id', 'name', 'is_all_groups', 'group_ids', 'notes'],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/days_of_operation/time_blocks/tiers/activities.ensureExists above.
      const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      db.prepare("INSERT OR IGNORE INTO anchor_activities (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
}

// Reserved field name for a row-delete op — see DELETE_FIELD's definition in
// operations.js for why a delete is expressed as a sentinel field on the
// same appendOp path rather than a new primitive. Kept as a separate literal
// here (not imported) to avoid a projections.js -> operations.js import
// cycle, since operations.js already imports PROJECTIONS/applyProjection
// from this file.
const DELETE_FIELD = '__deleted__'

export function applyProjection(db, op) {
  const projection = PROJECTIONS[op.entity]
  if (!projection) return

  if (op.field === DELETE_FIELD) {
    db.prepare(`DELETE FROM ${projection.table} WHERE ${projection.key} = ?`).run(op.entity_id)
    return
  }

  if (!projection.fields.includes(op.field)) return

  projection.ensureExists?.(db, op.entity_id)

  db.prepare(`UPDATE ${projection.table} SET ${op.field} = ? WHERE ${projection.key} = ?`).run(
    op.value,
    op.entity_id
  )
}
