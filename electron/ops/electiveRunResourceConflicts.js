// Live resource-conflict computation for an elective run (T320, docs/adr/
// 2026-09-30-elective-run-durability.md item 4) — extracted from
// finalizeElectiveRun.js step 2, which used to have this scoping logic
// inline. Shared by finalizeElectiveRun.js (its own hard-refusal gate,
// unchanged behaviour) and getElectiveRun.js (a NEW draft-run live read,
// making OUTER_RESOURCE_CONFLICT visible before finalize for the first
// time).
//
// Maps a raw template_slots row into the shape findRouteConflicts/buildSchedule
// expect (src/engine/routeConflicts.js), keyed off the same mutually-exclusive
// column group projections.js already enforces (elective_set_id / event_id /
// is_fixed_event+fixed_event_id / activity_id).
import { findRouteConflicts } from '../../src/engine/routeConflicts.js'

function mapTemplateSlot(row) {
  const base = { groupId: row.group_id, cohort_id: null, dayId: row.day_id, blockId: row.time_block_id }
  if (row.elective_set_id != null) return { ...base, type: 'elective', electiveSetId: row.elective_set_id }
  if (row.event_id != null) return { ...base, type: 'event', eventId: row.event_id }
  if (row.is_fixed_event) return { ...base, type: 'fixed_event', fixedEventId: row.fixed_event_id }
  if (row.activity_id != null) return { ...base, type: 'activity', activityId: row.activity_id }
  return { ...base, type: null }
}

// `recordedOccurrences` — the run's occurrence rows (day_id/time_block_id) to
// scope the conflict check to. Callers pass either the run's freshly-recorded
// occurrences (finalize, pre-write) or its currently-live ones (a draft read).
export function computeElectiveRunResourceConflicts(db, run, recordedOccurrences) {
  const cellKeys = new Set(recordedOccurrences.map((o) => `${o.day_id}|${o.time_block_id}`))
  const scopedSlots = []
  if (run.schedule_template_id != null) {
    const rows = db.prepare('SELECT * FROM template_slots WHERE template_id = ?').all(run.schedule_template_id)
    for (const row of rows) {
      if (cellKeys.has(`${row.day_id}|${row.time_block_id}`)) scopedSlots.push(mapTemplateSlot(row))
    }
  }
  return findRouteConflicts({
    slots: scopedSlots,
    activities: db.prepare('SELECT * FROM activities').all(),
    anchors: db.prepare('SELECT * FROM fixed_events').all(),
    electiveSetActivities: db.prepare('SELECT * FROM elective_set_activities').all(),
    events: db.prepare('SELECT * FROM events').all(),
    locations: db.prepare('SELECT * FROM locations').all(),
  })
}
