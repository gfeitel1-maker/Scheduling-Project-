import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet } from './exportSanitize.js'

// S4a — the enrichment-workbook EXPORT. A read-only renderer that builds an xlsx
// pre-populated with what the camp already knows: one sheet per ingestible
// entity, a stable read-only `shoresh_id`, the director-editable fields, and a
// `Status` word. It writes NOTHING to the camp — it only reads and produces a
// file. The re-import (id-match tier, <clear>, base_generation gate) is S4b.
//
// docs/adr/2026-08-08-s4-enrichment-workbook-round-trip.md §1
//
// EVERY user string routes through aoaToSanitizedSheet (companion sanitizer
// ADR) — never the raw array-to-sheet builder. Any styling (column widths,
// text-format on time cells) is layered ON TOP of the already-sanitized
// worksheet — never a hand-built cell object, which would bypass the escape
// (Security F3).

// Bumped if the workbook contract (sheets/columns/metadata) changes, so a stale
// artifact re-imported by a newer S4b can be recognised as an older shape.
export const PLAN_VERSION = 1

// The hidden metadata sheet's name. S4b reads camp_id/cohort_id/base_generation
// + the per-row baseline out of it; a re-import whose metadata is missing or
// camp-mismatched fails closed (ADR §4). Hidden so a director never edits it.
export const META_SHEET = '_shoresh_meta'

// The read-only conveyance columns, present on every sheet. `shoresh_id` is the
// match key on re-import; `Status` is read-only metadata, never a field (ADR §1,
// Security F1). S4b's header allowlist must never treat either as editable.
export const ID_COLUMN = 'shoresh_id'
export const STATUS_COLUMN = 'Status'

// Sheet + column layout, in INGESTIBLE_ENTITIES order (ADR §1 table). Each
// entity's `columns` are the editable fields exactly; `shoresh_id` is prepended
// and `Status` appended by the builder. `nameKey` is the entity's display-name
// column. `ordered` entities carry a persisted `sort_order` into the baseline
// (never a row index — RISK E). `label`/`labelList`/`time` mark columns whose
// stored form is transformed for the sheet.
export const SHEET_LAYOUT = Object.freeze([
  { entity: 'cohorts', sheet: 'Programs', nameKey: 'name', columns: [{ key: 'name' }] },
  { entity: 'tiers', sheet: 'Age Divisions', nameKey: 'name', ordered: true, columns: [{ key: 'name' }] },
  {
    entity: 'groups', sheet: 'Groups', nameKey: 'name',
    columns: [{ key: 'name' }, { key: 'unit', label: true }, { key: 'availability' }],
  },
  { entity: 'days_of_operation', sheet: 'Days', nameKey: 'label', ordered: true, columns: [{ key: 'label' }] },
  {
    entity: 'time_blocks', sheet: 'Time Blocks', nameKey: 'name', ordered: true,
    columns: [{ key: 'name' }, { key: 'start_time', time: true }, { key: 'end_time', time: true }],
  },
  {
    entity: 'activities', sheet: 'Activities', nameKey: 'name',
    columns: [
      { key: 'name' }, { key: 'priority' }, { key: 'min_per_week' }, { key: 'max_per_week' },
      { key: 'eligible_groups', labelList: true }, { key: 'location', label: true },
    ],
  },
])

// Three-look vocabulary as WORDS (ADR §1). Derived from op provenance where the
// caller supplies it: a row's latest write by an import → Inferred; by a human →
// Confirmed. An explicit `row.status` word wins. A persisted entity with no
// provenance hint is a real, Confirmed record (the safe default — it exists).
function statusWord(row) {
  const explicit = row?.status
  if (explicit === 'Inferred' || explicit === 'Confirmed' || explicit === 'Unknown') return explicit
  if (row?.source === 'import') return 'Inferred'
  return 'Confirmed'
}

// Canonical HH:MM:SS text (RISK F). The DB stores "08:40:00"; a director-facing
// "08:40" is padded to seconds so both faces canonicalize identically and a
// round-trip diffs to unchanged. Written as a STRING so the sheet builder types it
// 's' and Excel cannot coerce it to a time serial; a `.z:'@'` format is layered
// on top (below) as belt-and-braces.
function canonicalTime(value) {
  if (value == null || value === '') return ''
  const s = String(value).trim()
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (!m) return s
  const hh = m[1].padStart(2, '0')
  return `${hh}:${m[2]}:${m[3] ?? '00'}`
}

// activities.eligible_group_ids is a JSON id array; render as human group-name
// labels (ADR §1), resolved back to ids on re-import (S4b) through the same name
// maps commitPlan builds. Unresolvable ids are dropped from the label (the
// stored id is still authoritative in the baseline).
function eligibleGroupLabels(row, groupNameById) {
  let ids = []
  try { ids = JSON.parse(row.eligible_group_ids ?? '[]') } catch { ids = [] }
  return (Array.isArray(ids) ? ids : [])
    .map((id) => groupNameById.get(id))
    .filter((n) => n != null)
    .join(', ')
}

// Resolve one column's SHEET value from a stored entity row.
function cellValueFor(col, row, maps) {
  if (col.label && col.key === 'unit') {
    return row.tier_id != null ? (maps.tierNameById.get(row.tier_id) ?? '') : ''
  }
  // M4 §D6, mirroring `unit` exactly: the sheet shows the resolved place NAME,
  // never the raw location_id.
  if (col.label && col.key === 'location') {
    return row.location_id != null ? (maps.locationNameById.get(row.location_id) ?? '') : ''
  }
  if (col.labelList && col.key === 'eligible_groups') {
    return eligibleGroupLabels(row, maps.groupNameById)
  }
  if (col.time) return canonicalTime(row[col.key])
  const v = row[col.key]
  return v == null ? '' : v
}

/**
 * S4a. Build the enrichment workbook (pure — reads plain entity arrays, writes
 * no camp state). Returns an XLSX workbook object; the UI trigger calls
 * XLSX.writeFile on it.
 *
 * @param entities  { cohorts, tiers, groups, days_of_operation, time_blocks, activities }
 *                  arrays of stored rows (localClient.list shape, snake_case).
 * @param camp_id / cohort_id  stamped into the hidden metadata sheet.
 * @param base_generation  the op-log generation (max op seq) the export was
 *                  taken at — S4b's staleness gate diffs against it. Stamped
 *                  as-is; sourcing a real value is the trigger's job.
 */
export function exportWorkbook({
  cohorts = [], tiers = [], groups = [], days_of_operation = [], time_blocks = [], locations = [], activities = [],
  camp_id = null, cohort_id = null, base_generation = null,
} = {}) {
  // M4 §D6: 'locations' is an extra input used only to resolve the activities
  // sheet's `location` column — NOT a sheet of its own. SHEET_LAYOUT stays six
  // entries; the place catalog lives on LocationsScreen, not the workbook.
  const entities = { cohorts, tiers, groups, days_of_operation, time_blocks, activities }
  const maps = {
    tierNameById: new Map(tiers.map((t) => [t.id, t.name])),
    groupNameById: new Map(groups.map((g) => [g.id, g.name])),
    locationNameById: new Map(locations.map((l) => [l.id, l.name])),
  }

  const wb = XLSX.utils.book_new()
  // baseline[entity][shoresh_id] = { editable col values written } (+ sort_order
  // for ordered entities). This is what S4b diffs a re-imported cell against —
  // workbook-vs-baseline, so an untouched cell never manufactures a delta even
  // if the live value drifted (RISK D).
  const baseline = {}

  for (const layout of SHEET_LAYOUT) {
    const rows = entities[layout.entity] ?? []
    baseline[layout.entity] = {}

    const header = [ID_COLUMN, ...layout.columns.map((c) => c.key), STATUS_COLUMN]
    const aoa = [header]

    for (const row of rows) {
      const id = row.id
      const record = {}
      const dataCells = layout.columns.map((col) => {
        const value = cellValueFor(col, row, maps)
        record[col.key] = value
        return value
      })
      // sort_order is carried in the baseline from the PERSISTED value, never a
      // row index (RISK E) — it is not a visible column.
      if (layout.ordered) record.sort_order = row.sort_order ?? null
      baseline[layout.entity][id] = record
      aoa.push([id, ...dataCells, statusWord(row)])
    }

    // Every user string escaped here; styling is layered on the result below.
    const ws = aoaToSanitizedSheet(aoa)

    // Column widths (layered on the sanitized sheet, ADR §2a).
    ws['!cols'] = header.map((h) =>
      h === ID_COLUMN ? { wch: 38 } : h === STATUS_COLUMN ? { wch: 11 } : { wch: 18 }
    )
    // Force text format on time columns so Excel cannot coerce HH:MM:SS to a
    // serial (RISK F). Layered on existing string cells' `.z`, never a .v build.
    layout.columns.forEach((col, i) => {
      if (!col.time) return
      const colIdx = i + 1 // shoresh_id is column 0
      for (let r = 1; r < aoa.length; r++) {
        const addr = XLSX.utils.encode_cell({ c: colIdx, r })
        if (ws[addr]) ws[addr].z = '@'
      }
    })

    XLSX.utils.book_append_sheet(wb, ws, layout.sheet)
  }

  // Hidden metadata sheet: camp/cohort identity, base_generation, and the
  // baseline. REQUIRED — S4b fails closed if it is missing or camp-mismatched.
  const metaRows = [
    ['key', 'value'],
    ['plan_version', PLAN_VERSION],
    ['camp_id', camp_id ?? ''],
    ['cohort_id', cohort_id ?? ''],
    ['base_generation', base_generation == null ? '' : base_generation],
    ['baseline', JSON.stringify(baseline)],
  ]
  const metaWs = aoaToSanitizedSheet(metaRows)
  metaWs['!cols'] = [{ wch: 16 }, { wch: 60 }]
  XLSX.utils.book_append_sheet(wb, metaWs, META_SHEET)

  // Hide the metadata sheet (per-sheet flag aligned to SheetNames order).
  wb.Workbook = wb.Workbook ?? {}
  wb.Workbook.Sheets = wb.SheetNames.map((name) => ({ Hidden: name === META_SHEET ? 1 : 0 }))

  return wb
}

// Thin trigger: build + write. Filename mirrors exportSchedule's convention.
export function downloadWorkbook(args, filename = 'shoresh_worksheet.xlsx') {
  XLSX.writeFile(exportWorkbook(args), filename)
}
