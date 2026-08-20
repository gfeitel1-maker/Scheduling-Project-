// Named permission matrix for authorize() (electron/auth/authorize.js).
//
// Per docs/adr/2026-07-24-centralized-authorization-layer.md: action names
// are `<resource>.<verb>`, resource names match this repo's actual table
// names (DIRECT_CAMP_ENTITIES ∪ PARENT_SCOPED_ENTITIES from
// electron/ops/campScopedEntities.js, plus users/camps/devices/conflicts),
// not the design doc's shorthand (`schedule.*`) — those map onto
// `schedule_templates.*`/`schedule_snapshots.*`/`template_slots.*` here.
//
// ENTITIES below MUST stay equal to that union (minus any deliberate,
// documented admin-only exception) — an entity registered as camp-scoped but
// omitted here silently resolves to admin-only for staff via authorize()'s
// default-deny. That parity is guarded by
// electron/auth/permissionsEntityParity.test.js.
//
// Default-deny is enforced by authorize()'s lookup, not by this file listing
// every action for every role — PERMISSIONS.admin = ['*'] is shorthand for
// "every action", so only the staff array needs a deliberate per-action
// decision when a new entity/action is added.

export const ENTITIES = [
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
  'template_slots',
  'template_overlays',
  'schedule_snapshots',
  'day_override_template_slots',
  'week_activity_exclusions',
  'week_group_exclusions',
  // v32 (INV-3, docs/adr/2026-08-15-camp-locations-entity.md): locations is a
  // DIRECT_CAMP_ENTITY and week_location_exclusions is PARENT_SCOPED; both MUST
  // be here or they resolve to admin-only for staff via default-deny, so staff
  // could not read/write locations. Parity with
  // DIRECT_CAMP_ENTITIES ∪ PARENT_SCOPED_ENTITIES is guarded by
  // permissionsEntityParity.test.js (added by the gap-16 fix that also landed
  // week_activity_exclusions/week_group_exclusions above).
  'locations',
  'week_location_exclusions',
  // T40 slice 1 (docs/work/specs/2026-08-20-special-days-data-shape-design.md):
  // ordinary camp-scoped entities, staff read/write like every other camp
  // entity; delete/bulk_replace stay admin-only via default-deny (no explicit
  // staff grant below, matching every entity here except the deliberate
  // week_*_exclusions.delete/trash.read/camp_maps.read exceptions).
  'special_days',
  'special_day_time_blocks',
  'special_day_slots',
]

const staffReadWrite = ENTITIES.flatMap((entity) => [`${entity}.read`, `${entity}.write`])

export const PERMISSIONS = {
  admin: ['*'],
  staff: [
    ...staffReadWrite,
    'users.read',
    'devices.read',
    'conflicts.read',
    'conflicts.resolve',
    // Week-exclusion removal is a ROW DELETE, not a field write: excluded ==
    // "row exists", not-excluded == "row absent", so the toggle-off half of
    // scheduleRepository's toggleActivity/GroupExclusion routes through the
    // DELETE_FIELD sentinel and derives to '<entity>.delete' (deriveWriteAction).
    // These two are therefore granted explicitly to staff — without them, staff
    // could CHECK an exclusion box (a '.write') but never UNCHECK it. This is the
    // deliberate exception to "delete is admin-only": for a symmetric toggle whose
    // OFF state IS a delete, the delete is as ordinary as the write. It does NOT
    // generalize — deleting a group/activity/slot remains admin-only, and a
    // permanent WEEK delete is admin-only too: deleteWeekHandler
    // (electron/main.js) authorizes 'schedule_weeks.delete', which staff do NOT
    // hold, even though staff hold 'schedule_weeks.write' for create/edit/
    // duplicate. The pinned boundary lives in electron/auth/authorize.test.js
    // ("lets staff DELETE week-exclusion rows").
    'week_activity_exclusions.delete',
    'week_group_exclusions.delete',
    // week_location_exclusions.delete: the same deliberate exception, added
    // in M5 — without it, staff could CLOSE a place for a week but never
    // REOPEN it (toggle-off is a row delete, same as its two siblings above).
    'week_location_exclusions.delete',
    // Trash and per-record history are read-only and available to every
    // authenticated role: hiding "who changed this" from staff serves nobody
    // (docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md §6).
    // The matching '<entity>.restore' is deliberately ABSENT from this array,
    // which is what makes restore admin-only via admin: ['*'] — a restore is
    // as consequential as the delete it undoes, and must never derive to
    // '<entity>.write', which staff hold.
    'trash.read',
    // M6 (D6, docs/adr/2026-08-16-locations-optional-map.md): staff can READ
    // the camp map (Q7's whole point — it must be visible on staff tablets)
    // but NOT write it. `camp_maps` is deliberately absent from ENTITIES
    // (see PERMISSIONS_ADMIN_ONLY_EXCEPTIONS in permissionsEntityParity.test.js)
    // so staffReadWrite never derives `camp_maps.write` for staff — this is
    // the ONLY way to grant read without write, since ENTITIES derives both
    // together. Replacing the whole camp's background image is a different
    // blast radius than editing one place (locations.write, which staff keep
    // unchanged, including map_geometry — only the shared image is narrowed).
    'camp_maps.read',
  ],
  // devices.approve and devices.revoke are admin-only (via admin: ['*'])
  // devices.dev_authorize has been removed — superseded by devices.approve
}
