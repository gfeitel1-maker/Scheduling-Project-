// T250 — the director-facing copy for a persisted elective run's Draft and
// Final screens, plus the small derivations behind it.
//
// Every string below is verbatim from docs/work/specs/2026-09-25-t250-run-state-surface.md
// ("Verbatim copy"), except the satisfaction summary, whose copy T250 owns and
// which the spec deliberately leaves alone.

// Q5 (director-facing terminology) is STILL OPEN with the owner. The spec's
// Designer recommendation is "Start a new version" — "revision" implies editing
// the same thing, which is the opposite of what Q1/Q2 ruled (immutable run, no
// reopen, a fresh run). Until the owner says yes, the existing wording ships.
// It lives here, once, so that answer is a one-line change.
export const START_REVISION_LABEL = 'Start a revision'

export const RELEASE_LOCK_LABEL = 'Release lock'

export const STALE_GENERATION_COPY =
  'This run was finalized before a later change on another device synced in. It is out of date.'

// "Name the occurrence (not just an id)" — the spec leaves the label format to
// whatever this screen's data already supports. `overCapacityOccurrences`
// carries occurrenceId + activityId; the activity name is always resolvable,
// the day/time block only when the caller has the run's occurrences in hand
// (it does for the run it just solved, not for one opened cold from the run
// list). Degrade by dropping detail, never by printing a raw id when a name
// exists.
export function occurrenceLabel({ occurrenceId, activityId, activities = [], occurrences = [], days = [], timeBlocks = [] }) {
  const activityName = activities.find((a) => a.id === activityId)?.name
  const occurrence = occurrences.find((o) => o.id === occurrenceId)
  const dayName = days.find((d) => d.id === occurrence?.day_id)?.name
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
export function satisfactionSummary(rows = []) {
  const occurrenceCount = new Set(rows.map((r) => r.occurrence_id)).size
  const buckets = [0, 0, 0, 0] // first, second, third, lower
  let outside = 0
  for (const row of rows) {
    const rank = row.preference_rank
    if (rank == null) outside += 1
    else if (rank >= 1 && rank <= 3) buckets[rank - 1] += 1
    else buckets[3] += 1
  }

  const parts = []
  buckets.forEach((count, i) => {
    if (count > 0) parts.push(`${count} ${i < 3 ? RANK_WORDS[i] : 'a lower choice'}`)
  })
  if (outside > 0) parts.push(`${outside} placed outside their preferences`)
  // "got" attaches to whichever clause comes first, so a run where nobody got
  // a first choice still reads as a sentence.
  if (parts.length > 0) parts[0] = parts[0].replace(/^(\d+) /, '$1 got ')

  const placed = `${rows.length} ${rows.length === 1 ? 'camper' : 'campers'} placed across ${occurrenceCount} ${occurrenceCount === 1 ? 'occurrence' : 'occurrences'}.`
  return parts.length > 0 ? `${placed} ${parts.join(', ')}.` : placed
}
