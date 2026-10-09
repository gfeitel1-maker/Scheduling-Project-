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

// board item 9b round 3 (item 2) — the ONE place this wording is authored.
// M1 (Red Hat round 4) established the rule (never a raw camper UUID in
// director-facing copy) and this exact literal at two sites
// (groupBundleTierNotCoveredFindings below, and DraftRunView.jsx's
// sheetOnlyCamperNames). Exporting it stops a THIRD site from inventing a
// third wording, and lets every sibling site (the placement table, the
// dangling-placement rows, listRunCampers' picker list) share the same
// owner-reviewed sentence rather than falling back to the raw id.
export const UNKNOWN_CAMPER_LABEL = 'a removed camper'

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
    'Schedule changed. Regenerate first.',
  OUTER_RESOURCE_CONFLICT:
    'Double-booked on the schedule. Fix it, then finalize.',
  ALREADY_FINAL: 'Already finalized.',
  // Round 2 FIX 4 (Red Hat, MEDIUM) — a cold-opened run's status is never
  // re-synced (viewRun is a snapshot from when the screen opened), so a
  // regenerate re-checks status itself before re-entering the solve/commit
  // flow. Reuses FinalizeRefusalRow's generic branch, which renders with no
  // action button — the Re-derive control is withheld by construction.
  FINALIZED_ELSEWHERE: 'Finalized on another device.',
  // T320 part 2 item 2 — commitElectiveRun's own refusal, which is what now
  // GUARANTEES an immutable run is not written over. Sibling of ALREADY_FINAL
  // (finalizeElectiveRun's), reached from the commit path rather than the
  // finalize path.
  RUN_IS_FINAL: 'Already final.',
}

export const DANGLING_MOVE_PLACEHOLDER = 'Move to…'
export const REMOVE_PLACEMENT_LABEL = 'Remove placement'

export const STALE_GENERATION_COPY =
  'Out of date.'

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
  return `${label}: ${filled} of ${capacity}.`
}

export function danglingMessage({ camperName }) {
  return `${camperName}'s lock no longer applies.`
}

export function stalenessOfferMessage({ staleCount }) {
  return `${staleCount} ${staleCount === 1 ? 'placement is' : 'placements are'} from an older schedule.`
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
// Round 3 (Red Hat F3) — the finding now carries `tier_id`, the tier
// commitElectiveRun's own resolution ACTUALLY used (electron/ops/
// commitElectiveRun.js's noteMismatch/resolveWriteChoiceId), and that value is
// read directly here WHENEVER the finding has it (`!== undefined`, since a
// legitimately-unresolved tier is `null`, a real value, not an absent field).
// Re-deriving via makeCamperIdentityResolver is now only a FALLBACK, for a
// finding that genuinely lacks the field (an older caller, or a test fixture
// that does not set it) — never the default path.
//
// WHY RE-DERIVING AT RENDER TIME WAS A REAL BUG, not a hypothetical one: this
// commit's own campers-write loop (further down the SAME transaction) can
// clear a camper's `division_label` to null in the exact commit that produced
// this finding (T279 §12.2a — an empty cell in a division column IS a fact
// worth recording, so an import with nothing new to say still overwrites a
// stale value). Tier resolution read the camper's PRE-write roster division,
// which can differ from BOTH the sheet's own (absent) value and the camper's
// GROUP tier. Re-deriving against the POST-write campers row at render time
// falls through to the group's tier instead — naming a division the mismatch
// was never generated against. Carrying the resolved tier on the finding
// itself removes the second read entirely for the common case.
export function groupBundleTierNotCoveredFindings({ findings = [], campers = [], groups = [], tiers = [] } = {}) {
  const relevant = findings.filter((f) => f.kind === 'BUNDLE_TIER_NOT_COVERED')
  if (relevant.length === 0) return []
  // Constructed lazily — only a finding missing `tier_id` ever needs it, and
  // a legacy/fallback path paying for a resolver no finding here asks for
  // would be work this function need not do.
  let identity = null
  const tierById = new Map(tiers.map((t) => [t.id, t]))
  const camperById = new Map(campers.map((c) => [c.id, c]))
  const byKey = new Map()
  for (const f of relevant) {
    const tierId = f.tier_id !== undefined
      ? f.tier_id
      : (identity ??= makeCamperIdentityResolver({ sheetCampers: campers, groups, tiers })).tierIdOf(f.camper_id)
    const tierName = tierId != null ? tierById.get(tierId)?.name ?? null : null
    // F7 (Code Reviewer) — a delimiter-safe key: JSON.stringify, not an
    // undelimited template-string join that a label containing the
    // delimiter could collide on.
    //
    // 2A (q-elective-finding-id-collision-rekey-safe) — the group key now also
    // carries `label_key`, the per-(camper,label) discriminator commitElectiveRun
    // persists. BEFORE 2A a null `label` (an assignment-only mismatch, choice_id
    // null so ec.label does not resolve) collapsed EVERY null-label mismatch for
    // a tier into one row — which, now that two such findings for ONE camper
    // actually survive to be read, would push that camper into the row TWICE and
    // report "2 campers" where one is affected by two bundles. Keying on
    // label_key splits them into one row per bundle, each naming the camper once.
    // The session (commit-response) path carries a real `label` and no
    // `label_key`, so its grouping is unchanged (label_key undefined → null).
    const key = JSON.stringify([f.label, f.label_key ?? null, tierId])
    if (!byKey.has(key)) byKey.set(key, { label: f.label, tierId, tierName, campers: [] })
    // F5 (Red Hat) — NEVER a raw camper_id in director-facing copy (the same
    // rule camperDisambiguator's own comment states): a camper row that is
    // gone (hard-deleted after an earlier generation) degrades to a truthful
    // sentence fragment instead.
    // Dedupe by camper_id within a group: a group is "one bundle/tier, the
    // campers it affects", so one camper must appear at most once even if two
    // findings land in the same group (belt-and-suspenders now that label_key
    // keeps distinct-bundle findings in distinct groups).
    if (byKey.get(key).campers.some((c) => c.id != null && c.id === f.camper_id)) continue
    const resolved = camperById.get(f.camper_id)?.display_name ?? null
    // `campers` REPLACED a parallel `names: [string]`, rather than being added
    // beside it. Round 1 kept both and left `names` with no production reader at
    // all (both former call sites pass `campers`), asserted only by a test whose
    // comment said every existing caller still held — there were none. The
    // disclosure needs the camper id to look up a disambiguator (two campers can
    // share a name) and `names` loses it, which is the whole reason for the
    // change.
    //
    // `name: null` IS the unresolvable signal, and an unresolvable camper
    // carries NO id — the id exists only to resolve a disambiguator, which a
    // camper with no row cannot have, and the F5 rule (never a raw camper id in
    // anything this screen hands to the director) applies to the structure as
    // much as to the sentence.
    byKey.get(key).campers.push({ id: resolved ? f.camper_id : null, name: resolved })
  }
  return [...byKey.values()]
}

// The sentence for one grouped row. `tierName` null means the tier genuinely
// could not be resolved — the phrasing names "these campers' division"
// instead of inventing a tier word, per groupBundleTierNotCoveredFindings'
// own posture.
//
// F2 (round 2 review) — `label` is also null for an assignment-only mismatch:
// commitElectiveRun.js's `labelsNeedingFlatChoice` only mints a flat choice
// for a label that appears in `parsed.preferences`, so a solver fallback
// placement (a camper never ranked the label at all) persists with
// choice_id null, and getElectiveRun.js's LEFT JOIN on choice_id then recovers
// no label on a cold reopen. Same posture as the tierName-null branch above —
// degrade honestly, never invent a label and never interpolate the raw null.
// Counts `campers`, the one list the group carries since the parallel `names`
// array was dropped — this read is why dropping it had to be done here and not
// only at the producer.
export function bundleTierNotCoveredGroupMessage({ label, tierName, campers = [] }) {
  const count = campers.length
  const who = tierName ? `cover ${tierName}` : 'cover these campers’ division'
  const subject = label ? `"${label}" does not ${who}` : `A linked bundle does not ${who}`
  return `${subject}: ${count} ${count === 1 ? 'camper’s request' : 'campers’ requests'} treated as ordinary.`
}

// (C)(4), board item 9b — SHEET_CAMPER_WITHOUT_PREFERENCE (sheetOnlyCampers,
// electron/ops/getElectiveRun.js) must be NAMED, same treatment as the
// grouped BUNDLE_TIER_NOT_COVERED row: one row, the count, and names behind
// the same disclosure idiom — never a bare count beside the regenerate
// control. `count` is the number of sheet-only campers; the singular/plural
// verb agreement is this function's whole job.
export function sheetOnlyCampersMessage(count) {
  const camperWord = count === 1 ? 'camper' : 'campers'
  return `${count} ${camperWord}: no choice, not placed.`
}

// board item — a disclosure that printed UNKNOWN_CAMPER_LABEL once per
// unresolvable camper read as six identical bullets. Naming them is impossible
// by construction: their campers row is gone, so the only distinguishing fact
// left is the raw id, which this screen never shows. So they are COUNTED into
// one line instead, beside whatever campers did resolve.
export function unresolvableCampersLabel(count) {
  if (count <= 0) return null
  return count === 1 ? UNKNOWN_CAMPER_LABEL : `${count} removed campers`
}

// When NOTHING resolves there is nothing to disclose — a <details> whose only
// content is its own summary restated. The fact goes inline instead.
export function allCampersUnresolvableMessage(count) {
  return count === 1
    ? 'This camper was removed.'
    : 'These campers were removed.'
}

// The plain regenerate control on a cold-opened draft run. Bare "Regenerate",
// NOT "Re-derive and regenerate": "re-derive" names the extra thing the
// staleness offer does (re-deriving against a changed schedule), and borrowing
// its label here would promise work this control does not do.
export const REGENERATE_LABEL = 'Regenerate'
export const REGENERATE_BUSY_LABEL = 'Regenerating…'

// A control that cannot act is never rendered as a dead control — but its
// absence always carries a sentence, so the director is not left guessing why
// the button they saw on another run is missing on this one.
//
// THREE STATES, NOT TWO. Round 1 had "preparing" and "not available", and the
// third — the hydration read actually FAILED — reached nothing on screen:
// AssignmentPanel called `onError` with a described failure and a full-body text
// search of the rendered page found no "could not be prepared" anywhere, so the
// director got the generic sentence and retrying produced the same sentence with
// no indication whether it would help. The standing rule is that every write
// failure is surfaced; a read the director is waiting on is no different.
//
// `failure` is the described failure itself, rendered verbatim, because a
// paraphrase here would be a second place for the same sentence to drift.
export function regenerateUnavailableNote(preparing, failure = null) {
  if (failure) return failure
  return preparing ? 'Preparing…' : "Can't regenerate now."
}

// The fallback when the cold-open read throws without a message of its own.
export const COLD_HYDRATION_FAILED_NOTE = "Couldn't prepare this run."

// A STUCK "Preparing…" IS NOT AN ANSWER. The read has no timeout of its own, so
// if the main process is unresponsive — exactly the condition this branch exists
// for — the note sat at "Preparing…" indefinitely, having REPLACED the
// previously definite, actionable sentence with an indefinite one.
export const COLD_HYDRATION_SLOW_NOTE = 'Taking too long.'

// C2 (board item 9b) — OUTER_RESOURCE_CONFLICT findings (findRouteConflicts,
// src/engine/routeConflicts.js) carry no `.message`, only locationName/
// dayId/blockId/capacity/occupants[].label. FinalizeFindingsList used to fall
// through to the raw `.kind`, so a finalize refusal with three conflicts
// printed "OUTER_RESOURCE_CONFLICT" three times. This names the location, the
// day/period (resolved via the SAME both-ways `label ?? name` read
// occurrenceLabel above already uses), and the colliding activities.
//
// Degrades by DROPPING DETAIL, never by printing a raw id — the day/period
// clause is omitted entirely when it cannot be resolved, same posture as
// occurrenceLabel/camperDisambiguator. Returns null for any other kind: this
// function does not guess at a shape it does not own.
//
// Round 5 (found live via the scene2 screenshot, every unit test having
// fixtures with distinct, single occupants) — findRouteConflicts registers
// ONE occupant entry PER OCCUPYING SLOT, so the same activity scheduled for
// three different groups in the same location/period appears three times in
// `occupants`. Un-deduplicated this read "Canoeing and Canoeing and Canoeing
// and Kayaking are scheduled there at once" — true, but not what a director
// needs: WHICH activities collide, not how many groups each contributed.
// `joinEnglishList` below is this module's own helper (no existing
// list-joining utility found in the project) for ordinary English list
// punctuation, which the un-deduplicated version also got wrong (joining
// every pair with "and" instead of commas-then-"and" for 3+ items).
function joinEnglishList(items) {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function conflictFindingMessage(finding, { days = [], timeBlocks = [] } = {}) {
  if (finding?.kind !== 'OUTER_RESOURCE_CONFLICT') return null
  const { locationName, dayId, blockId, capacity, occupants = [] } = finding
  const day = days.find((d) => d.id === dayId)
  const dayName = day?.label ?? day?.name ?? null
  const blockName = timeBlocks.find((t) => t.id === blockId)?.name ?? null
  const when = dayName && blockName ? `${dayName}, ${blockName}` : dayName || blockName || null
  const names = [...new Set(occupants.map((o) => o.label).filter(Boolean))]
  const activities = names.length > 0 ? joinEnglishList(names) : `${occupants.length} activities`
  const where = when ? `${locationName} on ${when}` : locationName
  return `${where}: ${activities} double-booked (capacity ${capacity}).`
}

// The director-facing message for ONE Finalize-refusal finding, whatever kind
// it is. `.message` wins when the producer already supplied one; a known
// shape (OUTER_RESOURCE_CONFLICT today) gets its own sentence; anything else
// degrades to plain words — NEVER the raw kind code and never JSON.stringify
// (which would print the kind field right back out), the same posture every
// other degrade in this file takes.
export function finalizeFindingMessage(finding, catalogs = {}) {
  if (finding?.message) return finding.message
  return conflictFindingMessage(finding, catalogs)
    ?? 'Conflict (details unavailable).'
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
export function satisfactionSummary({
  rows = [], preferences = [], occurrences = [], days = [], timeBlocks = [],
  // 1A (docs/work/specs/2026-10-02-elective-run-mismatch-null-identity-and-anchor-design.md)
  // — threaded straight through to buildPreferenceLookup. Defaulted, so an
  // existing caller that has not been updated yet keeps today's behaviour.
  offeringOccurrencesByChoiceId = {},
} = {}) {
  // Round 2 FIX 5(b) — elective_assignments.camper_id is nullable in the
  // schema (a null-camper row is schema-permitted, not known to be produced
  // today). Filtered out of the DISTINCT-camper count only; the row still
  // counts toward placementCount below.
  const camperCount = new Set(rows.map((r) => r.camper_id).filter((id) => id != null)).size
  const placementCount = rows.length
  const occurrenceCount = new Set(rows.map((r) => r.occurrence_id)).size
  const preferenceFor = buildPreferenceLookup({
    preferences, occurrences, days, timeBlocks, rows, offeringOccurrencesByChoiceId,
  })
  const buckets = [0, 0, 0, 0] // first, second, third, lower
  let outside = 0
  let unordered = 0
  for (const row of rows) {
    const rank = row.preference_rank
    const match = preferenceFor(row)
    // 2B — a non-null rank whose join MISSED (no preference row bound to this
    // placement) is not "one of their choices", it is a placement no choice
    // of theirs can be matched to. Only a MATCHED preference with no ordering
    // evidence is a genuine unordered-set tie.
    if (rank == null || match == null) {
      outside += 1
      continue
    }
    if (!hasOrderingEvidence(match.rankKind)) {
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
