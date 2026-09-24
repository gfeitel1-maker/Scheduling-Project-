// T255 slice C — shared array-level deterministic tie-break for a name that
// resolves to more than one row. Schema v73 relaxed name-UNIQUE on ten
// tables, so an array a caller holds (React state, an IPC `list()` result)
// can legitimately contain two same-named rows, and which one comes first
// depends on load order / a peer's insert / a reload — not on anything
// meaningful. Always resolve to the LOWEST id, so the same typed name binds
// to the same row on every device.
//
// This mirrors the db-bound precedent (`ORDER BY id ASC` + first-write-wins)
// in electron/ops/materializeImportedVersion.js's nameMap and
// electron/ops/ingest.js's seedNameMaps, and src/localClient.mock.js's
// byIdAsc — those stay db/array-bound where they are (pinned by their own
// tests, and reshaping them is out of scope here) but this is the one place
// new renderer-side array-shaped code should reach for instead of hand-
// rolling a sort.
export function lowestIdOf(rows) {
  if (!rows || rows.length === 0) return null
  return rows.reduce((best, r) => (best === null || r.id < best.id ? r : best), null)
}
