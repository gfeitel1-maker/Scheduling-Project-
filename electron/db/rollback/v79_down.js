// Inverse of migration v79 (electron/db/localDb.js) — T279:
// docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md
// (§12.6, §13.3).
//
//   1. `ALTER TABLE campers DROP COLUMN division_label` — the column sits in no
//      index and no CHECK constraint, so the plain single-statement form
//      applies (v77_down's shape, not v51_down's recreate-and-copy).
//   2. `ALTER TABLE elective_preferences DROP COLUMN rank_kind` — same.
//   2b. The same for `coordinate_day_label` and `coordinate_period_label`. This
//      is the LOSSIEST part of the rollback and the one to read twice: those two
//      columns are the only record of WHICH CELL a per-cell preference belongs
//      to. Dropping them does not merely lose a label — it collapses a child's
//      several per-cell answers into indistinguishable rows, because
//      deriveElectivePreferenceId's 'at' arm is what kept them apart. Rolling
//      back therefore reintroduces exactly the data loss v79 was taken to fix,
//      and the only way back is to re-import the source file.
//   3. No registry membership restored: this script does not touch PROJECTIONS
//      (electron/ops/projections.js) or src/localClient.mock.js. Those are
//      separate, deliberate code changes a schema-only rollback does not undo,
//      and the correct failure mode is to revert them together with running
//      this script rather than to have this script paper over it. Same ruling
//      as v77_down point 4.
//   4. Data loss: every `division_label` and `rank_kind` value is discarded.
//      There is no prior value to restore — neither column existed before v79
//      — and neither is derivable from what remains: `division_label` is
//      PROVENANCE (what the source file said), which nothing else in the db
//      records, so re-importing the same file is the only way back. `group_id`
//      is untouched throughout, so the RESOLVED half of §12.2a's pair
//      survives; it is the unresolved half that goes.
//
// Usage:  node electron/db/rollback/v79_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

const hasColumn = (db, table, column) =>
  hasTable(db, table) && db.pragma(`table_info(${table})`).some((c) => c.name === column)

/**
 * @returns {{ok:true, discarded:{divisionLabels:number, rankKinds:number}}}
 */
export function rollbackV79(db) {
  const discarded = {
    divisionLabels: hasColumn(db, 'campers', 'division_label')
      ? db.prepare('SELECT COUNT(*) c FROM campers WHERE division_label IS NOT NULL').get().c
      : 0,
    rankKinds: hasColumn(db, 'elective_preferences', 'rank_kind')
      ? db.prepare('SELECT COUNT(*) c FROM elective_preferences WHERE rank_kind IS NOT NULL').get().c
      : 0,
  }

  db.transaction(() => {
    if (hasColumn(db, 'campers', 'division_label')) {
      db.exec('ALTER TABLE campers DROP COLUMN division_label')
    }
    if (hasColumn(db, 'elective_preferences', 'rank_kind')) {
      db.exec('ALTER TABLE elective_preferences DROP COLUMN rank_kind')
    }
    for (const column of ['coordinate_day_label', 'coordinate_period_label']) {
      if (hasColumn(db, 'elective_preferences', column)) {
        db.exec(`ALTER TABLE elective_preferences DROP COLUMN ${column}`)
      }
    }
    // `>= 79`, not `= 79` — a bare equality strands any HIGHER version in the
    // table, so rolling back v79 on a database that has since migrated further
    // leaves getSchemaVersion() reporting the higher version while v79's
    // columns are gone: a shape no migration path can produce and none will
    // repair. Convention since v46_down (T220).
    db.prepare('DELETE FROM schema_migrations WHERE version >= 79').run()
  })()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v79_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v79_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v79_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV79(db)
  db.close()
  console.log(
    `v79 rolled back: discarded ${result.discarded.divisionLabels} campers.division_label and ` +
    `${result.discarded.rankKinds} elective_preferences.rank_kind value(s). There was no prior ` +
    'value to restore, since neither column existed before v79, and division_label is provenance ' +
    'no other row records — re-importing the source file is the only way back. This app build ' +
    'still declares schema version 79 — reopening it re-adds both columns, empty.'
  )
}
