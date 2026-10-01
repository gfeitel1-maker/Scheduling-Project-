// Board item q-export-columns-do-not-round-trip (item 7), B3 cohort fix (b).
//
// Pure: resolves a re-imported row's cohort by NAME (never silently defaulting a
// row that named a different program to whatever cohort happens to be active —
// the earlier bug this closes). A column that's absent or blank falls back to
// the active cohort quietly, same as before this feature existed.
//
// Red Hat (MEDIUM-HIGH): a blank cell and a NAMED-but-unmatched cell (typo, a
// renamed program) must not collapse to the same shape — a silent fallback for
// the latter hides a real data problem behind "nothing to see here". The
// `unmatchedName` field is the distinct signal; `cohortId` still falls back to
// the active cohort so the import is never blocked on it, but a door reads
// `unmatchedName` to surface a needs-eye disclosure instead of staying quiet.
export function resolveRowCohort(cohortNameFromRow, cohorts = [], activeCohort = null) {
  const name = String(cohortNameFromRow ?? '').trim()
  if (name === '') return { cohortId: activeCohort?.id ?? null, mismatch: false }

  const match = cohorts.find((c) => String(c.name ?? '').toLowerCase() === name.toLowerCase())
  if (!match) return { cohortId: activeCohort?.id ?? null, mismatch: false, unmatchedName: name }

  return {
    cohortId: match.id,
    mismatch: !!activeCohort && match.id !== activeCohort.id,
    matchedCohortName: match.name,
  }
}

/**
 * The one-line disclosure a door shows for a `resolveRowCohort` result — or null
 * when there is nothing to say (blank cell, or the row's named cohort matches the
 * active one). A mismatch and an unmatched name read as two DIFFERENT problems
 * (wrong-but-real program vs. a name this camp has no program for at all), so
 * they get distinct wording rather than sharing one sentence.
 */
export function describeCohortNote(result, activeCohort) {
  if (!result) return null
  if (result.mismatch) {
    return `These rows came from Cohort ${result.matchedCohortName}; you are on Cohort ${activeCohort?.name ?? ''}.`
  }
  if (result.unmatchedName) {
    return `Row names cohort '${result.unmatchedName}' which this camp has no program for — importing under the active program ${activeCohort?.name ?? ''}.`
  }
  return null
}
