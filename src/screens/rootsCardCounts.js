import { activitiesListed, fixedEventsListed, timeBlocksListed } from './setupListSelectors'

// Audit I4 — a card's number is the row count of the screen it names, read
// through that screen's own selector (setupListSelectors.js). Activities is the
// free-choice catalogue (pinned-event rows excluded); Fixed Events is kind
// 'fixed' only (recurring rows have their own screen); Time Blocks replaced a
// "Days & Blocks" sum that matched neither the Days nor the Time Blocks screen.
const CARD_ROWS = {
  activities: (c, scope) => activitiesListed(c.activities, scope),
  fixed_events: (c, scope) => fixedEventsListed(c.fixed_events, { ...scope, kind: 'fixed' }),
  time_blocks: (c, scope) => timeBlocksListed(c.time_blocks, scope),
}

export function cardRows(collections, key, scope) {
  const select = CARD_ROWS[key]
  return select ? select(collections, scope) : (collections?.[key] ?? [])
}

// T304 — returns NULL, not 0, when the card's number could not be read.
//
// This used to return `0` for a collection that failed to load, so a camp with
// forty activities rendered "0 Activities" whenever the read failed — a
// confidently wrong number, which is worse than no number. `null` is what the
// header renders as an em dash instead.
//
// `count > 0` in countStyle is already false for null, so an unknown count
// correctly does not take the "rooted" styling — it is not a claim that the
// card is empty, and it must not read as a claim that it is full either.
const EMPTY_FAILED = new Set()

export function rootsCardCount(collections, key, scope, failed = EMPTY_FAILED) {
  if (!collections) return 0
  if (failed.has(key)) return null
  return cardRows(collections, key, scope).length
}
