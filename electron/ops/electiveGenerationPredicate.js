// The ONE elective_assignments generation-visibility WHERE fragment (T244,
// docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md decision
// (a)/(b), Red Hat MEDIUM-4/H3):
//
//   source = 'manual' OR solver_generation = (run's current solver_generation)
//
// `source = 'manual'` is exempt from the generation check entirely (H3): a
// director's locked/manual placement must never vanish just because another
// device regenerated the run first. Only a `source='solver'` row is ever
// judged stale.
//
// Uses SQLite `IS`, not `=`, for the generation comparison, and that choice is
// still load-bearing even though commitElectiveRun now stamps a marker.
//
// As of T244 round 2, `commitElectiveRun` mints one `randomUUID()` marker per
// commit and writes it to BOTH the run row and every `elective_assignments`
// row in the same transaction — so any run committed from that change onward
// carries a non-NULL generation on both sides, and this predicate's equality
// branch does real work. (Before it, nothing anywhere wrote the marker, every
// row was NULL, and the detections built on this predicate could never fire.
// Do not restore that state: stamping the run without stamping its rows, or
// the reverse, makes this fragment hide every solver row in the run.)
//
// `IS` remains required for the rows that predate that change: a legacy run
// has NULL on the run AND NULL on its assignment rows, and `NULL = NULL` is
// never true in SQL, so `=` would silently hide every row of every run
// committed before T244. `solver_generation IS :gen` matches NULL to NULL and
// keeps those runs fully visible. A legacy run that is later regenerated
// moves to a UUID while its untouched old rows stay NULL — `NULL IS '<uuid>'`
// is false, so those rows go correctly stale rather than being lost.
//
// Bind the run's current generation as the named parameter `gen` (better-
// sqlite3 named-parameter binding: `.all({ gen })` / `.get({ gen })`).
//
// Exported as two fragments so neither is hand-written at a call site:
// `electiveGenerationVisibleFragment` for the rows a reader should show, and
// its inverse `electiveGenerationStaleSolverFragment` (restricted to
// `source='solver'`, since a manual row is never "stale" under this
// predicate) for a `staleCount`-style tally. T248 imports this module for its
// own handler — the `alias` parameter exists so a joined query can qualify
// the columns without a second copy of this text.

export function electiveGenerationVisibleFragment(alias = 'a') {
  return `(${alias}.source = 'manual' OR ${alias}.solver_generation IS :gen)`
}

export function electiveGenerationStaleSolverFragment(alias = 'a') {
  return `(${alias}.source = 'solver' AND ${alias}.solver_generation IS NOT :gen)`
}
