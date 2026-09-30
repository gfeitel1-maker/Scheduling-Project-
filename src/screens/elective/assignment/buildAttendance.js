// T229 round 2, H4 -- which occurrences a camper attends.
//
// Occurrences are tier-scoped (deriveOccurrences.js keys them on tier_id) but
// campers are not: `buildElectiveAssignments` defaulted to `attendance: null`
// (its own "every camper attends every occurrence" contract), so a set placed
// on both a Juniors cell and a Seniors cell at the same day/block produced two
// occurrences holding the SAME campers in each -- a Juniors set-detail run
// visibly seating Seniors kids.
//
// The sheet's division column (parsePreferenceSheet -> campers[].division_label)
// is matched against tiers[].name using electiveChoiceLabelKey, the same
// whitespace/case canonicalizer the rest of this feature already keys
// choices and camper names on -- a director transcribing "Older Campers" and
// "OlderCampers" means the same division.
//
// FIELD NAME CORRECTED 2026-09-29 (found while building a T301 visual
// verification fixture, unrelated to T301 itself). This read `camper.division`
// from T229 round 2 until now; `parsePreferenceSheet` has only ever produced
// `division_label` (confirmed by calling it directly with the production
// catalog shape). So for every REAL sheet import, this field was always
// undefined, every camper always took the "cannot match" branch below, and a
// set spanning two divisions has never actually scoped attendance in the
// shipped app -- the exact bug this module's own header says it exists to
// fix. This file's own test suite never caught it because its fixtures
// hand-built `{ division: ... }` objects matching this code's assumption
// rather than the parser's actual output -- see buildAttendance.test.js's new
// non-vacuity test, which drives the real parser instead.
//
// BOARD ITEM (2026-09-30) -- tier matching alone was still too coarse. A
// single tier can be covered by MULTIPLE groups' cells (this is exactly the
// acceptance fixture's Older 1 / Older 2 shape, which is one tier), and the
// old "occurrences span at most one tier -> attendance: null" fast path
// treated that as nothing-to-disambiguate, so a camper in Older 2 was still
// admitted to an occurrence a DIFFERENT group (Older 1) created. The fast path
// is gone; the rule is now three branches, keyed off deriveOccurrences.js's
// derived `group_ids`:
//   1. camper.group_id is set -> attend only occurrences of the matched tier
//      whose group_ids includes this camper's group.
//   2. camper.group_id == null but the division matched a tier (T279 §12.2a)
//      -> every occurrence of that tier, unchanged (tier-wide fallback).
//   3. division unmatched or ambiguous -> every occurrence id, unchanged (R1).
// `buildAttendance` now always returns a computed map, never null.
//
// ROUND 3 (2026-09-30), Red Hat -- branch 1's "group carries the set
// nowhere" case needed a THIRD way to be wrong, not two. `groups` (additive
// param, `{id, tier_id}`) lets this module tell apart:
//   - the camper's sheet division and their ROSTER group genuinely disagree
//     about which tier they are in (division_label resolves to tier A, but
//     `groups.find(g => g.id === camper.group_id).tier_id` is B) -- a
//     divisionMismatch, not a "no cell" story. deriveOccurrences.js only ever
//     adds a slot's group_id to an occurrence after confirming the group's
//     OWN tier_id, so a group whose tier is B can never appear in an
//     A-tier occurrence's group_ids -- `groupOccurrences` is always empty for
//     this camper, for a reason that has nothing to do with the set's
//     schedule. Reporting it as noCells would name the WRONG group's
//     rotation as the problem (Red Hat's traced example: "Younger 1's
//     schedule has no period for this elective set" when Younger 1 was never
//     the issue -- the sheet and the roster disagree about the child's
//     division at all).
//   - genuinely a noCells case: the group's own tier matches the camper's
//     matched tier (or the group is unknown to `groups`, in which case there
//     is no second fact to disagree with, so this is never promoted to a
//     mismatch), and the set simply is not offered to that group -- true
//     even when the whole tier has zero occurrences, which is why the old
//     `tierOccurrences.length > 0` guard is gone.
import { suggestDivisionMatch } from './suggestDivisionMatch.js'
import { electiveChoiceLabelKey } from '../../../../electron/ops/electiveDerivedIds.js'
import { mapWithCollisions } from '../../../ingest/mapWithCollisions.js'

/**
 * A camper attends an occurrence iff its tier_id matches the camper's
 * resolved division AND, when camper.group_id is set, that occurrence's
 * group_ids includes it:
 *   - camper.group_id == null but the division matched a tier (T279 §12.2a):
 *     every occurrence of that tier (tier-wide admission, unchanged).
 *   - division unmatched/ambiguous: unchanged, R1 -- every occurrence id.
 *   - a correctly identified camper whose group carries the set NOWHERE
 *     legitimately gets [] -- that is not an R1 violation and does not count
 *     toward unmatchedCount.
 *
 * @param {object} input
 * @param {{id: string, division_label?: string|null, group_id?: string|null}[]} input.campers
 * @param {{id: string, tier_id: string|null, group_ids?: string[]}[]} input.occurrences
 * @param {{id: string, name: string}[]} input.tiers
 * @param {{id: string, tier_id: string|null}[]} [input.groups] -- additive (round 3). Used
 *   only to classify an empty `attendance[id]` for a group-identified camper; a caller that
 *   omits it gets every such camper folded into `noCells` (never invents a mismatch from
 *   missing data).
 * @returns {{attendance: Record<string, string[]>, unmatchedCount: number, unmatched: object[], ambiguous: object[], noCells: object[], divisionMismatches: object[]}}
 *   `attendance[id]: []` for a group-identified camper (branch 1) always means one of two
 *   things, reported through two disjoint buckets -- neither is an R1 violation (the camper
 *   WAS identified) and neither increments unmatchedCount:
 *   - `noCells` -- the camper's roster group's OWN tier agrees with their matched division,
 *     and that group simply is not among the groups carrying this set (possibly because the
 *     whole tier has no occurrences at all). Grouped by group_id.
 *   - `divisionMismatches` -- the camper's sheet division and their roster group disagree
 *     about which tier they are in. Reporting this as noCells would name the WRONG group's
 *     rotation as the problem (see the round 3 header note). Grouped by (division, group_id).
 *   A group_id absent from `groups` always falls to `noCells`, never `divisionMismatches`.
 */
export function buildAttendance({ campers = [], occurrences = [], tiers = [], groups = [] } = {}) {
  // T255 Slice B, finding 6 — schema v73 lets two tiers share a name, so a
  // plain last-write-wins Map here would silently seat a camper in only ONE
  // of the two same-named divisions' occurrences instead of every occurrence
  // this module's never-unplaced fallback (owner ruling R1) otherwise
  // guarantees. mapWithCollisions REFUSES the colliding key structurally — an
  // ambiguous name reads as "no match" below, not a wrong one.
  const { map: tierIdByNameKey, ambiguous: ambiguousTierNameKeys } = mapWithCollisions(
    tiers,
    (t) => electiveChoiceLabelKey(t.name ?? ''),
    (t) => t.id
  )
  const allOccurrenceIds = occurrences.map((o) => o.id)

  const attendance = {}
  let unmatchedCount = 0
  // T232 — group the unmatched by the VALUE the sheet carried, not by camper.
  // A director fixes a spelling once; being told "3 campers" and left to find
  // them in a hundred-row spreadsheet is a count, not a decision.
  const unmatchedByValue = new Map()
  // Same shape, for divisions whose name matches more than one tier. Kept
  // separate from unmatchedByValue: this is not a typo to suggest a fix for
  // (the name IS one of the camp's real divisions), it is a same-camp name
  // collision the director resolves by renaming a division, not the sheet.
  const ambiguousByValue = new Map()
  // Art. V follow-up — same per-value grouping shape, keyed on group_id
  // rather than a sheet value: the cause here is the camp's own roster, not
  // anything the director typed.
  const noCellByGroup = new Map()
  // Round 3 — keyed on the (division, group_id) PAIR: both facts disagree,
  // and both belong in the key so two campers with the same sheet division
  // but different mismatched groups are not silently merged.
  const divisionMismatchByPair = new Map()
  const groupTierById = new Map(groups.map((g) => [g.id, g.tier_id]))
  // tierNames keeps BOTH tiers of an ambiguous pair — suggestDivisionMatch may
  // therefore suggest a name that is itself ambiguous. That is unchanged by
  // this fix: the suggestion is advisory text only (T144, propose never
  // merge) and never used to bind a camper, so an ambiguous suggestion cannot
  // cause a wrong placement — only a slightly less useful hint.
  const tierNames = tiers.map((t) => t?.name).filter(Boolean)
  for (const camper of campers) {
    const divisionKey = camper.division_label ? electiveChoiceLabelKey(camper.division_label) : ''
    if (divisionKey && ambiguousTierNameKeys.has(divisionKey)) {
      attendance[camper.id] = allOccurrenceIds
      const raw = String(camper.division_label ?? '').trim()
      if (!ambiguousByValue.has(raw)) ambiguousByValue.set(raw, { division: raw, camperCount: 0 })
      ambiguousByValue.get(raw).camperCount += 1
      continue
    }
    const matchedTierId = divisionKey ? tierIdByNameKey.get(divisionKey) : undefined
    if (matchedTierId == null) {
      // Never-unplaced (owner ruling R1) extends to attendance: a camper we
      // cannot place by division is considered for every occurrence rather
      // than dropped, and the caller surfaces how many that affected.
      attendance[camper.id] = allOccurrenceIds
      unmatchedCount += 1
      const raw = String(camper.division_label ?? '').trim()
      if (!unmatchedByValue.has(raw)) {
        unmatchedByValue.set(raw, {
          division: raw,
          camperCount: 0,
          // PROPOSE, NEVER MERGE (T144). Nothing here changes the camper's
          // division or their attendance — it names the division they probably
          // meant so the sheet can be corrected.
          suggestion: suggestDivisionMatch(raw, tierNames),
        })
      }
      unmatchedByValue.get(raw).camperCount += 1
      continue
    }
    const tierOccurrences = occurrences.filter((o) => o.tier_id === matchedTierId)
    if (camper.group_id != null) {
      const groupOccurrences = tierOccurrences.filter((o) => (o.group_ids ?? []).includes(camper.group_id))
      attendance[camper.id] = groupOccurrences.map((o) => o.id)
      if (groupOccurrences.length === 0) {
        const groupTierId = groupTierById.get(camper.group_id)
        if (groupTierById.has(camper.group_id) && groupTierId !== matchedTierId) {
          // The sheet and the roster disagree about this camper's tier.
          const raw = String(camper.division_label ?? '').trim()
          const pairKey = `${raw}\u0000${camper.group_id}`
          if (!divisionMismatchByPair.has(pairKey)) {
            divisionMismatchByPair.set(pairKey, { division: raw, group_id: camper.group_id, camperCount: 0 })
          }
          divisionMismatchByPair.get(pairKey).camperCount += 1
        } else {
          // Roster agrees (or the group is unknown to `groups`, so there is
          // no second fact to disagree with) -- a genuine no-cell case.
          if (!noCellByGroup.has(camper.group_id)) {
            noCellByGroup.set(camper.group_id, { group_id: camper.group_id, camperCount: 0 })
          }
          noCellByGroup.get(camper.group_id).camperCount += 1
        }
      }
    } else {
      attendance[camper.id] = tierOccurrences.map((o) => o.id)
    }
  }
  return {
    attendance,
    unmatchedCount,
    unmatched: [...unmatchedByValue.values()],
    ambiguous: [...ambiguousByValue.values()],
    noCells: [...noCellByGroup.values()],
    divisionMismatches: [...divisionMismatchByPair.values()],
  }
}
