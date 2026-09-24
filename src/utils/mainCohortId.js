// Pure, dependency-free id derivation for the camp's singleton "Main" cohort,
// following the same reasoning as electron/ops/dayId.js and
// electron/ops/scheduleTemplateId.js: two concurrent ensureCohort() calls for
// the same brand-new camp (e.g. two mounts racing each other, see
// ensureCohort.js) must mint the SAME id, or two rows are created that never
// converge.
//
// Placed under src/utils/ (not electron/ops/, where the sibling derive*Id
// modules live) because its only caller, ensureCohort.js, is renderer-only —
// there is no electron/db migration or main-process consumer that would need
// this from the electron/ side.
//
// T241 (docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md)
// relaxed `UNIQUE(camp_id, name)` on `cohorts` to a plain non-unique index, so
// the mechanism ensureCohort.js previously relied on — a losing concurrent
// call's row-creation colliding with that constraint and rolling back — no
// longer exists: a second concurrent caller can now create a second row
// outright. Deriving the id removes the race instead of detecting it after
// the fact: two concurrent callers computing the same id target the SAME row
// (via the `cohorts` projection's `ensureExists` placeholder INSERT OR
// IGNORE), so their field writes converge onto one row rather than each
// minting its own.
//
// This does NOT fall under the design spec's "Extending deterministic-id
// derivation to interactive creates" non-goal: the Main cohort is a
// system-generated singleton minted once per camp by ensureCohort, never a
// director-typed name a human could rename into a collision. There is no
// rename-recollide problem for a fixed, code-owned id.
export function deriveMainCohortId(campId) {
  return `cohort:${campId}:main`
}
