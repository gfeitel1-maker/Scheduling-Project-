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
// Uses SQLite `IS`, not `=`, for the generation comparison. commitElectiveRun
// never writes solver_generation, so it is NULL today on both the run row and
// every assignment row it has ever produced — `= NULL` is never true in SQL
// and would hide every one of those rows. `solver_generation IS :gen` gives
// NULL-matches-NULL correctly, which is what makes today's real-world state
// (nothing has ever set a generation marker) keep every row visible instead
// of silently hiding all of them.
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
