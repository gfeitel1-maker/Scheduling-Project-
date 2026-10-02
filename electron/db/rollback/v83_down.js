// Inverse of migration v83 (electron/db/localDb.js) — T320, docs/adr/2026-09-30-
// elective-run-durability.md.
//
//   1. `DROP TABLE elective_run_findings`. v83 also adds two columns to
//      elective_assignment_runs (snapshot_expected_rows, snapshot_digest); those
//      are NOT dropped — see point 2.
//   2. THE TWO NEW COLUMNS ARE LEFT IN PLACE. SQLite's DROP COLUMN requires a
//      recreate-and-copy (v51_down's shape, v80_down's concern), and unlike v82's
//      dedicated table, elective_assignment_runs is a large, heavily-registered,
//      replicated entity — recreating it in a narrow rollback script risks far
//      more than it fixes. The columns are left in place, NULL-valued once
//      schema_migrations drops below 83, which is harmless: no code at schema
//      version < 83 reads them.
//   3. No registry membership restored: this script does not touch PROJECTIONS
//      (electron/ops/projections.js), MODELED_ENTITIES/GENESIS_ENTITIES
//      (electron/automerge/campDocument.js), DIRECT_CAMP_ENTITIES/
//      PARENT_SCOPED_ENTITIES (electron/ops/campScopedEntities.js),
//      PARTICIPANT_ENTITIES (electron/ops/participantEntities.js) or
//      undoReferences.js. Same ruling as v82_down point 3.
//   4. THIS ENTITY REPLICATES, and that changes what a rollback means. Dropping
//      the table removes this device's PROJECTION of the rows; it does not
//      remove them from the Automerge document, and it does not tell any peer.
//      A device still on v83 keeps its copy and will re-send it. So this is a
//      local un-projection, not a fleet erasure.
//   5. Data loss, stated as the consequence rather than the row count: every
//      persisted eligibility finding is forgotten ON THIS DEVICE; the run's
//      recorded snapshot expectation stays in place (point 2), so
//      snapshotIncomplete detection keeps working even after this rollback —
//      only the findings table is actually gone.
//
// Usage:  node electron/db/rollback/v83_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

/**
 * @returns {{ok:true, discarded:{findings:number}}}
 */
import { assertHighestApplied } from './assertHighestApplied.js'

export function rollbackV83(db) {
  const discarded = { findings: 0 }

  if (hasTable(db, 'elective_run_findings')) {
    discarded.findings = db.prepare('SELECT COUNT(*) c FROM elective_run_findings').get().c
    db.exec('DROP TABLE elective_run_findings')
  }

  // `>= 83`, never `= 83` — a bare equality leaves any LATER migration row
  // behind, so a database rolled back from a future version would claim a
  // version whose shape it no longer has (bareEqualityRollback.guard.test.js).
  db.prepare('DELETE FROM schema_migrations WHERE version >= 83').run()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v83_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v83_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v83_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 83)
  const result = rollbackV83(db)
  db.close()
  console.log(
    `v83 rolled back: dropped elective_run_findings with ${result.discarded.findings} row(s). ` +
    'elective_assignment_runs.snapshot_expected_rows/snapshot_digest are left in place (harmless — ' +
    'nothing below v83 reads them). NOTE: this entity REPLICATES, so this removes only THIS ' +
    'device\'s projection; a peer still on v83 keeps its copy and will re-send it. This app build ' +
    'still declares schema version 83: reopening it re-adds the table, empty.'
  )
}
