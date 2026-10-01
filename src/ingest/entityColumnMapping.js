// Board item q-export-columns-do-not-round-trip — the format-agnostic binder
// for the seven setup-import doors (Days, Groups, Tiers, Time Blocks,
// Activities, Anchors/fixed events, Locations).
// docs/adr/2026-09-30-format-agnostic-setup-import.md §4.1-4.6.
//
// SLICE A (this file): the pure binder only. The seven screens are not wired
// to it yet (slice B), mappingSeedling.js's SINGLE_ROLES parameterization is
// not done yet (slice B), and the atomic multi-row commit is a separate,
// later decision item (§4.9, part 2).
//
// This generalizes `inferPreferenceMapping`/`describeCoverage`
// (./preferenceSheet.js) off its five hardcoded preference roles onto an
// arbitrary per-entity field list, and drops the preference binder's regex
// matching for exact folded-synonym matching — setup data has no analogue of
// "#1"/"First Choice" rank forms, so there is nothing for a regex to do here.
//
// Pure: plain arrays in, plain objects out. No DB, no IPC, no file reading —
// like preferenceSheet.js, this is a PROPOSAL the caller shows a director.

import { normalizeName } from './preview.js'
import { columnLabel } from './preferenceSheet.js'

// One declarative entry per setup entity. `sheet` matches readEntitySheet's
// `sheetName` argument and the app's own export's tab name for that entity.
// Each field's `synonyms` are seeded from three sources, all read at the
// source rather than guessed: the screen's own raw field name (today's
// hardcoded expectation, kept so nothing regresses), buildCampDataWorkbook's
// human-facing header for that field, and exportWorkbook's raw key where the
// entity is one of the six S4a covers.
export const ENTITY_FIELD_CATALOGS = {
  days_of_operation: {
    sheet: 'Days',
    fields: [
      { key: 'label', required: true, synonyms: ['label', 'name', 'day'] },
      { key: 'day_of_week', required: true, synonyms: ['day_of_week', 'day of week', 'dow'] },
      { key: 'sort_order', required: false, synonyms: ['sort_order', 'order'] },
    ],
  },
  groups: {
    sheet: 'Groups',
    fields: [
      { key: 'name', required: true, synonyms: ['name'] },
      { key: 'tier_name', required: false, synonyms: ['tier_name', 'age division', 'unit', 'division'] },
      { key: 'availability', required: false, synonyms: ['availability'] },
    ],
  },
  tiers: {
    sheet: 'Age Divisions',
    fields: [
      { key: 'name', required: true, synonyms: ['name'] },
      // TiersScreen reads and validates r.sort_order, and its own downloadTemplate
      // writes ['name','sort_order'] — so the column exists and must bind, or the
      // screen's own template fails to re-import and a sort_order column lands in
      // residue instead (Code Reviewer, slice-A review).
      { key: 'sort_order', required: false, synonyms: ['sort_order', 'order'] },
      // B3 cohort fix (b): optional — a file with no cohort/program column falls back
      // to the screen's active cohort exactly as before this field existed. Named
      // "program" too, matching CohortPicker's own director-facing label.
      { key: 'cohort_name', required: false, synonyms: ['cohort_name', 'cohort', 'program'] },
    ],
  },
  time_blocks: {
    sheet: 'Time Blocks',
    fields: [
      { key: 'name', required: true, synonyms: ['name'] },
      { key: 'start_time', required: true, synonyms: ['start_time', 'start time'] },
      // end_time and part_of_day are REQUIRED: TimeBlocksScreen.confirmImport SKIPS any
      // warned row (TimeBlocksScreen.jsx:361), and a blank end_time ('Missing time',
      // :335) or a part_of_day not in morning/afternoon/evening — blank included — (:336)
      // warns, so a file missing either column imports ZERO rows. Marking them required
      // gates the confirm button instead of silently dropping every row.
      { key: 'end_time', required: true, synonyms: ['end_time', 'end time'] },
      { key: 'part_of_day', required: true, synonyms: ['part_of_day', 'part of day'] },
      { key: 'sort_order', required: false, synonyms: ['sort_order', 'order'] },
      { key: 'cohort_name', required: false, synonyms: ['cohort_name', 'cohort', 'program'] },
    ],
  },
  activities: {
    sheet: 'Activities',
    fields: [
      { key: 'name', required: true, synonyms: ['name'] },
      { key: 'location', required: false, synonyms: ['location', 'place'] },
      { key: 'eligible_tiers', required: false, synonyms: ['eligible_tiers', 'age divisions'] },
      { key: 'weather_alternative', required: false, synonyms: ['weather_alternative', 'weather alternative'] },
      { key: 'is_outdoor', required: false, synonyms: ['is_outdoor', 'outdoor'] },
      { key: 'same_tier_only', required: false, synonyms: ['same_tier_only', 'same age division only'] },
      { key: 'priority', required: false, synonyms: ['priority'] },
      { key: 'prefer_before_day', required: false, synonyms: ['prefer_before_day', 'prefer before day'] },
      { key: 'prefer_before_day_min', required: false, synonyms: ['prefer_before_day_min', 'prefer before (min)'] },
      { key: 'max_groups_per_slot', required: false, synonyms: ['max_groups_per_slot', 'max groups per slot'] },
      { key: 'min_per_week', required: false, synonyms: ['min_per_week', 'min sessions/week'] },
      { key: 'max_per_week', required: false, synonyms: ['max_per_week', 'max sessions/week'] },
      { key: 'notes', required: false, synonyms: ['notes'] },
    ],
  },
  fixed_events: {
    sheet: 'Fixed Events',
    fields: [
      { key: 'name', required: true, synonyms: ['name'] },
      { key: 'day_label', required: true, synonyms: ['day_label', 'day'] },
      // Required for the same reason as time_blocks' end_time: FixedEventsScreen.confirmImport
      // skips any warned row (FixedEventsScreen.jsx:724), and a blank time_block_name resolves
      // to no time_block_id and warns 'Time block "" not found' (:645-646), so a file
      // missing this column imports zero anchors.
      { key: 'time_block_name', required: true, synonyms: ['time_block_name', 'time block'] },
      { key: 'is_all_tiers', required: false, synonyms: ['is_all_tiers', 'all groups'] },
      { key: 'tier_names', required: false, synonyms: ['tier_names', 'age divisions'] },
      { key: 'notes', required: false, synonyms: ['notes'] },
      { key: 'cohort_name', required: false, synonyms: ['cohort_name', 'cohort', 'program'] },
    ],
  },
  locations: {
    sheet: 'Locations',
    fields: [
      { key: 'name', required: true, synonyms: ['name'] },
      { key: 'capacity', required: true, synonyms: ['capacity'] },
      { key: 'kind', required: false, synonyms: ['kind'] },
    ],
  },
}

/**
 * Propose which header column is which catalog field, from the header row.
 *
 * Generalizes `inferPreferenceMapping`: an arbitrary `catalog.fields` list
 * instead of five hardcoded roles, and exact folded-synonym matching instead
 * of regex (setup headers have no "#1"/"First Choice" ordinal forms for a
 * regex to earn its keep against).
 *
 * Two CELLS matching one field's synonyms is a `collision` — the file names
 * the same field twice and nothing here guesses which one wins. Two FIELDS
 * whose synonym lists both match one cell cannot happen for a correctly
 * authored catalog (the disjointness gate in entityColumnMapping.test.js
 * proves it for every catalog above) — this function does not defend against
 * it, by design, per ADR §4.2.
 *
 * @returns {{roles, unrecognisedColumns, unmapped, collision, header}}
 *   `roles` is { [fieldKey]: headerIndex }. `header` is carried through
 *   (trimmed, unfolded) so `applyEntityMapping` can turn an index back into
 *   the literal property name on a `readEntitySheet` row object.
 */
export function inferEntityMapping(header = [], catalog) {
  const cells = header.map((h) => String(h ?? '').trim())
  const folded = cells.map(normalizeName)

  const roles = {}
  const collision = []
  const claimed = new Set()

  for (const field of catalog.fields) {
    const synonymSet = new Set(field.synonyms.map(normalizeName))
    const matches = []
    folded.forEach((f, index) => {
      if (f !== '' && synonymSet.has(f)) matches.push(index)
    })
    if (matches.length === 0) continue
    if (matches.length > 1) {
      collision.push({ field: field.key, indexes: matches, columns: matches.map(columnLabel) })
      continue
    }
    roles[field.key] = matches[0]
    claimed.add(matches[0])
  }

  const unrecognisedColumns = cells
    .map((h, index) => ({ header: h, index, column: columnLabel(index) }))
    .filter((c) => c.header !== '' && !claimed.has(c.index))
    .map((c) => ({ ...c, kind: 'UNRECOGNISED_COLUMN' }))

  const unmapped = catalog.fields
    .filter((f) => f.required && roles[f.key] == null)
    .map((f) => f.key)

  return { roles, unrecognisedColumns, unmapped, collision, header: cells }
}

/**
 * Turn `readEntitySheet`'s raw rows (objects keyed by whatever header text
 * the sheet actually had) into rows keyed by canonical field key — the exact
 * shape each screen's existing `rows.map(r => ...)` body already consumes
 * (`r.tier_name`, `r.day_of_week`, ...), per ADR §4.6.
 *
 * A field with no bound column reads as '' — the same value a present-but-
 * blank cell would give, via `readEntitySheet`'s `defval: ''` — so a screen's
 * existing `r.sort_order !== ''` style checks behave the same whether the
 * column was blank or simply absent.
 */
/**
 * A one-line description of why confirmImport is gated, or null when it isn't.
 * `blockingUnmapped` lets a caller exclude fields it derives per-row instead of
 * gating on (e.g. DaysScreen's day_of_week) from the required-column half.
 */
export function describeMappingIssue(mapping, blockingUnmapped = mapping?.unmapped ?? []) {
  if (!mapping) return null
  const parts = []
  if (blockingUnmapped.length > 0) parts.push(`missing required column(s): ${blockingUnmapped.join(', ')}`)
  if (mapping.collision.length > 0) parts.push(`column(s) matched more than one field: ${mapping.collision.map((c) => c.field).join(', ')}`)
  return parts.length === 0 ? null : `Can't import yet — ${parts.join('; ')}.`
}

export function applyEntityMapping(rows, mapping, catalog) {
  const header = mapping?.header ?? []
  return rows.map((row) => {
    const out = {}
    for (const field of catalog.fields) {
      const index = mapping?.roles?.[field.key]
      out[field.key] = index == null ? '' : (row[header[index]] ?? '')
    }
    return out
  })
}
