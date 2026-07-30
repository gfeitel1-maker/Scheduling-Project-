// Named permission matrix for authorize() (electron/auth/authorize.js).
//
// Per docs/adr/2026-07-24-centralized-authorization-layer.md: action names
// are `<resource>.<verb>`, resource names match this repo's actual table
// names (DIRECT_CAMP_ENTITIES ∪ PARENT_SCOPED_ENTITIES from electron/main.js,
// plus users/camps/devices/conflicts), not the design doc's shorthand
// (`schedule.*`) — those map onto `schedule_templates.*`/`schedule_snapshots.*`/
// `template_slots.*` here.
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
  'template_slots',
  'template_overlays',
  'schedule_snapshots',
  'day_override_template_slots',
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
    // Trash and per-record history are read-only and available to every
    // authenticated role: hiding "who changed this" from staff serves nobody
    // (docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md §6).
    // The matching '<entity>.restore' is deliberately ABSENT from this array,
    // which is what makes restore admin-only via admin: ['*'] — a restore is
    // as consequential as the delete it undoes, and must never derive to
    // '<entity>.write', which staff hold.
    'trash.read',
  ],
  // devices.approve and devices.revoke are admin-only (via admin: ['*'])
  // devices.dev_authorize has been removed — superseded by devices.approve
}
