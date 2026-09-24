// T229 round 2, H4 -- which occurrences a camper attends.
//
// Occurrences are tier-scoped (deriveOccurrences.js keys them on tier_id) but
// campers are not: `buildElectiveAssignments` defaulted to `attendance: null`
// (its own "every camper attends every occurrence" contract), so a set placed
// on both a Juniors cell and a Seniors cell at the same day/block produced two
// occurrences holding the SAME campers in each -- a Juniors set-detail run
// visibly seating Seniors kids.
//
// The sheet's division column (parsePreferenceSheet -> campers[].division) is
// matched against tiers[].name using electiveChoiceLabelKey, the same
// whitespace/case canonicalizer the rest of this feature already keys
// choices and camper names on -- a director transcribing "Older Campers" and
// "OlderCampers" means the same division.
import { suggestDivisionMatch } from './suggestDivisionMatch.js'
import { electiveChoiceLabelKey } from '../../../../electron/ops/electiveDerivedIds.js'
import { mapWithCollisions } from '../../../ingest/mapWithCollisions.js'

/**
 * @param {object} input
 * @param {{id: string, division?: string|null}[]} input.campers
 * @param {{id: string, tier_id: string|null}[]} input.occurrences
 * @param {{id: string, name: string}[]} input.tiers
 * @returns {{attendance: Record<string, string[]>|null, unmatchedCount: number, unmatched: object[], ambiguous: object[]}}
 *   `attendance` is null when there is nothing to disambiguate (occurrences
 *   span at most one tier) -- callers pass that straight through to
 *   buildElectiveAssignments, whose own default is "attend everything".
 */
export function buildAttendance({ campers = [], occurrences = [], tiers = [] } = {}) {
  const distinctTierIds = new Set(occurrences.map((o) => o.tier_id).filter((t) => t != null))
  if (distinctTierIds.size <= 1) {
    return { attendance: null, unmatchedCount: 0, unmatched: [], ambiguous: [] }
  }

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
  // tierNames keeps BOTH tiers of an ambiguous pair — suggestDivisionMatch may
  // therefore suggest a name that is itself ambiguous. That is unchanged by
  // this fix: the suggestion is advisory text only (T144, propose never
  // merge) and never used to bind a camper, so an ambiguous suggestion cannot
  // cause a wrong placement — only a slightly less useful hint.
  const tierNames = tiers.map((t) => t?.name).filter(Boolean)
  for (const camper of campers) {
    const divisionKey = camper.division ? electiveChoiceLabelKey(camper.division) : ''
    if (divisionKey && ambiguousTierNameKeys.has(divisionKey)) {
      attendance[camper.id] = allOccurrenceIds
      const raw = String(camper.division ?? '').trim()
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
      const raw = String(camper.division ?? '').trim()
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
    attendance[camper.id] = occurrences.filter((o) => o.tier_id === matchedTierId).map((o) => o.id)
  }
  return { attendance, unmatchedCount, unmatched: [...unmatchedByValue.values()], ambiguous: [...ambiguousByValue.values()] }
}
