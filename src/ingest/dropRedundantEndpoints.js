import { startMinutesForOrdering } from './orderTimeBlocks.js'

// Drop a one-ended period when the range it is an endpoint of already exists.
//
// Splitting a blank-line block into its real periods (T140) recovers periods
// that used to be lost, but it also leaves fragments behind: campA's pages wrap
// their labels in three different shapes, and the shapes this does not model
// yet produce a block with only a start time — "11:10", "12:30", "3:05".
//
// They are not new information. Every one of campA's eight fragments is an
// endpoint of a range the split now produces:
//
//     9:50, 10:25  ->  9:50-10:25        12:25  ->  11:50-12:25
//     11:10, 11:45 ->  11:10-11:45       12:30  ->  12:30-1:05
//     1:45         ->  1:10-1:45         3:05   ->  2:30-3:05
//
// So the fragment is the same period, named by one end, and dropping it cannot
// lose anything. That is the whole rule, and it is deliberately narrow: a
// one-ended block whose time matches NO range is kept, because there it may be
// the only trace of a real period. campC keeps "03:25" and "04:00" for exactly
// that reason and loses only "02:40", which its "02:40-03:20" already covers.
//
// Matching is by MINUTE, not by string, so "1:45" and "01:45" are the same
// endpoint — the corpus writes both.

const RANGE = /^(\d{1,2}[:.]\d{2})\s*[-–—]\s*(\d{1,2}[:.]\d{2})$/

/**
 * @param labels time-block labels, already ordered
 * @returns the same list minus one-ended blocks whose time is an endpoint of a
 *          range in that list
 */
export function dropRedundantEndpoints(labels = []) {
  const endpoints = new Set()
  for (const label of labels) {
    const match = String(label ?? '').match(RANGE)
    if (!match) continue
    for (const side of [match[1], match[2]]) {
      const minutes = startMinutesForOrdering(side)
      if (minutes !== null) endpoints.add(minutes)
    }
  }
  if (endpoints.size === 0) return labels

  return labels.filter((label) => {
    if (RANGE.test(String(label ?? '').trim())) return true
    const minutes = startMinutesForOrdering(label)
    // A label carrying no readable time is a named period ("Block 2") and is
    // never an endpoint of anything — keep it.
    if (minutes === null) return true
    return !endpoints.has(minutes)
  })
}
