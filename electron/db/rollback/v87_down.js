// Inverse of migration v87 (electron/db/localDb.js) — q-elective-finding-id-
// collision-rekey-safe (2A).
//
//   1. `ALTER TABLE elective_run_findings DROP COLUMN label_key` — the column
//      sits in no index and no CHECK constraint, so the plain single-statement
//      form applies (v79_down's shape, not v51_down's recreate-and-copy).
//   2. No registry membership to restore: v87 did not add label_key to
//      PROJECTIONS for the first time — it widened an EXISTING entry
//      (elective_run_findings was already registered since v83). Nothing else
//      changes.
//   3. Data loss: every `label_key` value is discarded. There is no prior
//      value to restore — the column did not exist before v87 — but it is
//      also not provenance the way v79's division_label was: a future commit
//      on the SAME run re-derives and re-persists the finding (and its
//      label_key) the next time that run is regenerated, so the loss is
//      recoverable by regeneration rather than permanent. Until then, the
//      ONLY practical consequence is the defect this column exists to fix
//      reappears: two assignment-only BUNDLE_TIER_NOT_COVERED mismatches for
//      one camper on two different labels can again collide to one row on
//      the NEXT write that derives their id (deriveElectiveRunFindingId
//      treats a null labelKey as "no 7th component").
//
// Usage:  node electron/db/rollback/v87_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

const hasColumn = (db, table, column) =>
  hasTable(db, table) && db.pragma(`table_info(${table})`).some((c) => c.name === column)

/**
 * @returns {{ok:true, discarded:{labelKeys:number}}}
 */
export function rollbackV87(db) {
  const discarded = {
    labelKeys: hasColumn(db, 'elective_run_findings', 'label_key')
      ? db.prepare('SELECT COUNT(*) c FROM elective_run_findings WHERE label_key IS NOT NULL').get().c
      : 0,
  }

  db.transaction(() => {
    if (hasColumn(db, 'elective_run_findings', 'label_key')) {
      db.exec('ALTER TABLE elective_run_findings DROP COLUMN label_key')
    }
    // `>= 87`, never `= 87` — a bare equality strands any HIGHER version in
    // the table, so rolling back v87 on a database that has since migrated
    // further leaves getSchemaVersion() reporting the higher version while
    // v87's column is gone: a shape no migration path can produce and none
    // will repair (bareEqualityRollback.guard.test.js).
    db.prepare('DELETE FROM schema_migrations WHERE version >= 87').run()
  })()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v87_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v87_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v87_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV87(db)
  db.close()
  console.log(
    `v87 rolled back: discarded ${result.discarded.labelKeys} elective_run_findings.label_key value(s). ` +
    'There was no prior value to restore, since the column did not exist before v87 — a future ' +
    'regeneration of the same run re-derives and re-persists it. This app build still declares ' +
    'schema version 87: reopening it re-adds the column, empty.'
  )
}
