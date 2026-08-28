// docs/adr/2026-08-28-stage-aware-nav-landing.md Decision 1 — the stage-aware
// landing predicate. A single, cheap existence check over the required-setup
// tables, extracted (same pattern as ops/read.js's listEntities) so it can be
// unit-tested against a real db without going through IPC wiring.
//
// Same table set REQUIRED_AREAS (src/engine/readiness.js) treats as the
// blocking core — deliberately NOT getReadiness's full five-collection
// engine pass: the landing decision only ever needs the one "is this camp
// truly untouched" bit.
export const REQUIRED_SETUP_TABLES = ['tiers', 'groups', 'days_of_operation', 'time_blocks']

export function campHasSetupData(db) {
  for (const table of REQUIRED_SETUP_TABLES) {
    const row = db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
    if (row) return true
  }
  return false
}
