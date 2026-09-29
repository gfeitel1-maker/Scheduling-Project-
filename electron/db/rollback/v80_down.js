// Inverse of migration v80 (electron/db/localDb.js) — T265, the minimum
// headcount to run an elective offering.
//
//   1. `ALTER TABLE elective_set_activities DROP COLUMN min_to_run` and the same
//      for `min_mode`. Both sit in no index and in no TABLE-level CHECK — each
//      carries only its OWN column-level CHECK, which SQLite drops along with the
//      column — so the plain single-statement form applies (v77_down/v79_down's
//      shape, not v51_down's recreate-and-copy). Verified against the bundled
//      SQLite rather than assumed: a column named in a table-level CHECK cannot
//      be dropped this way, and that is why the CHECKs here are per-column.
//   2. min_to_run is dropped FIRST. Order does not matter to SQLite here, but it
//      keeps the value column from outliving the authority column that governs
//      it, so no intermediate state has a minimum nothing can interpret.
//   3. No registry membership restored: this script does not touch PROJECTIONS
//      (electron/ops/projections.js) or src/localClient.mock.js. Those are
//      separate, deliberate code changes a schema-only rollback does not undo,
//      and the correct failure mode is to revert them together with running this
//      script rather than to have this script paper over it. Same ruling as
//      v77_down point 4 and v79_down point 3.
//   4. Data loss: every minimum a director set is discarded. There is no prior
//      value to restore — neither column existed before v80 — and neither is
//      derivable from what remains. The consequence to state plainly is not the
//      lost number but the lost CONSTRAINT: after this rollback an offering with
//      two campers runs again and nothing says otherwise, which is the state
//      T265 exists to end. A director who had set minimums must set them again.
//
// Usage:  node electron/db/rollback/v80_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

const hasColumn = (db, table, column) =>
  hasTable(db, table) && db.pragma(`table_info(${table})`).some((c) => c.name === column)

/**
 * @returns {{ok:true, discarded:{requiredMinimums:number, statedValues:number}}}
 */
export function rollbackV80(db) {
  // BOTH HALVES ARE COUNTED, and they are different numbers. `requiredMinimums`
  // is how many offerings ENFORCE a minimum (min_mode = 'required') — the
  // constraint actually being lost. `statedValues` is how many hold a non-NULL
  // min_to_run, which includes rows whose mode is 'none' and whose value is
  // therefore inert. Reporting only the second would overstate the loss;
  // reporting only the first would hide values a director typed and would see
  // vanish.
  const count = (where) =>
    hasColumn(db, 'elective_set_activities', 'min_mode')
      ? db.prepare(`SELECT COUNT(*) c FROM elective_set_activities WHERE ${where}`).get().c
      : 0

  const discarded = {
    requiredMinimums: count("min_mode = 'required'"),
    statedValues: hasColumn(db, 'elective_set_activities', 'min_to_run')
      ? db.prepare('SELECT COUNT(*) c FROM elective_set_activities WHERE min_to_run IS NOT NULL').get().c
      : 0,
  }

  db.transaction(() => {
    for (const column of ['min_to_run', 'min_mode']) {
      if (hasColumn(db, 'elective_set_activities', column)) {
        db.exec(`ALTER TABLE elective_set_activities DROP COLUMN ${column}`)
      }
    }
    // `>= 80`, not `= 80` — a bare equality strands any HIGHER version in the
    // table, so rolling back v80 on a database that has since migrated further
    // leaves getSchemaVersion() reporting the higher version while v80's columns
    // are gone: a shape no migration path can produce and none will repair.
    // Convention since v46_down (T220).
    db.prepare('DELETE FROM schema_migrations WHERE version >= 80').run()
  })()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v80_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v80_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v80_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV80(db)
  db.close()
  console.log(
    `v80 rolled back: discarded ${result.discarded.requiredMinimums} enforced minimum(s) and ` +
    `${result.discarded.statedValues} stated min_to_run value(s). There was no prior value to ` +
    'restore, since neither column existed before v80. What is lost is the CONSTRAINT, not just ' +
    'the number: an offering below its minimum will run again and nothing will say so, and any ' +
    'minimum a director had set must be set again. This app build still declares schema version ' +
    '80 — reopening it re-adds both columns, empty.'
  )
}
