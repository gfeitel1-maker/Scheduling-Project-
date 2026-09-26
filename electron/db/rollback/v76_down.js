// Inverse of migration v76 (electron/db/localDb.js): drops the four additive
// elective_run_outer_snapshots columns (cell_kind, choice_id, is_linked_choice, choice_label) added by T197
// (docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md). Follows the
// v74_down.js convention: presence-checked, reporting a discarded count, idempotent.
//
// Usage:  node electron/db/rollback/v76_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

export function rollbackV76(db) {
  const discarded = {
    inheritedRows: hasTable(db, 'elective_run_outer_snapshots')
      ? db.prepare("SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE cell_kind = 'inherited'").get().c
      : 0,
    linkedChoiceRows: hasTable(db, 'elective_run_outer_snapshots')
      ? db.prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE is_linked_choice = 1').get().c
      : 0,
  }

  db.transaction(() => {
    const cols = () => db.pragma('table_info(elective_run_outer_snapshots)').map((c) => c.name)
    // Reverse declaration order, same convention as v74_down.js.
    if (cols().includes('choice_label')) {
      db.exec('ALTER TABLE elective_run_outer_snapshots DROP COLUMN choice_label')
    }
    if (cols().includes('is_linked_choice')) {
      db.exec('ALTER TABLE elective_run_outer_snapshots DROP COLUMN is_linked_choice')
    }
    if (cols().includes('choice_id')) {
      db.exec('ALTER TABLE elective_run_outer_snapshots DROP COLUMN choice_id')
    }
    if (cols().includes('cell_kind')) {
      db.exec('ALTER TABLE elective_run_outer_snapshots DROP COLUMN cell_kind')
    }

    // `>= 76`, not `= 76` — see v74_down.js's own comment for why a bare equality strands a
    // higher version.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 76').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v76_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v76_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v76_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV76(db)
  db.close()
  console.log(
    `v76 rolled back: discarded ${result.inheritedRows} inherited-cell row(s), ` +
    `${result.linkedChoiceRows} linked-choice row(s)`
  )
  console.log(
    'NOTE: this app build still declares schema version 76 — reopening it recreates these columns.'
  )
}
