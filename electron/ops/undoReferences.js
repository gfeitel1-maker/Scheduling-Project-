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
  { fromTable: 'anchor_activities', fromColumn: 'cohort_id', toEntity: 'cohorts', kind: 'scalar', enforced: true },
  { fromTable: 'day_override_templates', fromColumn: 'cohort_id', toEntity: 'cohorts', kind: 'scalar', enforced: true },
  // -- into tiers --
  { fromTable: 'groups', fromColumn: 'tier_id', toEntity: 'tiers', kind: 'scalar', enforced: false },
  { fromTable: 'activities', fromColumn: 'eligible_tier_ids', toEntity: 'tiers', kind: 'json_array', enforced: false },
  { fromTable: 'template_overlays', fromColumn: 'unit_id', toEntity: 'tiers', kind: 'scalar', enforced: false }, // 3rd Red Hat pass finding
  // -- into groups --
  { fromTable: 'template_slots', fromColumn: 'group_id', toEntity: 'groups', kind: 'scalar', enforced: true },
  { fromTable: 'week_group_exclusions', fromColumn: 'group_id', toEntity: 'groups', kind: 'scalar', enforced: true },
  { fromTable: 'activities', fromColumn: 'eligible_group_ids', toEntity: 'groups', kind: 'json_array', enforced: false },
  { fromTable: 'anchor_activities', fromColumn: 'group_ids', toEntity: 'groups', kind: 'json_array', enforced: false }, // 3rd Red Hat pass finding
  // T108 Phase 2 review round 3 — day_overrides is the live entity
  // (day_override_templates above is the retired predecessor). group_id and
  // day_id both carry a DB-level REFERENCES clause (schema.sql), so
  // enforced:true, same as anchor_activities' equivalents just above.
  { fromTable: 'day_overrides', fromColumn: 'group_id', toEntity: 'groups', kind: 'scalar', enforced: true },
  // v43 (docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md
  // Slice 3a) — elective_sets.group_ids mirrors anchor_activities.group_ids
  // exactly: no DB-level FK (schema.sql), so enforced:false.
  { fromTable: 'elective_sets', fromColumn: 'group_ids', toEntity: 'groups', kind: 'json_array', enforced: false },
  // -- into activities --
  { fromTable: 'template_slots', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: true },
  { fromTable: 'week_activity_exclusions', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: true },
  { fromTable: 'day_override_template_slots', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: false },
  { fromTable: 'activities', fromColumn: 'weather_alternative_id', toEntity: 'activities', kind: 'scalar', enforced: false }, // self-referential — see U2's batch-computation note
  // T108 Phase 2 review round 3 — day_overrides.activity_id is nullable (a
  // PULL override has no activity) but DOES carry a DB-level REFERENCES
  // clause when set (schema.sql), so enforced:true.
  { fromTable: 'day_overrides', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: true },
  // -- into days_of_operation --
  { fromTable: 'anchor_activities', fromColumn: 'day_id', toEntity: 'days_of_operation', kind: 'scalar', enforced: true },
  { fromTable: 'template_overlays', fromColumn: 'day_id', toEntity: 'days_of_operation', kind: 'scalar', enforced: true },
  { fromTable: 'template_slots', fromColumn: 'day_id', toEntity: 'days_of_operation', kind: 'scalar', enforced: false },
  { fromTable: 'day_overrides', fromColumn: 'day_id', toEntity: 'days_of_operation', kind: 'scalar', enforced: true }, // T108 Phase 2 review round 3
  // v43 (Slice 3a) — elective_sets.day_id mirrors anchor_activities.day_id:
  // schema.sql declares `day_id TEXT REFERENCES days_of_operation(id)`, so
  // enforced:true.
  { fromTable: 'elective_sets', fromColumn: 'day_id', toEntity: 'days_of_operation', kind: 'scalar', enforced: true },
  // -- into time_blocks --
  { fromTable: 'anchor_activities', fromColumn: 'time_block_id', toEntity: 'time_blocks', kind: 'scalar', enforced: false },
  { fromTable: 'template_slots', fromColumn: 'time_block_id', toEntity: 'time_blocks', kind: 'scalar', enforced: false },
  { fromTable: 'day_override_template_slots', fromColumn: 'time_block_id', toEntity: 'time_blocks', kind: 'scalar', enforced: false },
  // T108 Phase 2 review round 3 — day_overrides.time_block_id has NO
  // DB-level REFERENCES clause (schema.sql: plain TEXT NOT NULL), same
  // convention-only pointer as template_slots.time_block_id above.
  { fromTable: 'day_overrides', fromColumn: 'time_block_id', toEntity: 'time_blocks', kind: 'scalar', enforced: false },
  // v43 (Slice 3a) — elective_sets.time_block_id mirrors
  // anchor_activities.time_block_id exactly: NO REFERENCES clause, so
  // enforced:false.
  { fromTable: 'elective_sets', fromColumn: 'time_block_id', toEntity: 'time_blocks', kind: 'scalar', enforced: false },
  // -- into locations --
  { fromTable: 'activities', fromColumn: 'location_id', toEntity: 'locations', kind: 'scalar', enforced: false },
  { fromTable: 'week_location_exclusions', fromColumn: 'location_id', toEntity: 'locations', kind: 'scalar', enforced: false },
  // v45 (docs/work/specs/2026-08-23-slice4-engine-location-contention.md
  // §1/§6) — anchor_activities.location_id and events.location_id mirror
  // activities.location_id exactly: no DB-level FK (schema.sql), so
  // enforced:false.
  { fromTable: 'anchor_activities', fromColumn: 'location_id', toEntity: 'locations', kind: 'scalar', enforced: false },
  { fromTable: 'events', fromColumn: 'location_id', toEntity: 'locations', kind: 'scalar', enforced: false },
  // -- into anchor_activities --
  { fromTable: 'template_slots', fromColumn: 'anchor_id', toEntity: 'anchor_activities', kind: 'scalar', enforced: false }, // 3rd Red Hat pass finding: v17 ALTER-added column, missed by the original hand-search
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
  // Events internal sub-schedule Slice 2 (docs/adr/2026-08-22-event-
  // internal-subschedule.md §3): event_slots.event_group_id/activity_id/
  // location_id point at U2-deletable entities the same soft way
  // special_day_slots does — no DB-level FK (schema.sql), so enforced:false.
  // event_group_id points at event_groups, NOT the camp's groups — this is
  // the column that changed target relative to special_day_slots.group_id.
  { fromTable: 'event_slots', fromColumn: 'event_group_id', toEntity: 'event_groups', kind: 'scalar', enforced: false },
  { fromTable: 'event_slots', fromColumn: 'activity_id', toEntity: 'activities', kind: 'scalar', enforced: false },
  { fromTable: 'event_slots', fromColumn: 'location_id', toEntity: 'locations', kind: 'scalar', enforced: false },
])

// entities U2's deletion slice is allowed to act on — deliberately mirrors
// the ADR's U2_DELETABLE_ENTITIES constant (electron/ops/ingest.js's
// INGESTIBLE_ENTITIES plus 'anchor_activities'). Duplicated here rather than
// imported so this file has no dependency on ingest.js; the schema-parity
// test asserts the two never drift apart.
export const U2_DELETABLE_ENTITIES = Object.freeze(
  new Set(['cohorts', 'tiers', 'groups', 'days_of_operation', 'time_blocks', 'locations', 'activities', 'anchor_activities'])
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
