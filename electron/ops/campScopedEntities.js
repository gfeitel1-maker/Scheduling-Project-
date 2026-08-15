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
// `camp_id` column at all), same as template_overlays/schedule_snapshots/
// day_override_template_slots. It is scoped via JOIN through
// schedule_templates, exactly like those three.
export const DIRECT_CAMP_ENTITIES = new Set([
  'groups',
  'tiers',
  'activities',
  'cohorts',
  'days_of_operation',
  'time_blocks',
  'anchor_activities',
  'schedule_templates',
  'day_override_templates',
  'schedule_weeks',
  'locations',
])

export const PARENT_SCOPED_ENTITIES = {
  template_slots: {
    table: 'template_slots',
    parentTable: 'schedule_templates',
    parentKey: 'template_id',
  },
  template_overlays: {
    table: 'template_overlays',
    parentTable: 'schedule_templates',
    parentKey: 'template_id',
  },
  schedule_snapshots: {
    table: 'schedule_snapshots',
    parentTable: 'schedule_templates',
    parentKey: 'template_id',
  },
  day_override_template_slots: {
    table: 'day_override_template_slots',
    parentTable: 'day_override_templates',
    parentKey: 'day_override_template_id',
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
}
