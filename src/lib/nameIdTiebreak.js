// T255 slice C — shared array-level deterministic tie-break for a name that
// resolves to more than one row. Schema v73 relaxed name-UNIQUE on ten
// tables, so an array a caller holds (React state, an IPC `list()` result)
// can legitimately contain two same-named rows, and which one comes first
// depends on load order / a peer's insert / a reload — not on anything
// meaningful. Always resolve to the LOWEST id, so the same typed name binds
// to the same row on every device.
//
// THE CONTRACT IS SQLite'S BINARY COLLATION — i.e. UTF-8 byte order, which is
// code-point order. That is deliberate and load-bearing: the host resolves the
// same ambiguity with `ORDER BY id ASC` on a TEXT column (see
// electron/ops/materializeImportedVersion.js's nameMap and
// electron/ops/ingest.js's seedNameMaps, plus src/localClient.mock.js's
// byIdAsc). If this helper disagreed with that ordering, the renderer and the
// host would resolve one name to DIFFERENT rows — the exact failure the whole
// tie-break exists to remove. Those three stay db/array-bound where they are
// (each pinned by its own tie-break test, and reshaping them buys nothing);
// this is the one place new renderer-side array-shaped code should reach for
// instead of hand-rolling a sort.
//
// WHY NOT PLAIN `a < b`. JS string comparison is UTF-16 CODE UNIT order, not
// code-point order, and the two disagree. A surrogate pair (0xD800-0xDBFF …)
// encodes a code point at or above U+10000, but compares BELOW a plain BMP
// character in 0xE000-0xFFFF, because the comparison only ever sees the high
// surrogate. SQLite, comparing UTF-8 bytes, puts it above. Measured, not
// assumed: with a = U+1F600 and b = U+E000, `a < b` is true while
// `a.codePointAt(0) < b.codePointAt(0)` is false.
//
// Unreachable through today's two call sites — ids are lowercase-hex uuids or
// `deriveLocationId` output, and two rows sharing a name share that derived
// base, so they can only differ in an ASCII numeric suffix. But this is a
// general-purpose primitive whose own comment advertises the SQL equivalence,
// and an id derived from a director-typed name (an emoji in a location name is
// all it takes) would reach the divergence. A guard's description is part of
// the guard, so the description is made true rather than narrowed.
// Found by Red Hat on this slice.
export function compareIdsAsSqliteWould(a, b) {
  const aPoints = [...String(a ?? '')]
  const bPoints = [...String(b ?? '')]
  const shared = Math.min(aPoints.length, bPoints.length)
  for (let i = 0; i < shared; i += 1) {
    const x = aPoints[i].codePointAt(0)
    const y = bPoints[i].codePointAt(0)
    if (x !== y) return x < y ? -1 : 1
  }
  return aPoints.length - bPoints.length
}

/**
 * The lowest-id row of a set of rows that already matched by name.
 *
 * Name matching stays at the call site on purpose — each entity folds names
 * differently (locations are trim-only and case-SENSITIVE per T81; ingest uses
 * normalizeName) and folding them here would quietly impose one rule on all of
 * them. A caller passes the rows it has already decided are the same thing.
 *
 * @param {{id: string}[]} rows rows already filtered to one name
 * @returns {{id: string}|null} the lowest-id row, or null when there are none
 */
export function lowestIdOf(rows) {
  if (!rows || rows.length === 0) return null
  return rows.reduce(
    (best, r) => (best === null || compareIdsAsSqliteWould(r.id, best.id) < 0 ? r : best),
    null
  )
}
