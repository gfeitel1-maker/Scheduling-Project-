// S4b — the enrichment-workbook RE-IMPORT adapter (pure). Parses an already-read
// XLSX workbook (the artifact S4a's exportWorkbook produced) back into the S2c
// per-row record shape buildPlan consumes: `{ id?, name, fields:{}, clears:[] }`.
//
// docs/adr/2026-08-08-s4-enrichment-workbook-round-trip.md §2
//
// It is the SECURITY BOUNDARY of the round-trip (Security F1). The sheet name and
// the header text both flow, downstream, into interpolated SQL (buildExistingSnapshot,
// seedRecognitionMaps, idExists) — safe today ONLY because entity/field come from
// frozen registries. A crafted sheet name would be an identifier-injection vector
// and a crafted header would target a privileged column a `<clear>` could then null.
// So this adapter maps sheet->entity and header->field through the HARDCODED,
// frozen SHEET_LAYOUT allowlist and DROPS anything else — nothing outside the
// allowlist ever reaches an `entity` or `field`.

import * as XLSX from 'xlsx'
import { unescapeCell } from '../utils/exportSanitize.js'
import { SHEET_LAYOUT, META_SHEET, ID_COLUMN } from '../utils/exportWorkbook.js'
import { normalizeName } from './preview.js'

// The canonical clear token (ADR §3). A cell is a clear IFF, after trim(), it
// exactly equals this literal (case-sensitive). Empty is always "preserve".
export const CLEAR_TOKEN = '<clear>'

const isClearToken = (v) => typeof v === 'string' && v.trim() === CLEAR_TOKEN

// A cell read back as string, with the sanitizer's conditional apostrophe strip.
function cellString(raw) {
  const s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw)
  return unescapeCell(s)
}

// Read the hidden metadata sheet into a flat key->value map. Returns null when
// the sheet is absent (a foreign/hand-built file), which the caller fails closed on.
function readMeta(workbook) {
  const ws = workbook?.Sheets?.[META_SHEET]
  if (!ws) return null
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })
  const map = {}
  for (const r of rows.slice(1)) {
    const key = r?.[0]
    if (key == null || key === '') continue
    map[String(key)] = r[1]
  }
  return map
}

/**
 * PURE. Parse a Shoresh enrichment workbook into a buildPlan source.
 *
 * @param workbook  an XLSX workbook object (XLSX.read output).
 * @param active    { camp_id, cohort_id } — the ACTIVE camp/program to guard
 *   against a workbook made for a different one (hard reject, ADR §4).
 * @returns { approved:{ [entity]: record[] }, camp_id, cohort_id,
 *            base_generation:number, mode:'add' }
 * @throws on missing/edited metadata, a corrupt baseline, or a camp/cohort
 *   mismatch — the re-import must fail closed, never default (ADR §4).
 */
export function workbookToSource(workbook, active = {}) {
  const meta = readMeta(workbook)
  // Fail-closed: the metadata sheet is REQUIRED. A missing/edited base_generation
  // or baseline must reject — never default base_generation to 0 (that silently
  // disables the staleness gate and re-opens the import-over-import hole, ADR §4).
  if (!meta || meta.base_generation === undefined || meta.base_generation === ''
      || meta.baseline === undefined || meta.baseline === '') {
    throw new Error(
      'This spreadsheet is missing the information Shoresh needs to match your changes. Download a fresh worksheet and edit that one. Nothing was imported.'
    )
  }
  const base_generation = Number(String(meta.base_generation).trim())
  if (!Number.isInteger(base_generation) || base_generation < 0) {
    throw new Error('This worksheet’s tracking information looks damaged. Download a fresh worksheet. Nothing was imported.')
  }
  let baseline
  try { baseline = JSON.parse(meta.baseline) } catch {
    throw new Error('This worksheet’s tracking information looks damaged. Download a fresh worksheet. Nothing was imported.')
  }
  if (!baseline || typeof baseline !== 'object') {
    throw new Error('This worksheet’s tracking information looks damaged. Download a fresh worksheet. Nothing was imported.')
  }

  const camp_id = meta.camp_id === '' || meta.camp_id == null ? null : String(meta.camp_id)
  const cohort_id = meta.cohort_id === '' || meta.cohort_id == null ? null : String(meta.cohort_id)

  // Camp/cohort mismatch is a HARD reject before matching (ADR §4) — never a held
  // import. Importing one camp's worksheet into another must be impossible.
  if (active.camp_id != null && camp_id != null && camp_id !== active.camp_id) {
    throw new Error('This worksheet was made for a different camp, so it can’t be imported here. Nothing was imported.')
  }
  if (active.cohort_id != null && cohort_id != null && cohort_id !== active.cohort_id) {
    throw new Error('This worksheet was made for a different program, so it can’t be imported here. Nothing was imported.')
  }

  const approved = {}
  for (const layout of SHEET_LAYOUT) {
    approved[layout.entity] = []
    const ws = workbook?.Sheets?.[layout.sheet]
    if (!ws) continue
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false, raw: false })
    if (rows.length === 0) continue

    // Header -> column index, through the allowlist ONLY. An unknown header is
    // dropped (never mapped to a field); shoresh_id is the match key; Status is
    // read-only metadata and never read here at all (Security F1).
    const header = (rows[0] ?? []).map((h) => String(h ?? ''))
    const idIdx = header.indexOf(ID_COLUMN)
    const colIdx = {}
    for (const col of layout.columns) {
      const i = header.indexOf(col.key)
      if (i >= 0) colIdx[col.key] = i
    }

    const nameKey = layout.nameKey
    const baseForEntity = (baseline[layout.entity] && typeof baseline[layout.entity] === 'object')
      ? baseline[layout.entity] : {}
    // Names that existed at export time (each was exported WITH an id). A blank-id
    // row whose name is one of these is a possible LOST id, not a confident create.
    const baselineNames = new Set(
      Object.values(baseForEntity).map((r) => normalizeName(String(r?.[nameKey] ?? '')))
    )

    const records = []
    for (const raw of rows.slice(1)) {
      const idCell = idIdx >= 0 ? cellString(raw[idIdx]).trim() : ''
      const id = idCell === '' ? undefined : idCell
      const nameCell = colIdx[nameKey] != null ? cellString(raw[colIdx[nameKey]]) : ''
      const name = String(nameCell).trim()

      const baseRow = id != null && baseForEntity[id] && typeof baseForEntity[id] === 'object'
        ? baseForEntity[id] : null

      const fields = {}
      const clears = []
      for (const col of layout.columns) {
        const idx = colIdx[col.key]
        if (idx == null) continue
        const cell = cellString(raw[idx])
        // Explicit clear beats everything (ADR §3).
        if (isClearToken(cell)) { clears.push(col.key); continue }
        const trimmed = String(cell).trim()
        // Empty cell = preserve, never a delta and never a clear.
        if (trimmed === '') continue
        // BASELINE DIFF (RISK D): a cell equal to what the export wrote is NOT a
        // director change — omit it, so an untouched cell can never diff against a
        // drifted live value. Only director-CHANGED cells become deltas.
        if (baseRow != null && col.key in baseRow) {
          if (String(baseRow[col.key] ?? '').trim() === trimmed) continue
        }
        // eligible_groups is a comma-separated label LIST; buildPlan's set-diff
        // and S2c's resolveFieldWrite both expect an array.
        fields[col.key] = col.labelList
          ? trimmed.split(',').map((s) => s.trim()).filter((s) => s !== '')
          : trimmed
      }

      // A wholly empty row (blank id/name, nothing changed, nothing cleared) is
      // not a proposal — skip it (a trailing blank row must not become a create).
      if (id == null && name === '' && Object.keys(fields).length === 0 && clears.length === 0) continue

      const record = { name, fields, clears }
      if (id != null) record.id = id
      // possible_lost_id (RISK K): blank id, but the name was an exported entity.
      if (id == null && name !== '' && baselineNames.has(normalizeName(name))) {
        record._workbookConflict = { reason: 'possible_lost_id' }
      }
      records.push(record)
    }

    // duplicate_id (RISK J): the SAME shoresh_id on two rows would otherwise be
    // two silent LWW writes to one entity. Hold both.
    const byId = new Map()
    for (const rec of records) {
      if (rec.id == null) continue
      if (!byId.has(rec.id)) byId.set(rec.id, [])
      byId.get(rec.id).push(rec)
    }
    for (const recs of byId.values()) {
      if (recs.length > 1) for (const rec of recs) rec._workbookConflict = { reason: 'duplicate_id' }
    }

    approved[layout.entity] = records
  }

  // Force add-mode (RISK L): a workbook can NEVER trigger replaceScope. A
  // bulk-enrichment file that happens to omit rows must never delete them.
  return { approved, camp_id, cohort_id, base_generation, mode: 'add' }
}
