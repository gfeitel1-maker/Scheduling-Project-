// T250 — the director-facing copy for a persisted elective run's Draft and
// Final screens, plus the small derivations behind it.
//
// Every string below is verbatim from docs/work/specs/2026-09-25-t250-run-state-surface.md
// ("Verbatim copy"), except the satisfaction summary, whose copy T250 owns and
// which the spec deliberately leaves alone.
import { buildPreferenceLookup } from './camperElectiveWeek.js'
// T318 round 2 — found as a FOURTH copy of the fabrication-proof predicate,
// this one NEGATED (see src/engine/rankKind.js's header). The negation made
// this copy the riskiest of the four: if the shared allow-list ever gains a
// third accepted kind, every OTHER copy gains it automatically while this one
// would have kept silently excluding it.
import { hasOrderingEvidence } from '../../../engine/rankKind.js'

// Q5 (director-facing terminology) was ruled by the owner 2026-09-29: "start a
// new version". "Revision" implies editing the same run, which contradicts
// the Q1/Q2 ruling that a finalized run is immutable and starting over
// produces a new run, not an edit of the old one. The constant name is kept
// as START_REVISION_LABEL so every caller stays untouched by this change.
export const START_REVISION_LABEL = 'Start a new version'

export const RELEASE_LOCK_LABEL = 'Release lock'

export const STALE_GENERATION_COPY =
  'This run was finalized before a later change on another device synced in. It is out of date.'

// "Name the occurrence (not just an id)" — the spec leaves the label format to
// whatever this screen's data already supports. `overCapacityOccurrences`
// carries occurrenceId + activityId; the activity name is always resolvable,
// the day/time block only when the caller passes occurrences that contain this
// one. Degrade by dropping detail, never by printing a raw id when a name
// exists.
//
// T318 FIXED both defects this comment used to describe. (a) `days_of_operation`
// stores its name in `label`, not `name` (electron/db/schema.sql) — the lookup
// below now reads `label ?? name`, the same both-ways read
// camperElectiveWeek.js's dayNameById already does for the same catalog,
// accepted because some callers pass catalogs shaped that way. (b) DraftRunView
// and FinalRunView now pass `state.occurrences` (the run's own persisted set,
// always present) to THIS function for their over-capacity rows, instead of the
// `templateOccurrences` prop, which is AssignmentPanel React state and empty
// for a run opened from the run list. The move dropdown still needs — and
// keeps — `templateOccurrences`, since it offers periods a camper can be moved
// TO, not periods an existing row already names.
export function occurrenceLabel({ occurrenceId, activityId, activities = [], occurrences = [], days = [], timeBlocks = [] }) {
  const activityName = activities.find((a) => a.id === activityId)?.name
  const occurrence = occurrences.find((o) => o.id === occurrenceId)
  const day = days.find((d) => d.id === occurrence?.day_id)
  const dayName = day?.label ?? day?.name
  const blockName = timeBlocks.find((t) => t.id === occurrence?.time_block_id)?.name
  const when = dayName && blockName ? `${dayName}, ${blockName}` : dayName || blockName || null
  const who = activityName || occurrenceId
  return when ? `${who} — ${when}` : who
}

export function overCapacityMessage({ label, filled, capacity }) {
  return `${label} has ${filled} ${filled === 1 ? 'camper' : 'campers'} assigned against a capacity of ${capacity}.`
}

export function danglingMessage({ camperName }) {
  return `${camperName}'s locked placement no longer matches this run — regenerating removed the occurrence it pointed to.`
}

export function stalenessOfferMessage({ staleCount }) {
  return `${staleCount} ${staleCount === 1 ? 'placement' : 'placements'} in this run came from an earlier version of this schedule.`
}

const RANK_WORDS = ['a first choice', 'a second choice', 'a third choice']

// Derived from the run's own assignment rows and nothing else. Deliberately
// silent about campers who were never placed: getElectiveRun returns
// assignments, and the camp-wide `campers` table is not run-scoped, so any
// "unplaced" count derived here would be a guess presented as a fact.
//
// T318 (c) — an object param, not a bare array, because reading `rank_kind`
// needs the same assignment-to-preference join camperElectiveWeek.js's
// buildPreferenceLookup already does (occurrences/days/timeBlocks are what that
// join binds a coordinate-only preference against). A rank with no positively-
// ordered preference behind it — 'unordered-set', a null kind, or a row that
// cannot be joined at all — moves into the `unordered` bucket instead of a
// numbered one, per the same fabrication-proof rule rankLabel enforces.
export function satisfactionSummary({ rows = [], preferences = [], occurrences = [], days = [], timeBlocks = [] } = {}) {
  const occurrenceCount = new Set(rows.map((r) => r.occurrence_id)).size
  const preferenceFor = buildPreferenceLookup({ preferences, occurrences, days, timeBlocks })
  const buckets = [0, 0, 0, 0] // first, second, third, lower
  let outside = 0
  let unordered = 0
  for (const row of rows) {
    const rank = row.preference_rank
    if (rank == null) {
      outside += 1
      continue
    }
    const rankKind = preferenceFor(row)?.rankKind ?? null
    if (!hasOrderingEvidence(rankKind)) {
      unordered += 1
    } else if (rank >= 1 && rank <= 3) {
      buckets[rank - 1] += 1
    } else {
      buckets[3] += 1
    }
  }

  const parts = []
  buckets.forEach((count, i) => {
    if (count > 0) parts.push(`${count} ${i < 3 ? RANK_WORDS[i] : 'a lower choice'}`)
  })
  if (unordered > 0) parts.push(`${unordered} one of their choices`)
  if (outside > 0) parts.push(`${outside} placed outside their preferences`)
  // "got" attaches to whichever clause comes first, so a run where nobody got
  // a first choice still reads as a sentence.
  if (parts.length > 0) parts[0] = parts[0].replace(/^(\d+) /, '$1 got ')

  const placed = `${rows.length} ${rows.length === 1 ? 'camper' : 'campers'} placed across ${occurrenceCount} ${occurrenceCount === 1 ? 'occurrence' : 'occurrences'}.`
  return parts.length > 0 ? `${placed} ${parts.join(', ')}.` : placed
}
