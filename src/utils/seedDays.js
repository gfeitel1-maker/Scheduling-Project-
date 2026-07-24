import { localClient } from '../localClient'

// Called once when a campId first becomes available.
// Seeds Monday-Friday rows into days_of_operation if any are missing or
// incomplete — mirrors ensureCohort's REQUIRED_FIELDS/isComplete/repair
// pattern (see src/utils/ensureCohort.js) rather than the original Supabase
// version's single atomic count-then-insert.
//
// Round 2 Red Hat fix (HIGH finding 1): the original Supabase seedDays()
// sent all 5 rows in one atomic `.insert([...])` call. The local-first port
// instead does field-by-field `localClient.write` calls, and
// electron/ops/projections.js's `days_of_operation.ensureExists` stamps
// camp_id on a row's very FIRST field write regardless of which field that
// is. So a crash/reload after even one row's first write left the old
// `days.some(d => d.camp_id === campId)` check permanently (and silently)
// satisfied, under-seeding the camp forever with no repair path. Fixed by
// checking each of the 5 expected weekdays individually for a complete row
// (matched by day_of_week, not a fresh id every call) and writing/repairing
// only what's missing — idempotent and safe on every mount, like
// ensureCohort.
//
// TODO: electron/db/schema.sql (~line 240) and electron/db/localDb.js
// (~line 436) both have stale comments claiming days_of_operation has a
// UNIQUE(camp_id, name)-style constraint. It does not (verified against the
// full migration history) — pre-existing, out of scope here, flagged for a
// future cleanup ticket.
const MON_FRI = [
  { label: 'Monday',    day_of_week: 1, sort_order: 1 },
  { label: 'Tuesday',   day_of_week: 2, sort_order: 2 },
  { label: 'Wednesday', day_of_week: 3, sort_order: 3 },
  { label: 'Thursday',  day_of_week: 4, sort_order: 4 },
  { label: 'Friday',    day_of_week: 5, sort_order: 5 },
]

const REQUIRED_FIELDS = ['label', 'day_of_week', 'sort_order']

function isComplete(row) {
  return REQUIRED_FIELDS.every((field) => row[field] != null && row[field] !== '')
}

export async function seedDays(campId) {
  const days = await localClient.list('days_of_operation')
  const mismatched = days.some((d) => d.camp_id !== campId)
  if (mismatched) {
    throw new Error(`seedDays: device camp does not match campId ${campId}`)
  }

  const token = localStorage.getItem('shoresh-token')
  for (const day of MON_FRI) {
    const existing = days.find((d) => d.day_of_week === day.day_of_week)
    if (existing && isComplete(existing)) continue

    const id = existing ? existing.id : crypto.randomUUID()
    const fields = existing
      ? Object.fromEntries(
          REQUIRED_FIELDS.filter((f) => existing[f] == null || existing[f] === '').map((f) => [f, day[f]])
        )
      : { label: day.label, day_of_week: day.day_of_week, sort_order: day.sort_order, camp_id: campId }

    for (const [field, value] of Object.entries(fields)) {
      await localClient.write(token, 'days_of_operation', id, field, value)
    }
  }
}
