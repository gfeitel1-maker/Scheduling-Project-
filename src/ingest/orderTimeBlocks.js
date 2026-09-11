// Put a file's time-block labels into the order the camp day actually runs.
//
// Why this exists: a real camp file (docs/work/specs/samples/campA-bunk-
// schedules.txt) lists its periods out of order — "3:15-3:40" appears in the
// grid before "12:30". Import used to assign `sort_order` from the row's
// position in the file (buildPlan.js `fieldsFor`), so the schedule rendered a
// day as 9:15 → 11:50 → 3:15 → 12:30 → 1:05 → 11:45. A day out of time order
// is not a schedule.
//
// Ordering has to happen HERE, where extractEntities finalizes the entity list,
// rather than in buildPlan: buildPlan's `index` is deliberately the raw
// position in the approved array so it stays in lockstep with commitIngest's
// forEach (see buildPlan.js's comment above `names.forEach`). Sorting the list
// once, at the point both consumers read it, keeps them aligned and keeps
// `sort_order` a dense sequence — which `gridGeometry.computeSpanCellProps`
// depends on when it looks for `sort_order + 1`.
//
// This module decides ORDER ONLY. It does not rewrite the `start_time` a block
// is stored with; that value is still whatever `parseTimeRange` read literally.
// Those two can disagree for an afternoon block written in bare 12-hour form,
// and resolving that is a separate question about what a stored time means —
// see `parseGridSchedule.js`, which deliberately refuses to guess a meridiem
// for absolute times because an earlier version silently inverted PM.

// Explicit meridiem on either side of the label ("3:15pm-3:40pm").
const MERIDIEM = /(\d{1,2})[:.](\d{2})\s*([ap])\.?m\.?/i
// First "h:mm" in the label, which is the block's start.
const FIRST_TIME = /(\d{1,2})[:.](\d{2})/

// The camp-day rule, stated rather than inferred.
//
// A running-clock reading (each block must come after the last) cannot work,
// because the source file is itself out of order — the clock would have to run
// backwards to read it. So a bare 12-hour hour is resolved against the shape of
// a camp day instead:
//
//   1–6   afternoon  — a camp period at 1:05 is after lunch, not before dawn
//   7–11  morning
//   12    noon
//
// 7 is the boundary because a 7:30 breakfast is ordinary and a 7:30pm period is
// not, for a day camp. A camp running evening programming would need this
// revisited, which is why the number is named here rather than buried.
//
// A LEADING ZERO MEANS NOTHING HERE, and that is not an oversight. The first
// version of this file treated "03:15" as 24-hour, borrowing the reasoning in
// parseGridSchedule.js ("nobody writes that for 12-hour AM/PM"). The repo's own
// second sample disproves it: campB-by-day.txt is zero-padded 12-hour from top
// to bottom — 08:40, 09:00 … 12:55, then 01:40, 02:25, 03:20 — where 01:40 is
// plainly after lunch. Honouring the leading zero sorted that camp's whole
// afternoon before its breakfast. Only an hour >= 13 is unambiguous notation.
const MORNING_MIN_HOUR = 7

/**
 * The minute-of-day a label should SORT at, or null when it carries no time.
 * Exported for its own tests: the camp-day rule is the load-bearing judgement
 * in this module and deserves to be pinned directly.
 */
export function startMinutesForOrdering(label) {
  const text = String(label ?? '')

  const explicit = text.match(MERIDIEM)
  if (explicit) {
    const hour12 = Number(explicit[1]) % 12
    const pm = explicit[3].toLowerCase() === 'p'
    return (pm ? hour12 + 12 : hour12) * 60 + Number(explicit[2])
  }

  const match = text.match(FIRST_TIME)
  if (!match) return null

  const hour = Number(match[1])
  const minutes = Number(match[2])
  if (hour > 23 || minutes > 59) return null

  // An hour past noon can only be 24-hour notation; nothing else is unambiguous.
  if (hour >= 13) return hour * 60 + minutes

  const resolvedHour = hour >= MORNING_MIN_HOUR || hour === 12 || hour === 0
    ? hour
    : hour + 12
  return resolvedHour * 60 + minutes
}

/**
 * Chronological order, stable. Labels carrying no readable time keep their
 * original relative order and sit after the timed ones — they are named periods
 * ("Block 2"), and dropping or interleaving them would lose information the
 * file actually carried.
 */
export function orderTimeBlocks(labels) {
  return labels
    .map((label, index) => ({ label, index, minutes: startMinutesForOrdering(label) }))
    .sort((a, b) => {
      if (a.minutes === null && b.minutes === null) return a.index - b.index
      if (a.minutes === null) return 1
      if (b.minutes === null) return -1
      return a.minutes - b.minutes || a.index - b.index
    })
    .map((entry) => entry.label)
}
