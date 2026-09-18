// Reading a camper ranked-preference sheet into a PROPOSAL (T226).
//
// docs/work/tickets/T226-camper-preference-import.md,
// docs/adr/2026-09-17-individual-elective-scheduling.md (D12, D14).
//
// Pure: no database, no IPC, no file reading. It takes the row arrays every
// other ingest consumer takes and returns campers/choices/preferences for a
// caller to show a director and commit. Like extractEntities, it PROPOSES.
//
// WHY A MAPPING RATHER THAN A FIXED LAYOUT. D14 recorded that the real
// submissions arrive through a third-party export nobody has seen (T218). The
// FIELDS are known from the camp's own blank form — a name, a division, a
// 1..N ranking, a swim opt-out — but their column arrangement is not, and a
// parser that hardcodes one arrangement is the thing D14 retired. So the
// layout is an argument: inferPreferenceMapping proposes one from the header,
// and the director corrects it. A new export format is then a mapping, not a
// code change.
//
// The ranking is GLOBAL — a camper ranks each elective once for the session,
// not once per time slot. That is what the real artifacts showed, and it is
// why a preference points at a CHOICE (a label) rather than an occurrence.

import { deriveCamperId, electiveChoiceLabelKey } from '../../electron/ops/electiveDerivedIds.js'

const RANK_HEADER = /^#\s*(\d+)$/
const NAME_HEADER = /(camper|student|child).*name|^name$/i
const EXTERNAL_ID_HEADER = /(camper|student|child)\s*(id|number|#)$|^id$/i
const DIVISION_HEADER = /division|bunk|group|unit|edah/i

const cell = (row, index) => (index == null ? '' : String(row?.[index] ?? '').trim())

/**
 * Propose which column is which, from the header row.
 *
 * Every field is nullable and `unmapped` names what was not found — the caller
 * shows that to the director rather than proceeding on a guess.
 */
export function inferPreferenceMapping(header = []) {
  const cells = header.map((h) => String(h ?? '').trim())
  const findIndex = (re) => {
    const i = cells.findIndex((h) => re.test(h))
    return i === -1 ? null : i
  }

  const rankColumns = []
  cells.forEach((h, index) => {
    const m = RANK_HEADER.exec(h)
    if (m) rankColumns.push({ rank: Number(m[1]), index })
  })
  rankColumns.sort((a, b) => a.rank - b.rank)

  const externalIdIndex = findIndex(EXTERNAL_ID_HEADER)
  let nameIndex = findIndex(NAME_HEADER)
  // 'Camper ID' matches the name pattern's 'camper' branch only if the name
  // pattern is loosened; keep them disjoint so an id column is never the name.
  if (nameIndex !== null && nameIndex === externalIdIndex) nameIndex = null

  const unmapped = []
  if (nameIndex === null) unmapped.push('name')
  if (rankColumns.length === 0) unmapped.push('ranks')

  return { nameIndex, externalIdIndex, divisionIndex: findIndex(DIVISION_HEADER), rankColumns, unmapped }
}

/**
 * Read the sheet under a mapping.
 *
 * @returns {{ campers, choices, preferences, sameNameCampers, skippedRows }}
 *   `campers[].id` is the derived camper id (two devices reading one sheet
 *   converge on it). `choices` are distinct ranked labels, keyed by the same
 *   canonicalizer the elective-choice id uses, so a spelling variant folds.
 *   `preferences` carry `label`/`labelKey` rather than a choice id: choice ids
 *   are run-scoped and no run exists at parse time.
 *   `sameNameCampers` is the owner-approved identity decision handed back —
 *   two rows naming the same child, with no external id to tell them apart.
 */
export function parsePreferenceSheet(rows = [], { campId, mapping } = {}) {
  const body = rows.slice(1)
  const campers = []
  const byId = new Map()
  const rowsByName = new Map()
  const choicesByKey = new Map()
  const preferences = []
  const skippedRows = []

  body.forEach((row, i) => {
    const rowNumber = i + 2 // 1-based, and the header is row 1 — what a director sees.
    const displayName = cell(row, mapping?.nameIndex)
    const externalId = cell(row, mapping?.externalIdIndex)
    if (!displayName && !externalId) {
      skippedRows.push({ rowNumber, reason: 'no camper name' })
      return
    }

    const id = deriveCamperId(campId, { externalId: externalId || null, displayName: displayName || null })
    if (!byId.has(id)) {
      const camper = {
        id,
        display_name: displayName,
        external_id: externalId || null,
        division: cell(row, mapping?.divisionIndex) || null,
      }
      byId.set(id, camper)
      campers.push(camper)
    }
    if (displayName) {
      const nameKey = electiveChoiceLabelKey(displayName)
      if (!rowsByName.has(nameKey)) rowsByName.set(nameKey, { display_name: displayName, rowNumbers: [] })
      rowsByName.get(nameKey).rowNumbers.push(rowNumber)
    }

    for (const { rank, index } of mapping?.rankColumns ?? []) {
      const label = cell(row, index)
      if (!label) continue // A blank rank is a rank the camper left empty, not a shift.
      const labelKey = electiveChoiceLabelKey(label)
      // First spelling seen wins for display, matching extractEntities.
      if (!choicesByKey.has(labelKey)) choicesByKey.set(labelKey, { label, labelKey })
      preferences.push({ camper_id: id, label: choicesByKey.get(labelKey).label, labelKey, rank })
    }
  })

  // Two rows naming one child collapse onto ONE derived id by design; this is
  // where that becomes a director's decision instead of a silent merge. Rows
  // distinguished by an external id are not collisions — they are two children
  // who share a name, already correctly separated.
  const sameNameCampers = [...rowsByName.values()]
    .filter((e) => e.rowNumbers.length > 1)
    .filter((e) => {
      const ids = new Set(
        e.rowNumbers.map((n) => {
          const row = rows[n - 1]
          const ext = cell(row, mapping?.externalIdIndex)
          return deriveCamperId(campId, { externalId: ext || null, displayName: cell(row, mapping?.nameIndex) })
        })
      )
      return ids.size === 1
    })

  return { campers, choices: [...choicesByKey.values()], preferences, sameNameCampers, skippedRows }
}

/**
 * Does any camper hold the same rank twice?
 *
 * This is the CONSEQUENCE of a same-name collision, and the reason
 * `sameNameCampers` is a blocking decision rather than a notice. Observed on a
 * 100-row fabricated sheet: three rows naming one child produced one camper
 * with 75 preferences and three different rank-1 choices. A solver handed that
 * would resolve it by picking whichever it encountered first — a silent,
 * invisible decision about a real child's week.
 *
 * Kept separate from parsePreferenceSheet so the caller can show the director
 * the collision and its effect as two different sentences.
 */
export function hasContradictoryRanks({ preferences = [] } = {}) {
  const seen = new Set()
  for (const p of preferences) {
    const key = `${p.camper_id}\u0000${p.rank}`
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}
