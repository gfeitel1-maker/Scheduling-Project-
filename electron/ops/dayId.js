// Pure, dependency-free id derivation for `days_of_operation` rows, following
// the same reasoning as electron/ops/scheduleTemplateId.js and
// electron/ops/locationId.js: two devices that independently mint a weekday
// row for the same brand-new camp (Host's un-awaited seedDays racing an
// immediate second-device invite — see T205) must mint the SAME id, or the
// Automerge document ends up with two records for the same weekday that never
// converge into one.
//
// campId is a randomUUID (no colons), so `day:${campId}:${dayOfWeek}` is
// unambiguous to parse back apart — mirrors the `location:${campId}:${name}`
// precedent's reasoning about the campId segment.
//
// Deterministic only for MINTING a row that doesn't exist yet — exactly like
// deriveLocationId/deriveScheduleTemplateId, this does not guarantee an
// EXISTING row carries this id (a pre-T205 row may still hold a
// crypto.randomUUID()). Callers resolve an existing row by day_of_week, not
// by re-deriving this id.
export function deriveDayId(campId, dayOfWeek) {
  return `day:${campId}:${dayOfWeek}`
}

// Inverse of deriveDayId: recovers the weekday number a deterministic day id
// encodes, or null if `id` isn't one (a legacy crypto.randomUUID() row, or
// anything else unexpected). Callers MUST treat null as "fall back to
// existing behavior" rather than throw — T205 defect 1 was exactly a crash-
// shaped hole opened by an over-strict assumption about id shape.
export function parseDayOfWeek(id) {
  if (typeof id !== 'string') return null
  const match = id.match(/^day:.+:(-?\d+)$/)
  if (!match) return null
  return Number.parseInt(match[1], 10)
}
