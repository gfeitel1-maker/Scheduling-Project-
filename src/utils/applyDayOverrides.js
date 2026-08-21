// applyDayOverrides — T108 (Day-Overrides re-point), pure render-time
// composition stage. Precedent: computeWeekClosures.js/withWeekClosureFlags,
// withOverlapFlags — same "slots-in/slots-out, no IPC, no React" shape.
//
// Composition order (ADR D4, design §5): callers must run this BEFORE
// withWeekClosureFlags/withOverlapFlags, so those flags evaluate the
// POST-override content. This function only performs the diff; it does not
// itself compose with other flag stages.
//
// Span refusal (design §6.2, ADR D1's per-block grain): a span is logically
// ONE session, so an override on a span head or tail is scoped out for v1
// and silently ignored at render time — reuses gridGeometry.js's
// isActivityTail rather than inventing a second span-detection predicate.
import { isActivityTail } from '../screens/schedule/gridGeometry.js'

// `weekId` (T108 Phase 2 review round 2, LOW #6) is optional defense-in-depth,
// not the primary correctness mechanism: template_slots rows carry no
// schedule_week_id of their own (they're keyed by template_id, which resolves
// to a week via schedule_templates.week_id, not present on a slot row), so
// this can only be checked against the OVERRIDE's own schedule_week_id, not
// cross-referenced against the row. Today the caller (ScheduleScreen's slots
// pipe) already pre-filters `overridesForWeekDay` to one week via
// useScheduleData's loadDayOverridesForWeek(weekId) — this parameter guards
// against a future caller that forgets to, rather than replacing that
// pre-filter. Omitted (undefined), it's a no-op — every override matches on
// week the same as before.
export function applyDayOverrides(slots, overridesForWeekDay, weekId) {
  if (!overridesForWeekDay || overridesForWeekDay.length === 0) return slots

  let changed = false
  const next = slots.map((row) => {
    // day_id is part of the match, not just group_id/time_block_id: the
    // group view renders every day as its own column in one pass (design §5.1
    // — "columns are days"), so the whole week's overrides are composed in
    // one call here. Without day_id in the predicate, a day-3 override would
    // incorrectly also match the same group+block cell on day 1/2/4/5.
    const match = overridesForWeekDay.find(
      (o) => o.group_id === row.group_id && o.time_block_id === row.time_block_id && o.day_id === row.day_id
        && (weekId == null || o.schedule_week_id === weekId)
    )
    if (!match) return row

    // Span refusal: never rewrite a span head or a span tail.
    if (row.is_span_head === true) return row
    if (isActivityTail(slots, row.group_id, row.day_id, row.time_block_id)) return row

    changed = true
    if (match.kind === 'pull') {
      return {
        ...row,
        activity_id: null,
        is_pull: true,
        is_overridden: true,
        day_override_id: match.id,
      }
    }
    // swap
    return {
      ...row,
      activity_id: match.activity_id,
      is_overridden: true,
      day_override_id: match.id,
    }
  })

  return changed ? next : slots
}
