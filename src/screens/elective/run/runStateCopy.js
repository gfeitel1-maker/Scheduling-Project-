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
// Board item 9b / C1 — the SAME tier-resolution precedence commitElectiveRun.js
// uses to decide whether a bundle covers a camper (division_label beats the
// roster group's tier — see that module's own header for why). The finding
// this screen groups carries camper_id/label but not the tier, so re-deriving
// it with a SECOND rule would risk disagreeing with the rule that produced the
// finding in the first place. Precedented: AssignmentPanel.jsx already imports
// this pure module from electron/ops the same way.
import { makeCamperIdentityResolver } from '../../../../electron/ops/camperElectiveIdentity.js'

// Q5 (director-facing terminology) was ruled by the owner 2026-09-29: "start a
// new version". "Revision" implies editing the same run, which contradicts
// the Q1/Q2 ruling that a finalized run is immutable and starting over
// produces a new run, not an edit of the old one. The constant name is kept
// as START_REVISION_LABEL so every caller stays untouched by this change.
export const START_REVISION_LABEL = 'Start a new version'

// T320 (docs/adr/2026-09-30-elective-run-durability.md item 3; Governor
// ruling R7) — RELEASE_LOCK_LABEL/'Release lock' is REMOVED: it was the
// dangling row's only offered remedy and could not resolve the condition
// (see docs/work/specs/2026-09-30-t320-dangling-replace-picker.md's "Why
// Release lock alone is the wrong remedy"). Replaced by a picker that moves
// the camper to a live occurrence, or — when the run has none — a genuinely
// resolvable "Remove placement" action.
// The code -> director-facing copy map for this run's lifecycle refusals.
// Exported (T320 part 2 item 2) so AssignmentPanel maps commitElectiveRun's
// RUN_IS_FINAL through THIS string rather than a second copy of it — the two
// must not drift.
export const FINALIZE_MESSAGES = {
  STALE_OUTER_SCHEDULE:
    "This run's schedule changed on another device since you last regenerated. Finalizing now would lock in an outdated version.",
  OUTER_RESOURCE_CONFLICT:
    'A location or activity this run depends on is now double-booked on the main schedule. Fix the conflict there, then finalize again.',
  ALREADY_FINAL: 'This run was already finalized — on this device or another. Reloading it now.',
  // Round 2 FIX 4 (Red Hat, MEDIUM) — a cold-opened run's status is never
  // re-synced (viewRun is a snapshot from when the screen opened), so a
  // regenerate re-checks status itself before re-entering the solve/commit
  // flow. Reuses FinalizeRefusalRow's generic branch, which renders with no
  // action button — the Re-derive control is withheld by construction.
  FINALIZED_ELSEWHERE: "This run was finalized on another device while you had it open. It can't be changed — reload it to see the final version.",
  // T320 part 2 item 2 — commitElectiveRun's own refusal, which is what now
  // GUARANTEES an immutable run is not written over. Sibling of ALREADY_FINAL
  // (finalizeElectiveRun's), reached from the commit path rather than the
  // finalize path.
  RUN_IS_FINAL: "This run was finalized, so it can't be regenerated. Reload it to see the final version.",
}

export const DANGLING_MOVE_PLACEHOLDER = 'Move to…'
export const REMOVE_PLACEMENT_LABEL = 'Remove placement'

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

// T250 B3 — two same-named campers need something beside the name to tell
// them apart. Degrades group name -> external_id -> nothing, in that order,
// and NEVER prints a raw camper_id or a "No group" placeholder — a director
// reading this has to recognise a real fact about the child, not an internal
// id or an absence dressed up as one.
export function camperDisambiguator({ groupName, externalId } = {}) {
  if (groupName) return groupName
  if (externalId) return externalId
  return null
}

// Round 2 FIX 3 (Red Hat, MEDIUM) — camperDisambiguator above degrades PER
// CAMPER, with no idea whether the value it picks actually tells this camper
// apart from anyone else. Two same-named campers who both happen to be in
// "Cabin 4" both got "Jordan Lee · Cabin 4" printed under them — a value that
// LOOKS resolved and is not, which is worse than printing nothing: it defeats
// the entire point of disambiguating.
//
// This resolves the WHOLE SET of campers being listed at once, collision by
// name: a tier's value is used for a camper only when no OTHER same-named
// camper in the same set shares that exact value at that tier — otherwise it
// falls through to the next tier (group -> external_id -> nothing), same
// order as camperDisambiguator. A camper whose name is unique in the set
// needs no disambiguator at all and is never looked up.
//
// `entries`: [{ id, name, groupName, externalId }]. Returns a Map of
// id -> disambiguator string, or null when nothing distinguishes.
export function resolveCamperDisambiguators(entries = []) {
  const result = new Map()
  const byName = new Map()
  for (const entry of entries) {
    if (!entry || entry.id == null) continue
    result.set(entry.id, null)
    if (!entry.name) continue
    if (!byName.has(entry.name)) byName.set(entry.name, [])
    byName.get(entry.name).push(entry)
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue // a unique name needs no disambiguator
    applyDistinguishingTier(group, 'groupName', result)
    const unresolved = group.filter((entry) => result.get(entry.id) == null)
    applyDistinguishingTier(unresolved, 'externalId', result)
  }
  return result
}

// A tier value is only "distinguishing" within a colliding group when it is
// unique among that group — two campers sharing both the name AND the group
// have not been told apart, so neither gets the group tier and both fall
// through to the next one.
function applyDistinguishingTier(group, key, result) {
  const counts = new Map()
  for (const entry of group) {
    const value = entry[key]
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  for (const entry of group) {
    const value = entry[key]
    if (value && counts.get(value) === 1) result.set(entry.id, value)
  }
}

// C1 (board item 9b) — commitElectiveRun emits one BUNDLE_TIER_NOT_COVERED
// finding per camper per bundle label, so a real camp's run showed 30+
// near-identical rows, the same camper repeated across periods, ABOVE the
// Finalize control. This groups them by (label, tier) into ONE row per pair —
// compressing REPETITION, never INFORMATION (Art. V): every camper named in
// the finding set is still present in the returned group's `names`.
//
// The finding carries camper_id and label but not the tier, so it is resolved
// here via makeCamperIdentityResolver — the same precedence commitElectiveRun
// itself used to decide the mismatch (division_label beats the roster group's
// tier). A camper whose tier cannot be resolved at all (no campers row, or
// neither division nor group resolves) gets `tierName: null` rather than a
// fabricated or placeholder tier — the caller's copy must degrade truthfully,
// never invent.
export function groupBundleTierNotCoveredFindings({ findings = [], campers = [], groups = [], tiers = [] } = {}) {
  const relevant = findings.filter((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
  if (relevant.length === 0) return []
  const identity = makeCamperIdentityResolver({ sheetCampers: campers, groups, tiers })
  const tierById = new Map(tiers.map((t) => [t.id, t]))
  const camperById = new Map(campers.map((c) => [c.id, c]))
  const byKey = new Map()
  for (const f of relevant) {
    const tierId = identity.tierIdOf(f.camper_id)
    const tierName = tierId != null ? tierById.get(tierId)?.name ?? null : null
    const key = `${f.label} ${tierId ?? ''}`
    if (!byKey.has(key)) byKey.set(key, { label: f.label, tierId, tierName, names: [] })
    const name = camperById.get(f.camper_id)?.display_name ?? f.camper_id
    byKey.get(key).names.push(name)
  }
  return [...byKey.values()]
}

// The sentence for one grouped row. `tierName` null means the tier genuinely
// could not be resolved — the phrasing names "these campers' division"
// instead of inventing a tier word, per groupBundleTierNotCoveredFindings'
// own posture.
export function bundleTierNotCoveredGroupMessage({ label, tierName, names = [] }) {
  const count = names.length
  const camperWord = count === 1 ? 'camper' : 'campers'
  const subject = tierName ? `"${label}" does not cover ${tierName}` : `"${label}" does not cover these campers’ division`
  return `${subject} — ${count} ${camperWord} kept their request as an ordinary choice.`
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
//
// T250 B2 — a camper has ONE ROW PER OCCURRENCE (a multi-block activity is
// still one session, but is two elective_assignments rows: one per occupied
// occurrence), so `rows.length` alone counts placements, not campers. A
// 26-camper run with even one multi-occurrence placement read "more campers
// placed than exist." camperCount is the distinct set of camper_id; the
// rank-breakdown clause below is already correctly per-PLACEMENT and is
// UNCHANGED.
export function satisfactionSummary({ rows = [], preferences = [], occurrences = [], days = [], timeBlocks = [] } = {}) {
  // Round 2 FIX 5(b) — elective_assignments.camper_id is nullable in the
  // schema (a null-camper row is schema-permitted, not known to be produced
  // today). Filtered out of the DISTINCT-camper count only; the row still
  // counts toward placementCount below.
  const camperCount = new Set(rows.map((r) => r.camper_id).filter((id) => id != null)).size
  const placementCount = rows.length
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

  if (placementCount === 0) return 'No campers placed yet.'

  const placed = `${camperCount} ${camperCount === 1 ? 'camper' : 'campers'} placed, ` +
    `${placementCount} ${placementCount === 1 ? 'placement' : 'placements'} across ` +
    `${occurrenceCount} ${occurrenceCount === 1 ? 'occurrence' : 'occurrences'}.`
  return parts.length > 0 ? `${placed} ${parts.join(', ')}.` : placed
}
