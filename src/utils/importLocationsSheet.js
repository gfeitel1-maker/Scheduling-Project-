// T121 — import-side counterpart to exportWorkbook.js's LOCATIONS_SHEET.
// Pulled out of LocationsScreen's onFileChange so the export→import
// round-trip can be asserted directly against the SAME parsing code the
// screen actually runs (exportWorkbook.test.js), instead of a second
// hand-written parser that could silently drift from it.
//
// `rows` is the plain sheet_to_json({ defval: '' }) output (already run
// through unescapeRow by the caller). `validKinds` is the screen's
// KIND_OPTIONS value set — kept there since it's a display/domain concern,
// not an import-shape one.
export function parseLocationsSheetRows(rows, validKinds) {
  return rows.map((r) => {
    const name = String(r.name || '').trim()
    const rawCap = r.capacity
    const capacity = rawCap === '' || rawCap == null ? 1 : Number(rawCap)
    const kindRaw = String(r.kind || '').trim().toLowerCase()
    const kind = validKinds.has(kindRaw) ? kindRaw : null
    let warning = null
    if (!name) warning = 'Missing name'
    else if (!Number.isInteger(capacity) || capacity < 1) warning = 'Capacity must be a whole number 1 or greater'
    return { name, capacity, kind, warning }
  })
}
