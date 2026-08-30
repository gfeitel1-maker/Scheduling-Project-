// Shared camp-scoped entity registry — extracted from electron/main.js so
// that BOTH the renderer's read path (main.js's `list()` IPC handler) and
// the first-pairing full_sync snapshot (electron/sync/syncServer.js's
// sendFullSyncIfFirstPairing) are structurally guaranteed to cover the same
// table set. Before this extraction, syncServer.js would have needed a
// hand-written second copy of this list, which could silently drift from
// main.js's copy — see
// docs/superpowers/specs/2026-07-28-first-pairing-domain-sync-and-template-identity-design.md
// Part 1.
//
// `template_slots` is deliberately in the parent-scoped group, not the
// direct-camp_id group: per schema.sql it has only `template_id` (no
// `camp_id` column at all), same as schedule_snapshots.
// It is scoped via JOIN through schedule_templates, exactly like that one.
export const DIRECT_CAMP_ENTITIES = new Set([
  'groups',
  'tiers',
  'activities',
  'cohorts',
  'days_of_operation',
  'time_blocks',
  'anchor_activities',
  'schedule_templates',
  'schedule_weeks',
  'locations',
  'camp_maps',
  // T40 slice 1 (docs/work/specs/2026-08-20-special-days-data-shape-design.md):
  // the camp-scoped parent. Its two children (special_day_time_blocks,
  // special_day_slots) are parent-scoped by special_day_id, below.
  'special_days',
  // T41 slice 1 (docs/work/specs/2026-08-20-group-electives-design.md): the
  // camp-scoped parent. Its one child (elective_set_activities) is
  // parent-scoped by elective_set_id, below.
  'elective_sets',
  // T108 (day-overrides re-point, ADR 2026-08-21-day-overrides-repoint-
  // shape.md D1): direct-camp-scoped (camp_id NOT NULL), like schedule_weeks/
  // special_days, NOT parent-scoped through a join like
  // week_activity_exclusions (which has no camp_id column of its own).
  'day_overrides',
  // Events overlay placement Slice 1 (docs/adr/2026-08-22-events-overlay-
  // placement.md §1): camp-scoped, mirroring elective_sets exactly — no
  // children of its own (no offerings table in Slice 1).
  'events',
])

export const PARENT_SCOPED_ENTITIES = {
  template_slots: {
    table: 'template_slots',
    parentTable: 'schedule_templates',
    parentKey: 'template_id',
  },
  schedule_snapshots: {
    table: 'schedule_snapshots',
    parentTable: 'schedule_templates',
    parentKey: 'template_id',
  },
  week_activity_exclusions: {
    table: 'week_activity_exclusions',
    parentTable: 'schedule_weeks',
    parentKey: 'week_id',
  },
  week_group_exclusions: {
    table: 'week_group_exclusions',
    parentTable: 'schedule_weeks',
    parentKey: 'week_id',
  },
  week_location_exclusions: {
    table: 'week_location_exclusions',
    parentTable: 'schedule_weeks',
    parentKey: 'week_id',
  },
  // T40 slice 1: both of special_days' children, parent-scoped by
  // special_day_id (mirroring week_activity_exclusions above).
  special_day_time_blocks: {
    table: 'special_day_time_blocks',
    parentTable: 'special_days',
    parentKey: 'special_day_id',
  },
  special_day_slots: {
    table: 'special_day_slots',
    parentTable: 'special_days',
    parentKey: 'special_day_id',
  },
  // T41 slice 1: elective_sets' one child, parent-scoped by elective_set_id.
  elective_set_activities: {
    table: 'elective_set_activities',
    parentTable: 'elective_sets',
    parentKey: 'elective_set_id',
  },
  // Events internal sub-schedule Slice 2 (docs/adr/2026-08-22-event-
  // internal-subschedule.md): all three of events' children, parent-scoped
  // by event_id (mirroring special_day_time_blocks/special_day_slots above).
  event_time_blocks: {
    table: 'event_time_blocks',
    parentTable: 'events',
    parentKey: 'event_id',
  },
  event_groups: {
    table: 'event_groups',
    parentTable: 'events',
    parentKey: 'event_id',
  },
  event_slots: {
    table: 'event_slots',
    parentTable: 'events',
    parentKey: 'event_id',
  },
}

// T88 (C2, sync/auth audit): the camp-scoped entity set + FK-safe apply
// order for the first-pairing full_sync SNAPSHOT, single-sourced here so
// electron/sync/syncServer.js (send side) and electron/sync/syncClient.js
// (apply side) cannot drift the way they did before this ticket — the Host
// shipped week_location_exclusions rows (via DOMAIN_PARENT_SCOPED_ENTITIES)
// that a fresh Client silently dropped (its own hand-maintained
// DOMAIN_SNAPSHOT_TABLES never listed the table). Both files now import this
// array instead of re-declaring their own.
//
// Deliberately narrower than DIRECT_CAMP_ENTITIES ∪ PARENT_SCOPED_ENTITIES:
// `schedule_snapshots` is excluded (design doc Consequences: unbounded
// historical growth over a season).
//
// `schedule_weeks` WAS missing from an earlier draft of this list (it ships
// in the live full_sync message via DIRECT_CAMP_ENTITIES, but the Client's
// old hand-maintained manifest never applied it) — that turned out not to be
// a separate, ignorable gap: week_activity_exclusions/week_group_exclusions/
// week_location_exclusions all carry a NOT NULL FK to schedule_weeks.id, so
// under foreign_keys=ON a first-pairing Client cannot insert any of the three
// week_*_exclusions tables without schedule_weeks existing first. It is
// included here for exactly that reason, positioned before every table that
// references it.
//
// `foreign_keys = ON` (openLocalDb) makes this order load-bearing: a table
// must appear after every other table whose id it references.
export const DOMAIN_SNAPSHOT_ORDER = [
  'cohorts',
  'days_of_operation',
  'groups',
  'tiers', // references cohorts.id, nullable
  'time_blocks', // references cohorts.id, nullable
  'activities',
  'locations', // v32; references camps.id only. activities.location_id has NO DB-level FK, so order relative to activities is unconstrained.
  'camp_maps', // v33 (M6); references camps.id only, applied separately (unconditional) from this loop on the Client.
  'anchor_activities', // references cohorts.id/days_of_operation.id, both nullable
  'schedule_weeks', // references camps.id only; must precede schedule_templates and every week_*_exclusions table below, all of which reference it
  'day_overrides', // T108; references schedule_weeks.id/days_of_operation.id/groups.id, all NOT NULL — positioned after all three
  'schedule_templates', // references schedule_weeks.id, nullable
  'template_slots', // references groups.id/activities.id, both nullable — no declared FK to schedule_templates.id (schema.sql); elective_set_id (v35) also has no declared FK
  'week_activity_exclusions', // references schedule_weeks.id and activities.id, both NOT NULL
  'week_group_exclusions', // references schedule_weeks.id and groups.id, both NOT NULL
  'week_location_exclusions', // T88: references schedule_weeks.id (NOT NULL, no DB-level FK on this side); location_id has no declared FK
  'special_days', // T40 slice 1; references camps.id only
  'special_day_time_blocks', // references special_days.id NOT NULL
  'special_day_slots', // references special_days.id NOT NULL; group_id/time_block_id/activity_id/location_id have no declared FK
  'elective_sets', // T41 slice 1; references camps.id only
  'elective_set_activities', // references elective_sets.id NOT NULL; activity_id has no declared FK
  'events', // Events overlay placement Slice 1; references camps.id only
  'event_time_blocks', // Events internal sub-schedule Slice 2; references events.id NOT NULL
  'event_groups', // Events internal sub-schedule Slice 2; references events.id NOT NULL
  'event_slots', // Events internal sub-schedule Slice 2; references event_groups.id/event_time_blocks.id, both NOT NULL but no declared FK — positioned after both axis tables
]

// The subset of DOMAIN_SNAPSHOT_ORDER that is parent-scoped (joined through
// PARENT_SCOPED_ENTITIES rather than a direct camp_id column), in the same
// order — what syncServer.js iterates to build the send-side payload.
export const DOMAIN_PARENT_SCOPED_ENTITIES = DOMAIN_SNAPSHOT_ORDER.filter(
  (entity) => entity in PARENT_SCOPED_ENTITIES
)

// T88 review follow-up (Code Reviewer MEDIUM): syncServer.js's send side
// still iterates DIRECT_CAMP_ENTITIES directly for the non-parent-scoped
// half of full_sync, while DOMAIN_SNAPSHOT_ORDER re-types that same set as
// plain array entries so it can carry FK-order comments. Nothing previously
// enforced the two stayed equal — a table added to one and not the other
// would silently drift exactly like the bug this ticket fixes. This
// assertion (exported so campScopedEntities.test.js can exercise the throw
// path directly with synthetic input) makes that drift fail loudly at
// import time, in every environment that loads this module, instead of
// silently, the same way exclusionTables.migration.test.js et al. catch
// schema drift at migration time rather than at runtime.
export function assertDirectEntityParity(directEntities, snapshotOrder, parentScopedEntities) {
  const snapshotDirectEntities = new Set(
    snapshotOrder.filter((entity) => !(entity in parentScopedEntities))
  )
  for (const entity of directEntities) {
    if (!snapshotDirectEntities.has(entity)) {
      throw new Error(
        `campScopedEntities: DIRECT_CAMP_ENTITIES has '${entity}' but DOMAIN_SNAPSHOT_ORDER is missing it — a first-pairing Client would silently drop this table.`
      )
    }
  }
  for (const entity of snapshotDirectEntities) {
    if (!directEntities.has(entity)) {
      throw new Error(
        `campScopedEntities: DOMAIN_SNAPSHOT_ORDER lists '${entity}' as a direct (non-parent-scoped) entity, but it is not in DIRECT_CAMP_ENTITIES — the send side (syncServer.js) would never ship it.`
      )
    }
  }
}

assertDirectEntityParity(DIRECT_CAMP_ENTITIES, DOMAIN_SNAPSHOT_ORDER, PARENT_SCOPED_ENTITIES)
