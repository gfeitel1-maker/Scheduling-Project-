import { getStmt } from './stmtCache.js'

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
  // Per-week location availability (v32). Third instance of the v28
  // week_*_exclusions pattern above — parent-keyed by week_id, ensureExists
  // gated on week_id arriving first (no other NOT NULL column to seed).
  week_location_exclusions: {
    table: 'week_location_exclusions',
    key: 'id',
    fields: ['week_id', 'location_id'],
    ensureExists: (db, id, field, value) => {
      if (field !== 'week_id') return
      getStmt(db,
        'INSERT OR IGNORE INTO week_location_exclusions (id, week_id) VALUES (?, ?)'
      ).run(id, value)
    },
  },
  anchor_activities: {
    table: 'anchor_activities',
    key: 'id',
    fields: ['camp_id', 'cohort_id', 'day_id', 'time_block_id', 'name', 'is_all_groups', 'group_ids', 'notes'],
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
  // Parent-scoped via week_id, same pattern as day_override_template_slots.
  // ensureExists is gated on field === 'week_id' arriving first: these rows have
  // no other NOT NULL column to seed, and creating the row before week_id is
  // known would land an orphan with a NULL FK.
  week_activity_exclusions: {
    table: 'week_activity_exclusions',
    key: 'id',
    fields: ['week_id', 'activity_id'],
    ensureExists: (db, id, field, value) => {
      if (field !== 'week_id') return
      getStmt(db,
        'INSERT OR IGNORE INTO week_activity_exclusions (id, week_id) VALUES (?, ?)'
      ).run(id, value)
    },
  },
  week_group_exclusions: {
    table: 'week_group_exclusions',
    key: 'id',
    fields: ['week_id', 'group_id'],
    ensureExists: (db, id, field, value) => {
      if (field !== 'week_id') return
      getStmt(db,
        'INSERT OR IGNORE INTO week_group_exclusions (id, week_id) VALUES (?, ?)'
      ).run(id, value)
    },
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
    fields: ['template_id', 'name', 'is_auto', 'created_at', 'slots', 'overlays'],
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
  return true
}
