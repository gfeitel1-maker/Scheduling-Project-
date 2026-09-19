import { getStmt } from './stmtCache.js'
import { parseDayOfWeek } from './dayId.js'

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
// table (event_slots etc.): the FK columns point at real tables,
// so '' or NULL both violate the constraint. Instead, reconstruct BOTH values
// and insert the complete row only once both are known. The current op supplies
// one field directly. For the op-log path, the sibling is read back from the
// operations log, where appendOp has already durably inserted it — appendOp
// writes the op row BEFORE calling applyProjection, and replay
// (syncClient.applyRemoteOp) does the same in seq order, so the earlier
// field's op is always present by the time the later field's op projects, on
// both the writing device and every replica. Whichever field arrives SECOND
// creates the row; the first is a deliberate no-op. Order-independent and
// replay-safe, with no new IPC/op primitive.
//
// `knownRow` (electron/automerge/projector.js) is the doc-native alternative
// to the operations-log lookup: a document row holds every field it currently
// has for this id, all at once, so the projector can hand it straight to
// readField instead of ensureExists having to query a table Stage 6 removes.
// Checked BEFORE the operations fallback so a doc-native caller never touches
// `operations` at all; an op-log caller passes no knownRow and this behaves
// exactly as before.
//
// (week_location_exclusions, the third instance of this pattern, now also uses
// this helper as of slice M5, which added its writer.)
// T194: stub-seed the elective_assignment_runs parent for its four
// parent-scoped children. Same treatment elective_set_activities gives
// elective_sets — under foreign_keys = ON a child whose op arrives before its
// parent's cannot insert, and op-log replay and Automerge merge both apply
// rows in arbitrary order. `name` is NOT NULL with no default, so the stub
// supplies ''. The real name arrives as an ordinary field write and the
// generic UPDATE overwrites the placeholder.
function ensureRunStub(db, runId) {
  const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
  getStmt(
    db,
    "INSERT OR IGNORE INTO elective_assignment_runs (id, camp_id, name) VALUES (?, ?, '')"
  ).run(runId, camp?.id ?? null)
}

function ensureWeekJoinRow(table, secondColumn) {
  return (db, id, field, value, knownRow) => {
    const readField = (wanted) => {
      if (field === wanted) return value
      if (knownRow && wanted in knownRow) return knownRow[wanted]
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
    fields: ['camp_id', 'name', 'pin_hash', 'pin_salt', 'role', 'auth_sig', 'cred_version'],
    ensureExists: (db, id) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO users (id, camp_id, name, pin_hash, pin_salt, role, auth_sig, cred_version) VALUES (?, NULL, '', '', '', 'staff', '', 0)"
        )
        .run(id),
  },
  // tombstones (T233 — docs/adr/2026-09-19-multi-device-erasure-propagation.md): `id` IS the
  // purged target entity's own id, not a separately-minted tombstone id — same singleton-by-id
  // shape as `users` above, no camp scoping (a tombstone names no camp; it names a record).
  // Enforcement (signature verification + monotonicity) happens in the projector
  // (upsertTombstonesEntity), not here — this ensureExists only creates the placeholder row a
  // field-by-field projection needs, exactly like every other entity's ensureExists.
  tombstones: {
    table: 'tombstones',
    key: 'id',
    fields: ['entity', 'version', 'sig', 'created_at'],
    ensureExists: (db, id) =>
      db
        .prepare("INSERT OR IGNORE INTO tombstones (id, entity, version, sig) VALUES (?, '', 0, '')")
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
    // T205 part A: when `id` is a deterministic day id (electron/ops/dayId.js),
    // stamp day_of_week in this SAME insert — closing the NULL-at-creation
    // window that made UNIQUE(camp_id, day_of_week) inert (a collision used to
    // land on the LATER day_of_week field write instead of here, throwing and
    // leaving a torn, permanently-NULL-day row nothing could ever match again).
    // A non-deterministic id (a pre-T205 crypto.randomUUID() row) falls back to
    // today's NULL behavior — never throw on an unexpected id shape.
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups.ensureExists above.
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      const dayOfWeek = parseDayOfWeek(id)
      getStmt(
        db,
        "INSERT OR IGNORE INTO days_of_operation (id, camp_id, label, day_of_week) VALUES (?, ?, '', ?)"
      ).run(id, camp?.id ?? null, dayOfWeek)
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
      // v44: truth-status × binding-vector activity ontology
      // (docs/adr/2026-08-23-activity-recurrence-tiers-ingestion.md §3.2).
      // Storage + projection only in this slice — no writer, no engine use.
      'recurrence_truth_status',
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
    fields: ['camp_id', 'name', 'capacity', 'notes', 'sort_order', 'map_geometry', 'kind', 'grid_x', 'grid_y', 'map_id'],
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
  // docs/adr/2026-08-16-locations-optional-map.md D1; pair extension schema v50,
  // docs/adr/2026-08-26-indoor-outdoor-map-pair-and-sim-seed.md D1). Originally a
  // camp-scoped singleton (id = camp_id); now up to two rows per camp keyed by
  // (camp_id, kind). ensureExists still stamps only id + camp_id — `kind` and the
  // image fields arrive as ordinary field-level ops. image_data is size-capped by
  // MAX_FIELD_VALUE_LENGTH in operations.js (D2), enforced in appendOp
  // itself, before this projection ever runs.
  camp_maps: {
    table: 'camp_maps',
    key: 'id',
    fields: ['camp_id', 'image_data', 'image_mime', 'image_width', 'image_height', 'kind'],
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
      'schedule_week_id', 'location_id',
      // Slice B (docs/adr/2026-08-24-merged-cell-multiblock-ingest.md
      // addendum): ingest now writes span_blocks on a confirmed recurring
      // multi-block candidate. Already a live, engine-consumed column
      // (buildSchedule.js reads anchor.span_blocks || 1) — this just makes
      // it a writable field for the op-log path too.
      'span_blocks',
      // v51 (docs/adr/2026-08-28-fixed-vs-recurring-events.md §6) — Fixed
      // vs Recurring classification. A director never toggles this directly;
      // it is implied by which screen/form wrote the row (AnchorsScreen)
      // and set here as an ordinary field-level op, same as is_all_groups.
      'kind',
      // v65 (T180) — the age DIVISIONS a recurring event is scoped to, as a
      // JSON array of tier ids, written by AnchorsScreen exactly like
      // group_ids. This is what makes division scope LIVE: the engine
      // resolves it at build time, so a group added to one of those divisions
      // later is covered without re-saving the event. The legacy singular
      // `unit_id` stays read-only (see the recorded exemption in
      // electron/ops/projectionsCoverage.test.js).
      'unit_ids',
    ],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/days_of_operation/time_blocks/tiers/activities.ensureExists above.
      // is_all_groups=1 is set explicitly (not left NULL) so this stub row
      // satisfies the v51 CHECK for its DEFAULT 'fixed' kind at the moment
      // it's inserted, before any subsequent field-level op narrows its
      // scope — see docs/adr/2026-08-28-fixed-vs-recurring-events.md §9.
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(
        db,
        "INSERT OR IGNORE INTO anchor_activities (id, camp_id, name, is_all_groups) VALUES (?, ?, '', 1)"
      ).run(id, camp?.id ?? null)
    },
  },
  // Special days (T40 slice 1, data shape only,
  // docs/work/specs/2026-08-20-special-days-data-shape-design.md). Camp-scoped
  // parent, same ensureExists shape as anchor_activities above.
  special_days: {
    table: 'special_days',
    key: 'id',
    fields: ['camp_id', 'name', 'sort_order', 'notes'],
    ensureExists: (db, id) => {
      // Same zero-camps caveat as cohorts/groups/anchor_activities/etc.ensureExists above.
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO special_days (id, camp_id, name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  // Parent-scoped by special_day_id, no camp_id column — same shape as
  // event_time_blocks below. name and sort_order are NOT NULL with
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
    // knownRow: see ensureWeekJoinRow's comment above — the doc-native alternative to the
    // operations-log lookup, checked first so a doc-native caller never touches `operations`.
    ensureExists: (db, id, field, value, knownRow) => {
      const table = 'special_day_slots'
      const readField = (wanted) => {
        if (field === wanted) return value
        if (knownRow && wanted in knownRow) return knownRow[wanted]
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
  // parent, same ensureExists shape as special_days above.
  elective_sets: {
    table: 'elective_sets',
    key: 'id',
    // is_reusable (v36, T110, docs/adr/2026-08-20-electives-authoring.md D2):
    // the durability marker, director-editable via the management screen's
    // "keep this for next time" gesture — a renderer write like camp_id/
    // name/sort_order, so it belongs in this allowlist (not
    // PROJECTION_FIELD_EXCEPTIONS, which is only for server/migration-only
    // columns).
    // day_id/time_block_id/is_all_groups/group_ids/schedule_week_id
    // (v43, Slice 3a): the recurring-event binding shape,
    // mirroring anchor_activities' fields entry — a normal renderer write
    // once the elective screen wires this up, applied generically via the
    // UPDATE path below like every other field here.
    fields: [
      'camp_id', 'name', 'sort_order', 'is_reusable',
      'day_id', 'time_block_id', 'is_all_groups', 'group_ids', 'schedule_week_id',
    ],
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
    // capacity_mode / capacity_limit (v66, T194, ADR D3): normal renderer
    // writes like elective_set_id/activity_id, applied generically via the
    // UPDATE below — no ensureExists involvement, since the row must already
    // exist (created by the elective_set_id/activity_id pair) before capacity
    // is editable.
    //
    // camper_headcount (v39) is DELIBERATELY REMOVED from this list: the
    // column is retained in the table (dropping it needs a table rebuild, the
    // class that produced T189's lost index) but retired from the WRITE path,
    // so no write can reach it and the two-part capacity value is the only
    // authority going forward.
    //
    // These two are written ONE FIELD PER OP, which is why the DB CHECKs on
    // them are per-column and not a cross-column pairing — see schema.sql's
    // comment and the named test in participantSubstrate.migration.test.js.
    // status (v68, T195): potential/confirmed. Written the same way as
    // capacity_mode/capacity_limit above — a normal renderer/importer field,
    // applied generically via the UPDATE below.
    fields: ['elective_set_id', 'activity_id', 'capacity_mode', 'capacity_limit', 'status'],
    // knownRow: see ensureWeekJoinRow's comment above.
    ensureExists: (db, id, field, value, knownRow) => {
      const table = 'elective_set_activities'
      const readField = (wanted) => {
        if (field === wanted) return value
        if (knownRow && wanted in knownRow) return knownRow[wanted]
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
    fields: ['camp_id', 'name', 'sort_order', 'notes', 'location_id'],
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
    // knownRow: see ensureWeekJoinRow's comment above.
    ensureExists: (db, id, field, value, knownRow) => {
      const table = 'event_slots'
      const readField = (wanted) => {
        if (field === wanted) return value
        if (knownRow && wanted in knownRow) return knownRow[wanted]
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
  // Never previously registered here — ScheduleScreen.jsx's writeFields()
  // already writes these ops assuming a working projection, but with no
  // PROJECTIONS entry applyProjection silently no-ops for every field, so a
  // schedule_snapshots row never actually materializes. Same parent-scoped,
  // no-camp_id pattern as event_slots: template_id is a
  // real NOT NULL FK (schema.sql) with no default, so the row can only be
  // created once template_id is known — writeFields() always writes
  // template_id first, matching the required ordering.
  schedule_snapshots: {
    table: 'schedule_snapshots',
    key: 'id',
    fields: ['template_id', 'name', 'is_auto', 'created_at', 'slots'],
    ensureExists: (db, id, field, value) => {
      if (field !== 'template_id') return
      // created_at is NOT NULL with no default (schema.sql) — placeholder
      // here, same as every other entity's NOT NULL/no-default column
      // (e.g. anchor_activities'/special_days' name), always
      // overwritten by the subsequent write() for that field.
      getStmt(db,
        "INSERT OR IGNORE INTO schedule_snapshots (id, template_id, created_at) VALUES (?, ?, '')"
      ).run(id, value)
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
  // event_slots/schedule_snapshots — so ensureExists must
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
    // event_slots/schedule_snapshots above.
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
  // --- T194 participant substrate (v66) --------------------------------
  // ADR docs/adr/2026-09-17-individual-elective-scheduling.md.
  //
  // An entity absent from PROJECTIONS has its writes SILENTLY DISCARDED —
  // applyProjection returns early on an unknown entity, so the op-log write
  // succeeds and the row never materializes. That has bitten this project
  // twice (schedule_templates, schedule_snapshots).
  //
  // ADMIN-ONLY (D9): registering here is a PROJECTION fact, not a permission
  // grant. All seven are deliberately absent from permissions.js ENTITIES.

  // Camp-scoped, same ensureExists shape as events/elective_sets above.
  // display_name is NOT NULL with no default, so the placeholder supplies ''.
  campers: {
    table: 'campers',
    key: 'id',
    fields: ['camp_id', 'display_name', 'group_id', 'external_id', 'is_active'],
    ensureExists: (db, id) => {
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(db, "INSERT OR IGNORE INTO campers (id, camp_id, display_name) VALUES (?, ?, '')").run(
        id,
        camp?.id ?? null
      )
    },
  },
  // Camp-scoped. `name` is NOT NULL with no default; `status` and the two
  // solver columns have defaults, so the placeholder supplies name only.
  elective_assignment_runs: {
    table: 'elective_assignment_runs',
    key: 'id',
    fields: [
      'camp_id',
      'schedule_week_id',
      'schedule_template_id',
      'tier_id',
      'name',
      'status',
      'source_filename',
      'source_sha256',
      'solver_version',
      // D5's marker. T194 STORES it; T196 enforces inertness. Nothing in the
      // projection layer may filter on it — that would put solver policy here.
      'solver_generation',
    ],
    ensureExists: (db, id) => {
      const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
      getStmt(
        db,
        "INSERT OR IGNORE INTO elective_assignment_runs (id, camp_id, name) VALUES (?, ?, '')"
      ).run(id, camp?.id ?? null)
    },
  },
  // Parent-scoped by run_id (no camp_id column). ONE NOT NULL parent column
  // and a real FK, so the single-field seed shape of event_time_blocks applies
  // — with the parent stub-seeded first, as elective_set_activities does for
  // elective_sets.
  elective_occurrences: {
    table: 'elective_occurrences',
    key: 'id',
    fields: ['run_id', 'elective_set_id', 'day_id', 'time_block_id', 'tier_id'],
    ensureExists: (db, id, field, value) => {
      if (field !== 'run_id') return
      ensureRunStub(db, value)
      getStmt(db, 'INSERT OR IGNORE INTO elective_occurrences (id, run_id) VALUES (?, ?)').run(
        id,
        value
      )
    },
  },
  // Parent-scoped by run_id. `label` is NOT NULL with no default.
  elective_choices: {
    table: 'elective_choices',
    key: 'id',
    fields: ['run_id', 'label', 'is_linked'],
    ensureExists: (db, id, field, value) => {
      if (field !== 'run_id') return
      ensureRunStub(db, value)
      getStmt(
        db,
        "INSERT OR IGNORE INTO elective_choices (id, run_id, label) VALUES (?, ?, '')"
      ).run(id, value)
    },
  },
  // Parent-scoped by choice_id — the ONE of the five that hangs off a choice
  // rather than off the run.
  elective_choice_offerings: {
    table: 'elective_choice_offerings',
    key: 'id',
    fields: ['choice_id', 'occurrence_id', 'activity_id'],
    // NO PARENT STUB. The first draft seeded an elective_choices row with
    // run_id = '' to satisfy a declared REFERENCES — and INSERT OR IGNORE does
    // not suppress a foreign-key violation, so `elective_choices.run_id`'s own
    // FK made that stub throw on the exact out-of-order op it existed to
    // handle. The parent references are soft now (see schema.sql's REFERENCES
    // discipline comment), so an offering simply projects with a choice_id that
    // does not resolve yet, and resolves when the choice arrives.
    ensureExists: (db, id, field, value) => {
      if (field !== 'choice_id') return
      getStmt(
        db,
        'INSERT OR IGNORE INTO elective_choice_offerings (id, choice_id) VALUES (?, ?)'
      ).run(id, value)
    },
  },
  elective_preferences: {
    table: 'elective_preferences',
    key: 'id',
    fields: ['run_id', 'camper_id', 'choice_id', 'rank'],
    ensureExists: (db, id, field, value) => {
      if (field !== 'run_id') return
      ensureRunStub(db, value)
      getStmt(db, 'INSERT OR IGNORE INTO elective_preferences (id, run_id) VALUES (?, ?)').run(
        id,
        value
      )
    },
  },
  // The output row whose DERIVED ID is the uniqueness invariant (ADR D4). Two
  // devices assigning the same (run, camper, occurrence) produce the SAME id,
  // so this is an ordinary per-field last-write-wins on ONE record plus a
  // conflicts row — not two rows. See electron/ops/electiveDerivedIds.js.
  elective_assignments: {
    table: 'elective_assignments',
    key: 'id',
    fields: [
      'run_id',
      'occurrence_id',
      'camper_id',
      'activity_id',
      'choice_id',
      'preference_rank',
      'source',
      'is_locked',
      'solver_generation',
    ],
    ensureExists: (db, id, field, value) => {
      if (field !== 'run_id') return
      ensureRunStub(db, value)
      getStmt(db, 'INSERT OR IGNORE INTO elective_assignments (id, run_id) VALUES (?, ?)').run(
        id,
        value
      )
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
// entity not registered above (e.g. schedule_snapshots). Used by
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
  // placeholder row with safe defaults). event_slots is the
  // exception: its parent FK column is NOT NULL with no default, so its
  // ensureExists needs the current op's field/value to satisfy the FK on
  // first insert — see that entry below.
  //
  // op.knownRow (electron/automerge/projector.js) is the doc-native row this op was synthesized
  // from — every field the document currently holds for this id, all at once. The op-log path
  // (appendOp, syncClient replay) never sets it, so this is a no-op there; ensureExists
  // implementations that accept it fall back to reading `operations` exactly as before.
  projection.ensureExists?.(db, op.entity_id, op.field, op.value, op.knownRow)

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
