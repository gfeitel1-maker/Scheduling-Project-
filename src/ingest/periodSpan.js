import { startMinutesForOrdering } from './orderTimeBlocks'

// A gap between periods is not a period.
//
// Importing one real camp file produced 15 "time blocks", two of which were
// five-minute slivers — "1:05-1:10", "11:45-11:50". The source names the same
// thing explicitly in other rows ("11:10-11:20 Change", "9:40-9:50 Change"):
// passing time between activities, which nobody schedules into. They arrived as
// first-class periods because the extractor's only test was "does this label
// start with a time".
//
// 10 minutes is the line, and the corpus picked the number rather than taste.
// The change-overs are 5 and 10 minutes ("11:10-11:20 Change", "9:40-9:50
// Change"). The shortest REAL period is campB's 15-minute "Group Time"
// (09:00-09:15) — a first pass set the threshold at 15 and silently deleted it,
// which is what moved the line down. 11-14 minutes is unclaimed by either side
// in this corpus; a period that short arriving from some future file is kept,
// because keeping a change-over is a nuisance and dropping a period is data
// loss. It is a named constant because it is a judgement about camp schedules,
// not a fact about time.
export const CHANGE_OVER_MAX_MINUTES = 10

const RANGE = /(\d{1,2}[:.]\d{2}(?:\s*[ap]\.?m\.?)?)\s*[-–—]\s*(\d{1,2}[:.]\d{2}(?:\s*[ap]\.?m\.?)?)/i

/**
 * True when a label describes a gap between periods rather than a period.
 *
 * A label whose span cannot be measured returns false: not knowing how long
 * something is is not evidence that it is short, and dropping a period on a
 * failed parse would lose real programme.
 */
export function isChangeOverSpan(label) {
  const match = String(label ?? '').match(RANGE)
  if (!match) return false

  // Reuse the camp-day reading so an afternoon range measures correctly and a
  // span crossing noon does not come out negative.
  const start = startMinutesForOrdering(match[1])
  const end = startMinutesForOrdering(match[2])
  if (start === null || end === null) return false

  const span = end - start
  if (span <= 0) return false
  return span <= CHANGE_OVER_MAX_MINUTES
}
