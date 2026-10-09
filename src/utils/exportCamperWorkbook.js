import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet } from './exportSanitize.js'

// T353 — the CAMPER export. Same canonical-workbook pattern as exportWorkbook.js
// (sanitized sheet, read-only, writes nothing), but its sheet is laid out in the
// table shape src/ingest/preferenceSheet.js already reads, so a director edits it
// and re-imports it through the ordinary preference import to UPDATE campers.
//
// Identity on re-import is the importer's own rule (Camper ID, else the name), so
// `Camper ID` carries the stored external_id verbatim and nothing else.
//
// A camper with no ranked choices is left out: the importer writes nothing for a
// row with no choices, so exporting one would promise a round trip it cannot make.

export const CAMPER_SHEET = 'Campers'

// elective_assignment_runs carries no timestamp, so "most recent" is the last run
// in the order the store returns preferences — insertion order in practice.
function latestRunPreferences(preferences) {
  const byCamper = new Map()
  for (const p of preferences) {
    if (!p.camper_id || p.rank == null) continue
    const held = byCamper.get(p.camper_id)
    if (!held || held.runId !== p.run_id) byCamper.set(p.camper_id, { runId: p.run_id, prefs: [p] })
    else held.prefs.push(p)
  }
  return byCamper
}

export function buildCamperRows({ campers = [], groups = [], preferences = [], choices = [] }) {
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  const choiceLabel = new Map(choices.map((c) => [c.id, c.label]))
  const byCamper = latestRunPreferences(preferences)
  const perCell = preferences.some((p) => p.coordinate_day_label || p.coordinate_period_label)

  const body = []
  let maxRank = 0
  const sorted = [...campers].sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)))
  for (const camper of sorted) {
    const held = byCamper.get(camper.id)
    if (!held) continue
    const cells = new Map()
    for (const p of held.prefs) {
      const key = `${p.coordinate_day_label ?? ''}\u0000${p.coordinate_period_label ?? ''}`
      if (!cells.has(key)) cells.set(key, { day: p.coordinate_day_label ?? '', period: p.coordinate_period_label ?? '', ranks: [] })
      cells.get(key).ranks[p.rank - 1] = choiceLabel.get(p.choice_id) ?? ''
    }
    const identity = [camper.external_id ?? '', camper.display_name, camper.division_label ?? groupName.get(camper.group_id) ?? '']
    for (const cell of cells.values()) {
      maxRank = Math.max(maxRank, cell.ranks.length)
      body.push({ identity, cell })
    }
  }

  const header = ['Camper ID', 'Camper Name', 'Division', ...(perCell ? ['Day', 'Period'] : [])]
  for (let r = 1; r <= maxRank; r += 1) header.push(`#${r}`)
  const rows = body.map(({ identity, cell }) => {
    const ranks = Array.from({ length: maxRank }, (_, i) => cell.ranks[i] ?? '')
    return [...identity, ...(perCell ? [cell.day, cell.period] : []), ...ranks]
  })
  return [header, ...rows]
}

export function exportCamperWorkbook(args) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, aoaToSanitizedSheet(buildCamperRows(args)), CAMPER_SHEET)
  return wb
}

export function downloadCamperWorkbook(args, filename = 'shoresh_campers.xlsx') {
  XLSX.writeFile(exportCamperWorkbook(args), filename)
}
