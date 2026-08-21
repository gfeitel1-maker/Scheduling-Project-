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

export function applyDayOverrides(slots, overridesForWeekDay) {
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
