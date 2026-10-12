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
    const id = String(r.shoresh_id ?? '').trim() || null
    const name = String(r.name || '').trim()
    const rawCap = r.capacity
    const capacity = rawCap === '' || rawCap == null ? 1 : Number(rawCap)
    const kindRaw = String(r.kind || '').trim().toLowerCase()
    const kind = validKinds.has(kindRaw) ? kindRaw : null
    let warning = null
    if (!name) warning = 'Missing name'
    else if (!Number.isInteger(capacity) || capacity < 1) warning = 'Capacity must be a whole number 1 or greater'
    return { id, name, capacity, kind, warning }
  })
}

// T256 — which existing location a parsed row updates, and with what. Id-matched:
//   * a row whose id is a known location updates THAT location (a rename included);
//   * a row with an id that matches nothing creates — never an error, and never a
//     fall-through to a same-named row;
//   * a row with no id (hand-added, or a third-party sheet) updates a location only
//     when exactly one has that name. Two same-named locations with no id to tell
//     them apart is a create, never a lowest-id tie-break (T256 constraint 3): a
//     capacity edit must not land silently on the wrong location.
// `providedKeys` names the fields the sheet actually bound, so an absent `kind`
// column never resets a location's kind. Returns { existing: null } for a create,
// else { existing, changedFields } with changedFields null when nothing changed.
export function resolveLocationImportRow(row, existingRows, providedKeys) {
  let existing = null
  if (row.id) {
    existing = existingRows.find((s) => s.id === row.id) ?? null
  } else {
    const key = row.name.toLowerCase()
    const sameName = existingRows.filter((s) => String(s.name ?? '').toLowerCase() === key)
    existing = sameName.length === 1 ? sameName[0] : null
  }
  if (!existing) return { existing: null, changedFields: null }
  const candidate = { capacity: row.capacity, kind: row.kind ?? null }
  // Only an id match can rename: a name match is, by definition, the same name.
  if (row.id) candidate.name = row.name
  const changed = Object.entries(candidate).filter(
    ([k, v]) => (k === 'name' || providedKeys.has(k)) && String(existing[k] ?? '') !== String(v ?? '')
  )
  return { existing, changedFields: changed.length ? Object.fromEntries(changed) : null }
}
