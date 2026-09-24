// Shared shape for T255 Slice A: a name-keyed map that REFUSES a colliding
// key rather than resolving it last-write-wins. Schema v73 relaxed the
// name-UNIQUE constraint on ten tables, so two rows in one camp can now
// legitimately share a name (they arrive from a cross-device merge) — a
// plain `new Map(rows.map(...))` silently binds to whichever row came last.
//
// The refusal is STRUCTURAL: a colliding key is absent from `map`, not merely
// flagged in `ambiguous`. A caller that forgets to check `ambiguous` still
// cannot read a wrong-row value out of `map.get(key)` — it gets `undefined`,
// the same as an unmatched name, which is exactly the "refuse rather than
// guess" posture `specialDayPlan.js`'s `groupByName` block established.
export function mapWithCollisions(rows, keyFn, valueFn) {
  const map = new Map()
  const ambiguous = new Set()
  for (const row of rows) {
    const key = keyFn(row)
    if (ambiguous.has(key)) continue
    if (map.has(key)) {
      map.delete(key)
      ambiguous.add(key)
      continue
    }
    map.set(key, valueFn(row))
  }
  return { map, ambiguous }
}
