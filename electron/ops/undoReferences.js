// U2 (creation/deletion undo) — referential-integrity registry.
//
// docs/adr/2026-08-17-onescreen-reconciliation-undo.md, U2 mechanism section
// ("Finding 1+2 fix") and the 3rd Red Hat pass amendment at the top of that
// file. This is the hand-authored, schema-exhaustive registry of every
// INCOMING reference into a U2-deletable entity — used by U2's deletion slice
// (not built in this file: see referencesInto below, read-only) to decide
// whether deleting a created row would orphan a live reference.
//
// `enforced: true` means SQLite's own `PRAGMA foreign_keys = ON` (set by
// openLocalDb, electron/db/localDb.js) throws `FOREIGN KEY constraint failed`
// on an unchecked delete. `enforced: false` means the pointer is convention-
// only (no DB-level REFERENCES clause): SQLite allows the delete and an
// unchecked one produces a SILENT orphan. Both are checked identically by
// `referencesInto` below — the flag only explains why skipping the check
// fails differently, and makes severity legible to a reviewer.
//
// KEPT IN SYNC MECHANICALLY, not by hand-diligence alone — see
// undoReferences.schemaParity.test.js, whose scanner enumerates every real
// `*_id`/`*_ids` column via PRAGMA table_info and fails if it is neither
// registered here nor explicitly accepted as a non-reference. Adding a new
// `*_id`/`*_ids` column to any U2_DELETABLE_ENTITIES table, or to any table
// that references one, requires either a new entry here or a new entry in
// that test's ACCEPTED_NON_REFERENCES allowlist — the scanner fails loudly
// otherwise.
export const UNDO_REFERENCE_CHECKS = Object.freeze([
  // -- into cohorts --
  { fromTable: 'tiers', fromColumn: 'cohort_id', toEntity: 'cohorts', kind: 'scalar', enforced: true },
  { fromTable: 'time_blocks', fromColumn: 'cohort_id', toEntity: 'cohorts', kind: 'scalar', enforced: true },
  { fromTable: 'fixed_events', fromColumn: 'cohort_id', toEntity: 'cohorts', kind: 'scalar', enforced: true },
  // -- into tiers --
  { fromTable: 'groups', fromColumn: 'tier_id', toEntity: 'tiers', kind: 'scalar', enforced: false },
  { fromTable: 'activities', fromColumn: 'eligible_tier_ids', toEntity: 'tiers', kind: 'json_array', enforced: false },
  // v65 (T180) — a Recurring Event's DIVISION scope. Same shape and same integrity posture
  // as fixed_events.group_ids -> groups below: a JSON id-list with no DB-level FK, so
  // enforced:false. Division-scoped events are deliberately NOT given stronger integrity
  // than group-scoped ones — the consequence of deleting a tier is identical in kind to
  // deleting a group, and resolveFixedEventGroupIds (src/engine/fixedEventScope.js) resolves against
  // the LIVE group list, so a deleted division simply stops matching groups rather than
  // leaving a dangling pointer to chase.
  { fromTable: 'fixed_events', fromColumn: 'unit_ids', toEntity: 'tiers', kind: 'json_array', enforced: false },
  // T194 (v66): the age division a run targets, and the division an occurrence
  // belongs to. Both soft — no declared REFERENCES (schema.sql).
  { fromTable: 'elective_assignment_runs', fromColumn: 'tier_id', toEntity: 'tiers', kind: 'scalar', enforced: false },
  { fromTable: 'elective_occurrences', fromColumn: 'tier_id', toEntity: 'tiers', kind: 'scalar', enforced: false },
  // -- into groups --
  { fromTable: 'template_slots', fromColumn: 'group_id', toEntity: 'groups', kind: 'scalar', enforced: true },
  { fromTable: 'week_group_exclusions', fromColumn: 'group_id', toEntity: 'groups', kind: 'scalar', enforced: true },
  { fromTable: 'activities', fromColumn: 'eligible_group_ids', toEntity: 'groups', kind: 'json_array', enforced: false },
  { fromTable: 'fixed_events', fromColumn: 'group_ids', toEntity: 'groups', kind: 'json_array', enforced: false }, // 3rd Red Hat pass finding
  // v43 (docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md
  // Slice 3a) — elective_sets.group_ids mirrors fixed_events.group_ids
  // exactly: no DB-level FK (schema.sql), so enforced:false.
  { fromTable: 'elective_sets', fromColumn: 'group_ids', toEntity: 'groups', kind: 'json_array', enforced: false },
  // T194 (v66): a camper's group membership. Soft reference — schema.sql
  // declares no REFERENCES on campers.group_id, matching every other soft
  // group pointer in this schema — so enforced:false.
  { fromTable: 'campers', fromColumn: 'group_id', toEntity: 'groups', kind: 'scalar', enforced: false },
  // -- into activities --
  { fromTable: 'template_slots', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: true },
  { fromTable: 'week_activity_exclusions', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: true },
  { fromTable: 'activities', fromColumn: 'weather_alternative_id', toEntity: 'activities', kind: 'scalar', enforced: false }, // self-referential — see U2's batch-computation note
  // T194 (v66): both soft, no declared REFERENCES (schema.sql).
  { fromTable: 'elective_choice_offerings', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: false },
  { fromTable: 'elective_assignments', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: false },
  // v75 (T267, docs/adr/2026-09-26-fixed-recurring-event-identity-model.md) — the new soft link
  // replacing the by-name resolution src/engine/fixedEventActivityLink.js used. No DB REFERENCES
  // clause (schema.sql), matching elective_set_activities.activity_id's precedent below.
  { fromTable: 'fixed_events', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: false },
  // -- into days_of_operation --
  { fromTable: 'fixed_events', fromColumn: 'day_id', toEntity: 'days_of_operation', kind: 'scalar', enforced: true },
  { fromTable: 'template_slots', fromColumn: 'day_id', toEntity: 'days_of_operation', kind: 'scalar', enforced: false },
  // v43 (Slice 3a) — elective_sets.day_id mirrors fixed_events.day_id:
  // schema.sql declares `day_id TEXT REFERENCES days_of_operation(id)`, so
  // enforced:true.
  { fromTable: 'elective_sets', fromColumn: 'day_id', toEntity: 'days_of_operation', kind: 'scalar', enforced: true },
  // T194 (v66) — unlike elective_sets.day_id, schema.sql declares NO
  // REFERENCES on elective_occurrences.day_id (an occurrence is re-derived
  // from live template_slots on every generation, ADR D6), so enforced:false.
  { fromTable: 'elective_occurrences', fromColumn: 'day_id', toEntity: 'days_of_operation', kind: 'scalar', enforced: false },
  // -- into time_blocks --
  { fromTable: 'fixed_events', fromColumn: 'time_block_id', toEntity: 'time_blocks', kind: 'scalar', enforced: false },
  { fromTable: 'template_slots', fromColumn: 'time_block_id', toEntity: 'time_blocks', kind: 'scalar', enforced: false },
  { fromTable: 'elective_sets', fromColumn: 'time_block_id', toEntity: 'time_blocks', kind: 'scalar', enforced: false },
  { fromTable: 'elective_occurrences', fromColumn: 'time_block_id', toEntity: 'time_blocks', kind: 'scalar', enforced: false }, // T194 (v66), soft
  // -- into locations --
  { fromTable: 'activities', fromColumn: 'location_id', toEntity: 'locations', kind: 'scalar', enforced: false },
  { fromTable: 'week_location_exclusions', fromColumn: 'location_id', toEntity: 'locations', kind: 'scalar', enforced: false },
  // v45 (docs/work/specs/2026-08-23-slice4-engine-location-contention.md
  // §1/§6) — fixed_events.location_id and events.location_id mirror
  // activities.location_id exactly: no DB-level FK (schema.sql), so
  // enforced:false.
  { fromTable: 'fixed_events', fromColumn: 'location_id', toEntity: 'locations', kind: 'scalar', enforced: false },
  { fromTable: 'events', fromColumn: 'location_id', toEntity: 'locations', kind: 'scalar', enforced: false },
  // -- into fixed_events --
  { fromTable: 'template_slots', fromColumn: 'fixed_event_id', toEntity: 'fixed_events', kind: 'scalar', enforced: false }, // 3rd Red Hat pass finding: v17 ALTER-added column, missed by the original hand-search
  // T40 slice 1 (docs/work/specs/2026-08-20-special-days-data-shape-design.md):
  // special_day_slots.group_id/activity_id/location_id point at U2-deletable
  // entities (groups/activities/locations) the same soft way template_slots
  // does — no DB-level FK (schema.sql), so enforced:false, mirroring
  // template_slots.time_block_id / week_location_exclusions.location_id above.
  { fromTable: 'special_day_slots', fromColumn: 'group_id', toEntity: 'groups', kind: 'scalar', enforced: false },
  { fromTable: 'special_day_slots', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: false },
  { fromTable: 'special_day_slots', fromColumn: 'location_id', toEntity: 'locations', kind: 'scalar', enforced: false },
  // T41 slice 1 (docs/work/specs/2026-08-20-group-electives-design.md):
  // elective_set_activities.activity_id points at a U2-deletable entity
  // (activities) the same soft way special_day_slots.activity_id does — no
  // DB-level FK (schema.sql), so enforced:false. template_slots.elective_set_id
  // points at elective_sets, which — like special_days — is NOT in
  // U2_DELETABLE_ENTITIES below, so it is an ACCEPTED_NON_REFERENCE in the
  // schema-parity scanner (undoReferences.schemaParity.test.js), not an entry
  // here; deleteElectiveSet.js's own cascade handles its lifecycle directly.
  { fromTable: 'elective_set_activities', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: false },
  // T301 (v81) — linked elective bundles. Four incoming edges into U2-deletable
  // entities, all soft (no REFERENCES clause in schema.sql, so enforced:false
  // and an unchecked delete SILENTLY orphans rather than throwing).
  //
  // These are registered rather than accepted because every one of them points
  // at something a director can genuinely delete or undo an import of, and a
  // bundle left pointing at a deleted activity/day/period/division is a bundle
  // that can never be solved again while still rendering as authored. The
  // posture is `elective_set_activities.activity_id`'s exactly, one line up:
  // the bundle is a second, independent thing hanging off the same activity.
  //
  // The three remaining *_id columns on these tables are NOT here and are
  // accepted in the scanner instead: elective_bundles.elective_set_id points at
  // elective_sets, and both bundle_id columns point at elective_bundles —
  // none of the three is a U2-deletable entity.
  { fromTable: 'elective_bundles', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: false },
  { fromTable: 'elective_bundle_periods', fromColumn: 'day_id', toEntity: 'days_of_operation', kind: 'scalar', enforced: false },
  { fromTable: 'elective_bundle_periods', fromColumn: 'time_block_id', toEntity: 'time_blocks', kind: 'scalar', enforced: false },
  { fromTable: 'elective_bundle_tiers', fromColumn: 'tier_id', toEntity: 'tiers', kind: 'scalar', enforced: false },
  // Events internal sub-schedule Slice 2 (docs/adr/2026-08-22-event-
  // internal-subschedule.md §3): event_slots.event_group_id/activity_id/
  // location_id point at U2-deletable entities the same soft way
  // special_day_slots does — no DB-level FK (schema.sql), so enforced:false.
  // event_group_id points at event_groups, NOT the camp's groups — this is
  // the column that changed target relative to special_day_slots.group_id.
  { fromTable: 'event_slots', fromColumn: 'event_group_id', toEntity: 'event_groups', kind: 'scalar', enforced: false },
  { fromTable: 'event_slots', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: false },
  { fromTable: 'event_slots', fromColumn: 'location_id', toEntity: 'locations', kind: 'scalar', enforced: false },
  // T243 (v74, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md) —
  // elective_run_outer_snapshots' four U2-deletable-target columns. All soft: no DB-level
  // REFERENCES on any of them (schema.sql), same posture as elective_occurrences.day_id/
  // time_block_id and elective_assignments.activity_id above. run_id/camper_id are NOT here —
  // they point at elective_assignment_runs/campers, neither U2-deletable (see
  // undoReferences.schemaParity.test.js's ACCEPTED_NON_REFERENCES).
  { fromTable: 'elective_run_outer_snapshots', fromColumn: 'day_id', toEntity: 'days_of_operation', kind: 'scalar', enforced: false },
  { fromTable: 'elective_run_outer_snapshots', fromColumn: 'time_block_id', toEntity: 'time_blocks', kind: 'scalar', enforced: false },
  { fromTable: 'elective_run_outer_snapshots', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: false },
  { fromTable: 'elective_run_outer_snapshots', fromColumn: 'location_id', toEntity: 'locations', kind: 'scalar', enforced: false },
  // v76 (T197): choice_id is a soft reference to elective_choices, same posture as the four above.
  { fromTable: 'elective_run_outer_snapshots', fromColumn: 'choice_id', toEntity: 'elective_choices', kind: 'scalar', enforced: false },
  // T320 (v83, docs/adr/2026-09-30-elective-run-durability.md item 4) —
  // elective_run_findings.choice_id, same soft posture as
  // elective_run_outer_snapshots.choice_id directly above (this scanner's
  // model line, per the ADR). occurrence_id gets NO entry: elective_occurrences
  // appears only as a fromTable elsewhere in this registry, never as a
  // toEntity, so occurrence ids are outside this scanner's U2-deletable-target
  // set — verified by reading this file directly (T320 open question 3).
  // camper_id gets none either — no sibling elective table registers
  // camper_id as a soft U2 reference here.
  { fromTable: 'elective_run_findings', fromColumn: 'choice_id', toEntity: 'elective_choices', kind: 'scalar', enforced: false },
])

// entities U2's deletion slice is allowed to act on — deliberately mirrors
// the ADR's U2_DELETABLE_ENTITIES constant (electron/ops/ingest.js's
// INGESTIBLE_ENTITIES plus 'fixed_events'). Duplicated here rather than
// imported so this file has no dependency on ingest.js; the schema-parity
// test asserts the two never drift apart.
export const U2_DELETABLE_ENTITIES = Object.freeze(
  new Set(['cohorts', 'tiers', 'groups', 'days_of_operation', 'time_blocks', 'locations', 'activities', 'fixed_events'])
)

// Read-only single-hop referential check: does any LIVE row of fromTable
// currently reference `entityId` (scalar equality or json_array membership),
// excluding rows whose own (fromEntity, id) is in `excludeSet`? Returns the
// list of blocking rows (empty = safe to delete). No deletion happens here —
// this is the query U2's deletion slice will gate on; that slice does not
// exist yet in this cut.
//
// `excludeSet` is a Set of `${fromEntity}:${id}` strings — this is the
// two-pass batch exclusion the ADR specifies (Finding 4): a referencing row
// that is itself part of the same undo's deletion set does not count as a
// live blocker.
export function referencesInto(db, toEntity, entityId, excludeSet = new Set()) {
  const blockers = []
  for (const check of UNDO_REFERENCE_CHECKS) {
    if (check.toEntity !== toEntity) continue
    // Unindexed full-table scan, no camp_id filter/LIMIT — accepted: entity
    // ids are globally unique UUIDs, so a cross-camp scan is harmless for
    // correctness (a match can only ever belong to the same camp as
    // entityId), and result set is bounded by camp size in practice (this
    // runs once per undo, not on a hot path).
    const rows = db
      .prepare(`SELECT id, ${check.fromColumn} AS value FROM ${check.fromTable}`)
      .all()
    for (const row of rows) {
      if (row.value == null) continue
      const references =
        check.kind === 'scalar'
          ? row.value === entityId
          : jsonArrayContains(row.value, entityId)
      if (!references) continue
      if (excludeSet.has(`${entityFromTable(check.fromTable)}:${row.id}`)) continue
      blockers.push({ fromTable: check.fromTable, fromColumn: check.fromColumn, id: row.id })
    }
  }
  return blockers
}

function jsonArrayContains(rawValue, entityId) {
  let parsed
  try {
    parsed = JSON.parse(rawValue)
  } catch {
    return false
  }
  return Array.isArray(parsed) && parsed.includes(entityId)
}

// UNDO_REFERENCE_CHECKS' fromTable values are already entity names for every
// U2-deletable/referencing table in this registry (table name === entity
// name throughout this schema) — kept as a named indirection so a future
// entity whose table name diverges from its entity name doesn't require
// touching every call site of referencesInto.
function entityFromTable(table) {
  return table
}
