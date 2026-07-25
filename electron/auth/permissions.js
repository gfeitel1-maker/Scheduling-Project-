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
  ],
}
