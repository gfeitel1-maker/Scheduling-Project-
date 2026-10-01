// Create-or-update keyed on a natural key. Board item q-export-columns-do-not-round-trip
// (item 7), slice B3.
//
// Pure: no DB, no IPC. A re-imported row whose natural key already exists in the
// camp either carries a real change (`update`, writeFields only the changed
// columns) or doesn't (`unchanged`, no write at all) — a re-import no longer
// has to choose between creating a duplicate and silently skipping an edited row.
//
// `providedKeys` (optional Set<string>) restricts an UPDATE's diff to fields the
// sheet actually named — via a bound column (mapping.roles) or a value the row
// explicitly derived (e.g. Days' day_of_week from a weekday-name label). Omitted,
// every candidateFields key is diffed (used by CREATE, which legitimately needs
// every default). Code Reviewer HIGH+MEDIUM: without this, a field whose column
// was simply ABSENT from the file still carries the parser's default value, and
// diffing that default against a real existing value silently overwrites a
// director's own data — a sheet missing `eligible_group_ids` entirely must never
// be read as "set eligible_group_ids to []".
export function resolveRowAction(naturalKey, candidateFields, existingByKey, providedKeys = null) {
  const existing = existingByKey.get(String(naturalKey).toLowerCase())
  if (!existing) return { action: 'create' }

  const entries = providedKeys
    ? Object.entries(candidateFields).filter(([key]) => providedKeys.has(key))
    : Object.entries(candidateFields)
  const changed = entries.filter(
    ([key, value]) => String(existing[key] ?? '') !== String(value ?? '')
  )
  if (changed.length === 0) return { action: 'unchanged', existing }

  return { action: 'update', existing, changedFields: Object.fromEntries(changed) }
}
