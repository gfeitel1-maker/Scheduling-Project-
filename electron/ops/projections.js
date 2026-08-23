import { getStmt } from './stmtCache.js'

// Shared ensureExists for the week_*_exclusions join tables. Each is
// (id, week_id, <second>) where BOTH week_id AND the second column are NOT NULL
// with no default (schema.sql). week_activity_exclusions.activity_id and
// week_group_exclusions.group_id are additionally real FKs.
//
// The op-log is field-level: appendOp carries ONE field per op, so ensureExists
// only ever sees a single field/value. Seeding just week_id (the old behavior)
// left the second NOT NULL column unset, so the INSERT OR IGNORE tripped its
// constraint and was SILENTLY dropped — SQLite's IGNORE resolution absorbs a
// NOT NULL violation exactly like a UNIQUE/PK one. The row was never created,
// and the following field UPDATE matched zero rows. Net effect: toggling a week
// exclusion ON persisted nothing, invisibly (see projections.test.js).
//
// A placeholder can't rescue this the way it does for a single-NOT-NULL parent
// table (day_override_template_slots etc.): the FK columns point at real tables,
// so '' or NULL both violate the constraint. Instead, reconstruct BOTH values
// and insert the complete row only once both are known. The current op supplies
// one field directly; the sibling is read back from the operations log, where
// appendOp has already durably inserted it — appendOp writes the op row BEFORE
// calling applyProjection, and replay (syncClient.applyRemoteOp) does the same
// in seq order, so the earlier field's op is always present by the time the
// later field's op projects, on both the writing device and every replica.
// Whichever field arrives SECOND creates the row; the first is a deliberate
// no-op. Order-independent and replay-safe, with no new IPC/op primitive.
//
// (week_location_exclusions, the third instance of this pattern, now also uses
// this helper as of slice M5, which added its writer.)
function ensureWeekJoinRow(table, secondColumn) {
  return (db, id, field, value) => {
    const readField = (wanted) => {
      if (field === wanted) return value
      const prior = getStmt(
        db,
        'SELECT value FROM operations WHERE entity = ? AND entity_id = ? AND field = ? ORDER BY seq DESC LIMIT 1'
      ).get(table, id, wanted)
      return prior ? prior.value : null
    }
    const weekId = readField('week_id')
    const secondValue = readField(secondColumn)
    // Both NOT NULL columns must be present; until then the row cannot exist.
    if (weekId == null || secondValue == null) return
    // T89: week_id is a real FK to schedule_weeks(id). Under an out-of-order
    // replay (this exclusion op outrunning the week-level op that would have
    // created schedule_weeks locally), that parent row may not exist yet —
    // the INSERT below would throw SQLITE_CONSTRAINT_FOREIGNKEY, which the
    // generic catch in syncClient.js swallows, leaving the op marked applied
    // while the exclusion silently never materializes. Stub-seed the parent
    // first, mirroring T85's devices-row seeding: minimal valid shape
    // (matches PROJECTIONS.schedule_weeks.ensureExists exactly), INSERT OR
    // IGNORE so a real row already present (or arriving later) is never
    // overwritten. A later real schedule_weeks op fills in the real fields.
    const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
    getStmt(
      db,
      "INSERT OR IGNORE INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, '', 0, 0)"
    ).run(weekId, camp?.id ?? null)
    getStmt(
      db,
      `INSERT OR IGNORE INTO ${table} (id, week_id, ${secondColumn}) VALUES (?, ?, ?)`
    ).run(id, weekId, secondValue)
  }
}

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
      const existing = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
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
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO cohorts (id, camp_id, name) VALUES (?, ?, '')").run(
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
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO groups (id, camp_id, name) VALUES (?, ?, '')").run(
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
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO days_of_operation (id, camp_id, label) VALUES (?, ?, '')").run(
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
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO time_blocks (id, camp_id, name) VALUES (?, ?, '')").run(
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
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO tiers (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  activities: {
    table: 'activities',
    key: 'id',
    fields: [
      'camp_id',
      'name',
      'location',
      'is_outdoor',
      'is_locked',
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
      // v32: FK-by-convention to locations(id). `location` (the frozen
      // free-text string) stays above for op-log replay + rollback (D5);
      // location_id is the live binding. Written by the migration as a side
      // effect (no op) and by restore re-resolution (INV-2); the UI switches to
      // it at M3.
      'location_id',
    ],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/days_of_operation/time_blocks/tiers.ensureExists above.
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO activities (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  // Camp locations, first-classed in schema v32
  // (docs/adr/2026-08-15-camp-locations-entity.md). Ordinary camp-scoped
  // replicated entity, same shape as groups/tiers — direct-camp-scoped, so it
  // also belongs in DIRECT_CAMP_ENTITIES. NOT host-local (any authorized device
  // may edit it). map_geometry is a nullable JSON field reserved for the M6 map.
  locations: {
    table: 'locations',
    key: 'id',
    fields: ['camp_id', 'name', 'capacity', 'notes', 'sort_order', 'map_geometry'],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/etc.ensureExists above.
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO locations (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  // Per-week location availability (v32). Third instance of the two-NOT-NULL
  // week_*_exclusions pattern (week_id + location_id, both NOT NULL). Adopts the
  // shared ensureWeekJoinRow helper the sibling activity/group tables use — it
  // reconstructs both fields from the op-log and inserts the complete row once
  // both are known, so it is order-independent and needs no placeholder. (An
  // earlier M5 draft seeded location_id='' — safe only because this column has
  // no FK — but the shared helper is strictly better: no '' orphan is reachable
  // even if location_id's op ever precedes week_id's.)
  week_location_exclusions: {
    table: 'week_location_exclusions',
    key: 'id',
    fields: ['week_id', 'location_id'],
    ensureExists: ensureWeekJoinRow('week_location_exclusions', 'location_id'),
  },
  // Camp map background image (M6, schema v33,
  // docs/adr/2026-08-16-locations-optional-map.md D1). A camp-scoped
  // singleton — id = camp_id, not a minted uuid — so ensureExists always
  // targets the one row a camp can ever have. image_data is size-capped by
  // MAX_FIELD_VALUE_LENGTH in operations.js (D2), enforced in appendOp
  // itself, before this projection ever runs.
  camp_maps: {
    table: 'camp_maps',
    key: 'id',
    fields: ['camp_id', 'image_data', 'image_mime', 'image_width', 'image_height'],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/etc.ensureExists above.
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, 'INSERT OR IGNORE INTO camp_maps (id, camp_id) VALUES (?, ?)').run(id, camp?.id ?? null)
    },
  },
  anchor_activities: {
    table: 'anchor_activities',
    key: 'id',
    fields: [
      'camp_id', 'cohort_id', 'day_id', 'time_block_id', 'name', 'is_all_groups', 'group_ids', 'notes',
      'schedule_week_id', 'recurrence_level',
    ],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/days_of_operation/time_blocks/tiers/activities.ensureExists above.
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO anchor_activities (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  day_override_templates: {
    table: 'day_override_templates',
    key: 'id',
    fields: ['camp_id', 'cohort_id', 'name', 'frequency_mode'],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/days_of_operation/time_blocks/tiers/activities/anchor_activities.ensureExists above.
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO day_override_templates (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  day_override_template_slots: {
    table: 'day_override_template_slots',
    key: 'id',
    fields: ['day_override_template_id', 'time_block_id', 'activity_id'],
    // Parent-scoped, no camp_id column (same shape as template_overlays/
    // schedule_snapshots) — ensureExists must not look up `camps` at all.
    // day_override_template_id is NOT NULL with no default (a real FK, no
    // a uniqueness convention like other entities' name-first pattern), so
    // this row can only be created once its parent link is known. The
    // caller (DayOverridesScreen) is required to write day_override_template_id
    // FIRST for every new slot row; if some other field arrived first the
    // row doesn't exist yet and this INSERT is skipped, so the subsequen
    // UPDATE becomes a harmless no-op rather than a constraint violation —
    // consistent with every other entity's ensureExists being a best-effor
    // "make the row exist" step, not a full validator.
    ensureExists: (db, id, field, value) => {
      if (field !== 'day_override_template_id') return
      getStmt(db,
        'INSERT OR IGNORE INTO day_override_template_slots (id, day_override_template_id) VALUES (?, ?)'
      ).run(id, value)
    },
  },
  // Special days (T40 slice 1, data shape only,
  // docs/work/specs/2026-08-20-special-days-data-shape-design.md). Camp-scoped
  // parent, same ensureExists shape as day_override_templates above.
  special_days: {
    table: 'special_days',
    key: 'id',
    fields: ['camp_id', 'name', 'sort_order', 'notes'],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/day_override_templates/etc.ensureExists above.
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO special_days (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  // Parent-scoped by special_day_id, no camp_id column — same shape as
  // day_override_template_slots above. name and sort_order are NOT NULL with
  // no default (schema.sql), so the placeholder insert must supply both
  // (mirroring the schedule_weeks stub in ensureWeekJoinRow below), not just
  // the id/parent pair.
  special_day_time_blocks: {
    table: 'special_day_time_blocks',
    key: 'id',
    fields: ['special_day_id', 'name', 'sort_order', 'start_time', 'end_time'],
    ensureExists: (db, id, field, value) => {
      if (field !== 'special_day_id') return
      getStmt(db,
        "INSERT OR IGNORE INTO special_day_time_blocks (id, special_day_id, name, sort_order) VALUES (?, ?, '', 0)"
      ).run(id, value)
    },
  },
  // Parent-scoped by special_day_id (no camp_id column), the grid cells. THREE
  // NOT NULL columns (special_day_id, group_id, time_block_id) — a stricter
  // version of the week_*_exclusions TWO-NOT-NULL join-row problem below:
  // seeding only special_day_id would leave group_id/time_block_id unset and
  // the INSERT would be silently dropped by IGNORE. Reconstruct all three from
  // the op-log (appendOp already durably wrote each field's op before this
  // projects, in seq order on both the writer and every replica, per
  // ensureWeekJoinRow's reasoning below) and insert the complete row only once
  // all three are known — whichever field arrives LAST creates the row.
  // special_day_id is stub-seeded defensively (mirrors the schedule_weeks stub
  // in ensureWeekJoinRow) since it is a real FK; group_id/time_block_id are
  // deliberately NOT stub-seeded, matching ensureWeekJoinRow's treatment of
  // its own second column.
  special_day_slots: {
    table: 'special_day_slots',
    key: 'id',
    fields: ['special_day_id', 'group_id', 'time_block_id', 'activity_id', 'location_id'],
    ensureExists: (db, id, field, value) => {
      const table = 'special_day_slots'
      const readField = (wanted) => {
        if (field === wanted) return value
        const prior = getStmt(
          db,
          'SELECT value FROM operations WHERE entity = ? AND entity_id = ? AND field = ? ORDER BY seq DESC LIMIT 1'
        ).get(table, id, wanted)
        return prior ? prior.value : null
      }
      const specialDayId = readField('special_day_id')
      const groupId = readField('group_id')
      const timeBlockId = readField('time_block_id')
      if (specialDayId == null || groupId == null || timeBlockId == null) return

      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(
        db,
        "INSERT OR IGNORE INTO special_days (id, camp_id, name) VALUES (?, ?, '')"
      ).run(specialDayId, camp?.id ?? null)
      getStmt(
        db,
        'INSERT OR IGNORE INTO special_day_slots (id, special_day_id, group_id, time_block_id) VALUES (?, ?, ?, ?)'
      ).run(id, specialDayId, groupId, timeBlockId)
    },
  },
  // Group-level electives (T41 slice 1, data shape + engine-skip only,
  // docs/work/specs/2026-08-20-group-electives-design.md). Camp-scoped
  // parent, same ensureExists shape as special_days/day_override_templates
  // above.
  elective_sets: {
    table: 'elective_sets',
    key: 'id',
    // is_reusable (v36, T110, docs/adr/2026-08-20-electives-authoring.md D2):
    // the durability marker, director-editable via the management screen's
    // "keep this for next time" gesture — a renderer write like camp_id/
    // name/sort_order, so it belongs in this allowlist (not
    // PROJECTION_FIELD_EXCEPTIONS, which is only for server/migration-only
    // columns).
    fields: ['camp_id', 'name', 'sort_order', 'is_reusable'],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/special_days/etc.ensureExists above.
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO elective_sets (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  // Parent-scoped by elective_set_id, no camp_id column — the join row for one
  // member activity option. TWO NOT NULL columns (elective_set_id,
  // activity_id), so this needs the same reconstruct-both-then-insert-once
  // treatment as ensureWeekJoinRow (elective_set_id is a real FK, so it is
  // additionally stub-seeded — mirrors the schedule_weeks stub there).
  elective_set_activities: {
    table: 'elective_set_activities',
    key: 'id',
    // camper_headcount (v39, Electives Slice 1): a normal renderer write like
    // elective_set_id/activity_id, applied generically via the UPDATE below —
    // no ensureExists involvement, since the row must already exist (created
    // by the elective_set_id/activity_id pair) before capacity is editable.
    fields: ['elective_set_id', 'activity_id', 'camper_headcount'],
    ensureExists: (db, id, field, value) => {
      const table = 'elective_set_activities'
      const readField = (wanted) => {
        if (field === wanted) return value
        const prior = getStmt(
          db,
          'SELECT value FROM operations WHERE entity = ? AND entity_id = ? AND field = ? ORDER BY seq DESC LIMIT 1'
        ).get(table, id, wanted)
        return prior ? prior.value : null
      }
      const electiveSetId = readField('elective_set_id')
      const activityId = readField('activity_id')
      if (electiveSetId == null || activityId == null) return

      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(
        db,
        "INSERT OR IGNORE INTO elective_sets (id, camp_id, name) VALUES (?, ?, '')"
      ).run(electiveSetId, camp?.id ?? null)
      getStmt(
        db,
        'INSERT OR IGNORE INTO elective_set_activities (id, elective_set_id, activity_id) VALUES (?, ?, ?)'
      ).run(id, electiveSetId, activityId)
    },
  },
  // events (Events overlay placement Slice 1, docs/adr/2026-08-22-events-
  // overlay-placement.md). Camp-scoped parent, same ensureExists shape as
  // elective_sets/special_days above.
  events: {
    table: 'events',
    key: 'id',
    fields: ['camp_id', 'name', 'sort_order', 'notes'],
    ensureExists: (db, id) => {
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO events (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  // Events internal sub-schedule Slice 2 (docs/adr/2026-08-22-event-
  // internal-subschedule.md). Parent-scoped by event_id, no camp_id column —
  // same shape as special_day_time_blocks above. name and sort_order are NOT
  // NULL with no default, so the placeholder insert must supply both.
  event_time_blocks: {
    table: 'event_time_blocks',
    key: 'id',
    fields: ['event_id', 'name', 'sort_order', 'start_time', 'end_time'],
    ensureExists: (db, id, field, value) => {
      if (field !== 'event_id') return
      getStmt(db,
        "INSERT OR IGNORE INTO event_time_blocks (id, event_id, name, sort_order) VALUES (?, ?, '', 0)"
      ).run(id, value)
    },
  },
  // event_groups — the grid's COLUMNS (docs/adr/2026-08-22-event-internal-
  // subschedule.md §1), structurally identical to event_time_blocks: a
  // second parent-scoped child of events, not a child of event_time_blocks.
  event_groups: {
    table: 'event_groups',
    key: 'id',
    fields: ['event_id', 'name', 'sort_order'],
    ensureExists: (db, id, field, value) => {
      if (field !== 'event_id') return
      getStmt(db,
        "INSERT OR IGNORE INTO event_groups (id, event_id, name, sort_order) VALUES (?, ?, '', 0)"
      ).run(id, value)
    },
  },
  // Parent-scoped by event_id (no camp_id column), the grid cells. THREE NOT
  // NULL columns (event_id, event_group_id, time_block_id) — same
  // reconstruct-then-insert-once shape as special_day_slots above, with
  // event_group_id replacing group_id as the second required column (it
  // references this event's OWN event_groups, never the camp's groups).
  event_slots: {
    table: 'event_slots',
    key: 'id',
    fields: ['event_id', 'event_group_id', 'time_block_id', 'activity_id', 'location_id'],
    ensureExists: (db, id, field, value) => {
      const table = 'event_slots'
      const readField = (wanted) => {
        if (field === wanted) return value
        const prior = getStmt(
          db,
          'SELECT value FROM operations WHERE entity = ? AND entity_id = ? AND field = ? ORDER BY seq DESC LIMIT 1'
        ).get(table, id, wanted)
        return prior ? prior.value : null
      }
      const eventId = readField('event_id')
      const eventGroupId = readField('event_group_id')
      const timeBlockId = readField('time_block_id')
      if (eventId == null || eventGroupId == null || timeBlockId == null) return

      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(
        db,
        "INSERT OR IGNORE INTO events (id, camp_id, name) VALUES (?, ?, '')"
      ).run(eventId, camp?.id ?? null)
      getStmt(
        db,
        'INSERT OR IGNORE INTO event_slots (id, event_id, event_group_id, time_block_id) VALUES (?, ?, ?, ?)'
      ).run(id, eventId, eventGroupId, timeBlockId)
    },
  },
  // day_overrides (T108, ADR 2026-08-21-day-overrides-repoint-shape.md D1).
  // Direct-camp-scoped (camp_id NOT NULL, like special_days), but with FOUR
  // additional NOT NULL foreign keys (schedule_week_id, day_id, group_id,
  // time_block_id) — the same accumulate-then-insert-once shape as
  // elective_set_activities/special_day_slots above, extended to four fields
  // instead of two. camp_id is derived from `camps LIMIT 1` like every other
  // direct-camp entity's ensureExists, not read from the op stream.
  day_overrides: {
    table: 'day_overrides',
    key: 'id',
    fields: ['camp_id', 'schedule_week_id', 'day_id', 'group_id', 'time_block_id', 'activity_id', 'kind', 'note'],
    ensureExists: (db, id, field, value) => {
      const table = 'day_overrides'
      const readField = (wanted) => {
        if (field === wanted) return value
        const prior = getStmt(
          db,
          'SELECT value FROM operations WHERE entity = ? AND entity_id = ? AND field = ? ORDER BY seq DESC LIMIT 1'
        ).get(table, id, wanted)
        return prior ? prior.value : null
      }
      const scheduleWeekId = readField('schedule_week_id')
      const dayId = readField('day_id')
      const groupId = readField('group_id')
      const timeBlockId = readField('time_block_id')
      if (scheduleWeekId == null || dayId == null || groupId == null || timeBlockId == null) return

      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(
        db,
        'INSERT OR IGNORE INTO day_overrides (id, camp_id, schedule_week_id, day_id, group_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, camp?.id ?? null, scheduleWeekId, dayId, groupId, timeBlockId)
    },
  },
  // Join tables with TWO NOT NULL columns (week_id + a real FK). ensureExists
  // reconstructs both fields from the op-log and inserts the complete row once
  // both are known — see ensureWeekJoinRow above for why a week_id-only seed
  // silently dropped every ON toggle before this fix.
  week_activity_exclusions: {
    table: 'week_activity_exclusions',
    key: 'id',
    fields: ['week_id', 'activity_id'],
    ensureExists: ensureWeekJoinRow('week_activity_exclusions', 'activity_id'),
  },
  week_group_exclusions: {
    table: 'week_group_exclusions',
    key: 'id',
    fields: ['week_id', 'group_id'],
    ensureExists: ensureWeekJoinRow('week_group_exclusions', 'group_id'),
  },
  // A week is director-named text ("Week 1"), direct-camp-scoped exactly like
  // groups/tiers — it is not reached through a parent, so it belongs in
  // DIRECT_CAMP_ENTITIES (electron/ops/campScopedEntities.js), no
  // PARENT_SCOPED_ENTITIES. See docs/adr/2026-08-02-schedule-weeks-first-class.md.
  schedule_weeks: {
    table: 'schedule_weeks',
    key: 'id',
    fields: ['camp_id', 'name', 'sort_order', 'is_archived'],
    ensureExists: (db, id) => {
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db,
        "INSERT OR IGNORE INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, '', 0, 0)"
      ).run(id, camp?.id ?? null)
    },
  },
  schedule_templates: {
    table: 'schedule_templates',
    key: 'id',
    // WRITE-ORDERING CONTRACT: `kind` must be the FIRST field written for a new
    // row. The row is created by whichever field arrives first, and kind is NOT
    // NULL DEFAULT 'generated' — so a manual candidate whose kind arrived
    // second would first materialise as 'generated', collide with the real
    // generated row under UNIQUE(week_id, kind), be absorbed by INSERT OR
    // IGNORE, and vanish silently on that device. Op replay is seq-ordered, so
    // the write-site order is the replica order. Recovering the route by
    // parsing the id suffix is deliberately NOT done: the id format is not a
    // parsing contract (ADR Decision §1).
    fields: ['kind', 'camp_id', 'week_id', 'name'],
    ensureExists: (db, id, field, value) => {
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, '', ?)").run(
        id,
        camp?.id ?? null,
        field === 'kind' && value ? value : 'generated'
      )
      // BACKSTOP. INSERT OR IGNORE absorbs a UNIQUE(week_id, kind) violation
      // just as silently as a primary-key clash: if a row of this kind already
      // exists under a DIFFERENT id, nothing is inserted, every following field
      // UPDATE matches zero rows, and the caller believes it succeeded. Tha
      // invisibility is what shipped a camp that could not generate. Fail
      // loudly instead.
      //
      // Consequences differ by path, and only one of them keeps the op:
      //   - Client broadcast replay (syncClient.applyRemoteOp): the operations
      //     row is inserted first and applyProjection runs inside tha
      //     function's by-design catch, so the op STAYS DURABLE in the log and
      //     repairMissingScheduleTemplates can rebuild at upgrade time.
      //   - appendOp (electron/ops/operations.js): the INSERT and
      //     applyProjection share ONE transaction, so this throw rolls the
      //     op-log INSERT back — the op is DISCARDED, not stored. That also
      //     applies on the Host's path for a Client-submitted op
      //     (syncServer.handleSubmitOp), where the throw unwinds to the generic
      //     message-handler catch and the Client gets an error reply, agains
      //     appendOp's own stated non-throwing contract.
      // That is accepted deliberately: discarding a write that cannot be
      // projected is better than the silent no-op that shipped a camp which
      // could not generate, and the renderer now reports the failure rather
      // than hanging (ScheduleScreen generate()/placeAnchors() guard their
      // ensureTemplateRow calls). It is recorded as a residual, not a claim
      // that the op survives.
      //
      // The renderer's resolve-by-(week_id, kind) fix NARROWS this throw but does
      // not eliminate it (confirmed by review, 2026-08-02): writeFields sends one
      // appendOp per field, each its own transaction, so on a new template the
      // `kind` and `camp_id` writes COMMIT before the `week_id` write runs. If
      // that final write collides — reachable when a device's renderer state lags
      // a legacy random-UUID row that v27 just backfilled a week_id onto, and the
      // old row's op arrives between the camp_id and week_id writes — the throw
      // rolls back only its own op, leaving a residual row (kind+camp_id set,
      // week_id NULL) that templateRowFor's `week_id === weekId` filter can never
      // resolve. It is harmless clutter, not data loss: a NULL week_id does no
      // violate UNIQUE(week_id, kind) (NULLs are distinct), cannot appear in any
      // week's grid, and SELF-HEALS — the next write to the same week+kind reuses
      // the deterministic id and completes the same row. Named honestly here so a
      // maintainer doesn't read "unreachable" and treat this as dead code.
      // Narrowed deliberately to the (week_id, kind) collision. An INSERT OR
      // IGNORE can also be absorbed for unrelated reasons (e.g. no camps row
      // yet, mid first-pairing sync), and those must keep their existing
      // tolerant behaviour rather than becoming a new hard failure.
      //
      // week_id is NOT necessarily known on this call — ensureExists only ever
      // sees ONE field's value (see the write-ordering contract above), and
      // week_id is written after `kind`. So this reads the row's CURRENT
      // week_id (already set by an earlier write in this same writeFields()
      // sequence, if any) rather than assuming this call's `value` is it. Once
      // the row exists with a real week_id, this also correctly guards the
      // write that FIRST sets week_id on a freshly-created row.
      const exists = getStmt(db, 'SELECT 1 FROM schedule_templates WHERE id = ?').get(id)
      const row = getStmt(db, 'SELECT kind, week_id FROM schedule_templates WHERE id = ?').get(id)
      const kind = field === 'kind' && value ? value : row?.kind || 'generated'
      const weekId = field === 'week_id' && value ? value : row?.week_id
      const holder = weekId
        ? getStmt(db, 'SELECT id FROM schedule_templates WHERE week_id = ? AND kind = ?').get(weekId, kind)
        : null
      if (holder && holder.id !== id && !(exists && holder.id === id)) {
        const err = new Error(
          `SCHEDULE_TEMPLATE_KIND_CONFLICT: a schedule_templates row for this week and kind already exists under a different id (attempted id: ${id}, existing id: ${holder.id})`
        )
        err.code = 'SCHEDULE_TEMPLATE_KIND_CONFLICT'
        throw err
      }
    },
  },
  // Never previously registered here (see the day_override_template_slots
  // comment above referencing "same shape as ... schedule_snapshots", which
  // was aspirational, not actual) — ScheduleScreen.jsx's writeFields()
  // already writes these ops assuming a working projection, but with no
  // PROJECTIONS entry applyProjection silently no-ops for every field, so a
  // schedule_snapshots row never actually materializes. Same parent-scoped,
  // no-camp_id pattern as day_override_template_slots: template_id is a
  // real NOT NULL FK (schema.sql) with no default, so the row can only be
  // created once template_id is known — writeFields() always writes
  // template_id first, matching the required ordering.
  schedule_snapshots: {
    table: 'schedule_snapshots',
    key: 'id',
    // day_overrides_json (v38, T108, design §5.2): the whole week's
    // day_overrides rows captured at save time, restored on undo.
    fields: ['template_id', 'name', 'is_auto', 'created_at', 'slots', 'overlays', 'day_overrides_json'],
    ensureExists: (db, id, field, value) => {
      if (field !== 'template_id') return
      // created_at is NOT NULL with no default (schema.sql) — placeholder
      // here, same as every other entity's NOT NULL/no-default column
      // (e.g. anchor_activities/day_override_templates' name), always
      // overwritten by the subsequent write() for that field.
      getStmt(db,
        "INSERT OR IGNORE INTO schedule_snapshots (id, template_id, created_at) VALUES (?, ?, '')"
      ).run(id, value)
    },
  },
  // Registered for the same reason schedule_snapshots and template_slots were:
  // an unregistered entity's ops are appended to the log and then silently
  // discarded by applyProjection. Until now template_overlays was only ever
  // written through bulkReplace (BULK_REPLACE_ENTITIES), which bypasses this
  // registry — so a field-level or DELETE_FIELD op naming it did nothing a
  // all. Deleting a day has to remove that day's overlays as recorded,
  // replayable ops (docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md),
  // and a silent no-op there would leave the day's delete blocked by its own FK
  // on every device with no error anywhere.
  //
  // Parent-scoped with no camp_id column, like template_slots below; field lis
  // is BULK_REPLACE_ENTITIES.template_overlays' column set minus `id`, so the
  // two paths write the same columns.
  template_overlays: {
    table: 'template_overlays',
    key: 'id',
    fields: ['template_id', 'unit_id', 'day_id', 'from_block_order', 'to_block_order', 'label'],
    ensureExists: (db, id, field, value) => {
      if (field !== 'template_id') return
      getStmt(db, 'INSERT OR IGNORE INTO template_overlays (id, template_id) VALUES (?, ?)').run(id, value)
    },
  },
  // Same never-registered bug class as schedule_snapshots above, and the
  // direct cause of "manual schedule edits silently do nothing":
  // ScheduleScreen.jsx's writeFields() has always written these fields, so
  // each op was appended to the operations log (and replicated to peers)
  // while applyProjection's `if (!projection) return` discarded it — the
  // template_slots row was never updated. Engine generation was unaffected
  // only because it goes through localClient.bulkReplace, which writes rows
  // directly via BULK_REPLACE_ENTITIES (operations.js) and never consults
  // this registry.
  //
  // Parent-scoped with no camp_id column (schema.sql), like
  // day_override_template_slots/schedule_snapshots — so ensureExists mus
  // not look up `camps`, and applyProjection's camp_id guard never applies.
  //
  // Field list is every non-key column of template_slots (schema.sql plus
  // the flags/is_released/is_span_head columns added in localDb.js's
  // version-10 migration and anchor_id/is_anchor added in version 17),
  // matching BULK_REPLACE_ENTITIES.template_slots' column set minus `id`.
  // Completeness matters more here than for most entities: appendOp
  // enforces this allowlist with a THROW ('field not allowed for entity')
  // for any registered entity, so a field omitted here would turn today's
  // silent no-op into a hard write failure.
  template_slots: {
    table: 'template_slots',
    key: 'id',
    fields: [
      'template_id',
      'group_id',
      'activity_id',
      'day_id',
      'time_block_id',
      'anchor_id',
      'is_anchor',
      'is_span_head',
      'is_released',
      'flags',
      // v35 (T41 slice 1, docs/work/specs/2026-08-20-group-electives-design.md):
      // a slot with elective_set_id set is an elective cell (activity_id
      // ignored); the two are mutually exclusive, enforced at apply time by
      // MUTUALLY_EXCLUSIVE_FIELDS below (T111,
      // docs/work/specs/2026-08-20-elective-cell-atomic-content-design.md).
      'elective_set_id',
      // v40 (Events overlay placement Slice 1, docs/adr/2026-08-22-events-
      // overlay-placement.md): a slot with event_id set is an opaque event
      // cell; all three of activity_id/elective_set_id/event_id are mutually
      // exclusive as a precedence-ordered group (see MUTUALLY_EXCLUSIVE_FIELDS
      // below).
      'event_id',
    ],
    // template_id is NOT NULL with no default and is a real FK, so the row
    // can only be created once the parent link is known — identical shape to
    // day_override_template_slots/schedule_snapshots above.
    //
    // Unlike those two, however, NO current caller ever reaches the insert:
    // every writeFields('template_slots', ...) call in ScheduleScreen.jsx
    // updates a row that bulkReplace already created, and none of them
    // writes template_id at all. So for today's call sites this is always a
    // no-op and the fix that matters is the UPDATE below. It is kep
    // (rather than dropped) so the ordering contract is already correct for
    // the not-yet-existing create path — placeActivityManual currently has
    // no INSERT branch, which is a separate tracked bug.
    ensureExists: (db, id, field, value) => {
      if (field !== 'template_id') return
      getStmt(db, 'INSERT OR IGNORE INTO template_slots (id, template_id) VALUES (?, ?)').run(id, value)
    },
  },
  // Registered so that DELETE_FIELD ops from deleteWeek.js can physically
  // remove stale conflict rows when their referenced entity is deleted.
  // Conflicts are created by raw SQL (recordConflict in operations.js), no
  // via appendOp, so ensureExists is a no-op — a conflict row is never
  // created by projection replay. No field writes via op-log either.
  conflicts: {
    table: 'conflicts',
    key: 'id',
    fields: [],
    ensureExists: () => {},
  },
}

// Cells whose "kind" must be exclusive across two independently-conflict-
// tracked columns on the same row. See T111,
// docs/work/specs/2026-08-20-elective-cell-atomic-content-design.md, D4.
// Conflict detection (conflicts table) is keyed per-(entity, entity_id,
// field), so activity_id and elective_set_id are two separately-arbitrated
// last-write-wins values on the same template_slots row — a cross-device
// interleave of a paired "set one, clear the other" write can otherwise
// leave both non-null with no conflict ever recorded. The eviction step in
// applyProjection below, plus sanitizeMutuallyExclusiveRow for the
// bulkReplace write paths (operations.js), close that race at apply time.
// Generalized (Events overlay placement Slice 1, docs/adr/2026-08-22-events-
// overlay-placement.md §3) from a pair-dict to a list of precedence-ordered
// groups — a three-way exclusivity (activity_id/elective_set_id/event_id)
// cannot be expressed as symmetric pairs without a contradiction (a row
// could end up with activity_id + event_id both set, unsanitized, since
// neither pair mentions the other). Group order IS precedence order: the
// field listed first survives when more than one member is non-null.
export const MUTUALLY_EXCLUSIVE_FIELDS = {
  template_slots: [['activity_id', 'elective_set_id', 'event_id']],
}

// Pure, total sanitizer for a single row object: for each registered group,
// keeps the first non-null field (group order = precedence) and nulls every
// other member of the group that is also non-null, deterministically and
// identically on every device sanitizing the same row data. No-op for any
// entity not registered above (e.g. template_overlays). Used by
// operations.js's bulkReplace write and replay paths, which never go through
// applyProjection/the per-field eviction step below.
export function sanitizeMutuallyExclusiveRow(entity, row) {
  const groups = MUTUALLY_EXCLUSIVE_FIELDS[entity]
  if (!groups) return row
  let result = row
  for (const group of groups) {
    const survivor = group.find((field) => result[field] != null)
    if (!survivor) continue
    for (const field of group) {
      if (field !== survivor && result[field] != null) {
        result = { ...result, [field]: null }
      }
    }
  }
  return result
}

// Reserved field name for a row-delete op — see DELETE_FIELD's definition in
// operations.js for why a delete is expressed as a sentinel field on the
// same appendOp path rather than a new primitive. Kept as a separate literal
// here (not imported) to avoid a projections.js -> operations.js impor
// cycle, since operations.js already imports PROJECTIONS/applyProjection
// from this file.
const DELETE_FIELD = '__deleted__'

export function applyProjection(db, op) {
  const projection = PROJECTIONS[op.entity]
  if (!projection) return

  if (op.field === DELETE_FIELD) {
    getStmt(db, `DELETE FROM ${projection.table} WHERE ${projection.key} = ?`).run(op.entity_id)
    return
  }

  if (!projection.fields.includes(op.field)) return

  if (op.field === 'camp_id') {
    const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
    if (!camp || op.value !== camp.id) {
      console.error(
        `applyProjection: rejected camp_id write on ${op.entity}/${op.entity_id} — value ${JSON.stringify(op.value)} does not match this device's camp (${camp?.id ?? 'none'})`
      )
      // Return false (not just bare `return`) specifically for this branch —
      // unlike every other early-return above (unregistered entity/field),
      // which are legitimate silent no-ops, a rejected camp_id is the one
      // case appendOp's caller (a same-device, trusted, first-party write —
      // see appendOp in operations.js) needs to distinguish from success:
      // silently swallowing it there would let a local write commit to the
      // op-log as if it succeeded while the row never actually changed. A
      // rejected *remote* replay op (the case this guard was designed for)
      // still degrades gracefully — its caller (applyRemoteOp in
      // syncClient.js) doesn't inspect the return value, so this is a
      // strictly additive signal, not a behavior change for that path.
      return false
    }
  }

  // Most ensureExists implementations only need the id (they insert a
  // placeholder row with safe defaults). day_override_template_slots is the
  // exception: its parent FK column is NOT NULL with no default, so its
  // ensureExists needs the current op's field/value to satisfy the FK on
  // first insert — see that entry below.
  projection.ensureExists?.(db, op.entity_id, op.field, op.value)

  getStmt(db, `UPDATE ${projection.table} SET ${op.field} = ? WHERE ${projection.key} = ?`).run(
    op.value,
    op.entity_id
  )

  // T111 eviction step: a non-null write to a registered mutually-exclusive
  // field immediately and unconditionally clears its partner column on the
  // same row, right now — not deferred to a reconciliation pass, which
  // could itself race. Because op replay is seq-ordered identically on
  // every device (load-bearing invariant, docs/adr/2026-08-12-drag-live-
  // write-serialization.md), this apply-time-only rule is sufficient to
  // guarantee at most one of the pair is ever non-null, regardless of
  // cross-device arrival order — see the design doc's worked interleave.
  // This is a local side effect of replay, not a new appended op: it must
  // never be re-appended to the op-log (that would create a duplicate-op
  // loop across devices replaying each other's corrections).
  const exclusiveGroup = MUTUALLY_EXCLUSIVE_FIELDS[op.entity]?.find((group) => group.includes(op.field))
  if (exclusiveGroup && op.value != null) {
    for (const partner of exclusiveGroup) {
      if (partner === op.field) continue
      getStmt(
        db,
        `UPDATE ${projection.table} SET ${partner} = NULL WHERE ${projection.key} = ? AND ${partner} IS NOT NULL`
      ).run(op.entity_id)
    }
  }

  return true
}
