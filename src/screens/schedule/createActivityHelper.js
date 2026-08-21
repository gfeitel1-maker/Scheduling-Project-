import { normalizeName } from '../../ingest/preview.js'

// Extracted from useSlotMutations.js (T105) so the weekly createActivityFromCell,
// createElectiveFromCell's member-creation loop, and the T106 special-day adapter
// all mint activities through one path with byte-identical defaults. Usage-derived
// rule (min_per_week starts at 1 because this write IS the activity's first
// placement), max unlimited, all-groups eligible, human provenance free from
// repo.writeActivityFields' existing default.
export function newActivityDefaultFields(trimmedName, campId) {
  return {
    name: trimmedName,
    camp_id: campId,
    priority: null,
    is_locked: false,
    span_blocks: 1,
    location_id: null,
    is_outdoor: false,
    max_groups_per_slot: 1,
    min_per_week: 1,
    max_per_week: null,
    same_tier_only: false,
    eligible_tier_ids: [],
    eligible_group_ids: [],
    prefer_before_day: null,
    prefer_before_day_min: null,
    weather_alternative_id: null,
    notes: null,
  }
}

// `groupId` is accepted for interface parity with callers (a mint is always
// in service of placing an activity into a specific group's cell) but is not
// yet part of the written field set — mirrors the pre-extraction behavior.
export async function createActivity({ name, groupId, campId, activities }, repo) {
  const trimmed = String(name ?? '').trim()

  const dupe = (activities ?? []).find(a => normalizeName(a.name) === normalizeName(trimmed))
  if (dupe) {
    return { activityId: dupe.id, activity: dupe, isNew: false }
  }

  const newId = crypto.randomUUID()
  const fields = newActivityDefaultFields(trimmed, campId)
  await repo.writeActivityFields(newId, fields)
  const activity = { id: newId, ...fields }
  return { activityId: newId, activity, isNew: true }
}
