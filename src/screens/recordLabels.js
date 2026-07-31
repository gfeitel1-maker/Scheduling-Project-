// Plain words for the things the op log names in table terms. A director is
// not a software operator (CONSTITUTION Art. V): they never see `tier_id`,
// `days_of_operation`, or a bare uuid.
//
// Shared by the Trash screen and the record-history panel so the two cannot
// describe the same record differently.

export const ENTITY_LABEL = {
  cohorts: 'Program',
  tiers: 'Unit',
  groups: 'Group',
  activities: 'Activity',
  days_of_operation: 'Day',
  time_blocks: 'Time block',
  anchor_activities: 'Fixed event',
  day_override_templates: 'Day override',
}

export function entityLabel(entity) {
  return ENTITY_LABEL[entity] ?? entity
}

// Field labels match the wording of the edit forms, never the column name.
const FIELD_LABEL = {
  name: 'Name',
  label: 'Name',
  camp_id: 'Camp',
  tier_id: 'Unit',
  cohort_id: 'Program',
  day_id: 'Day',
  time_block_id: 'Time block',
  activity_id: 'Activity',
  availability: 'Availability',
  sort_order: 'Order',
  location: 'Location',
  is_outdoor: 'Outdoors',
  max_groups_per_slot: 'Groups per slot',
  min_per_week: 'Fewest per week',
  max_per_week: 'Most per week',
  same_tier_only: 'Same unit only',
  priority: 'Priority',
  eligible_tier_ids: 'Eligible units',
  eligible_group_ids: 'Eligible groups',
  prefer_before_day: 'Preferred by day',
  prefer_before_day_min: 'Preferred by day, fewest',
  weather_alternative_id: 'Wet-weather alternative',
  notes: 'Notes',
  span_blocks: 'Length in blocks',
  start_time: 'Start',
  end_time: 'End',
  part_of_day: 'Part of day',
  day_of_week: 'Day of the week',
  session_week_start: 'Session starts',
  session_week_end: 'Session ends',
  capacity_source: 'Capacity from',
  anchor_model: 'Fixed-event model',
  frequency_mode: 'Frequency',
  is_all_groups: 'Every group',
  group_ids: 'Groups',
  pin_hash: 'PIN',
  pin_salt: 'PIN',
  role: 'Role',
}

// Which entity a foreign-key field points at, so a history line can read
// "changed Unit from Aleph to Bet" rather than showing two uuids.
export const FK_TARGET = {
  tier_id: 'tiers',
  cohort_id: 'cohorts',
  day_id: 'days_of_operation',
  time_block_id: 'time_blocks',
  activity_id: 'activities',
  weather_alternative_id: 'activities',
}

export function fieldLabel(field) {
  if (field === '__deleted__') return 'Deleted'
  if (field === '__bulk_replace__') return 'Replaced in bulk'
  return FIELD_LABEL[field] ?? field.replace(/_/g, ' ')
}

// The op log records a moment; a director reads a day and a time.
export function formatMoment(timestamp) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// T24 — what did NOT come back, said at the moment the director is checking.
//
// The delete confirmation already says this, but restore is when they are
// actually looking to see whether their work survived. Saying it once, months
// earlier, is not saying it here. Restoring gives back the record and nothing
// else (docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md §3), and
// the expectation that undo restores everything is the default assumption, not
// an unusual one.
//
// A trash row carries no slot count, so these have to be true whether or not
// the record was ever placed — hence "any cells", not "the 30 cells".
const RESTORE_CAVEAT = {
  activities:
    'It is not back on the schedule, though — any cells it was cleared from are still empty.',
  groups:
    'Its week did not come back with it, though. You can bring that back from Versions on the Schedule screen.',
  days_of_operation:
    'What was scheduled on it did not come back, though. You can bring that back from Versions on the Schedule screen.',
}

export function restoreCaveat(entity) {
  return RESTORE_CAVEAT[entity] ?? null
}
