// Inverse of migration v66 (electron/db/localDb.js): drops the seven
// participant-substrate tables and the two capacity columns on
// elective_set_activities (T194, docs/adr/2026-09-17-individual-elective-
// scheduling.md, docs/work/specs/2026-09-17-t194-participant-substrate-
// design.md §7.2). Follows the v35_down.js / v39_down.js convention:
// presence-checked, reporting a discarded count, idempotent.
//
// DISCLOSED ROLLBACK LOSS — and the distinction below is load-bearing.
//
// Every campers, elective_preferences and elective_assignments row is dropped
// and is unrecoverable FROM THE PROJECTION. It remains recoverable in
// principle from the op-log and from the Automerge document, NEITHER of which
// a rollback touches.
//
// So: A ROLLBACK IS NOT A PURGE. It reduces the PII footprint on disk; it does
// not erase a child's record. A director who runs one has not deleted anyone.
// The real purge path is ADR D10 / T202.
//
// NO REASSURANCE ABOUT camper_headcount. An earlier draft of this comment said
// the column "still holds the legacy value, so authored capacity is not lost"
// — reassuring exactly where it cannot apply and false where it will (round 2,
// M4/M5). v66 RETIRES camper_headcount from the write path, so capacity
// authored after v66 lives only in capacity_mode/capacity_limit and IS lost
// from the projection by this rollback; and because camper_headcount is no
// longer a projected field at all, applyProjection drops ops on it and a
// rebuild-from-document recreates rows with it NULL. Recovery is real, but it
// is the one stated two paragraphs above — the document and the op-log — not a
// surviving column.
//
// ROUND 7 ADDENDUM — projection_failures.op_id's FK to operations(id) was
// also dropped in place (schema.sql, and a table-rebuild step folded into the
// v66 migration block in localDb.js, since CREATE TABLE IF NOT EXISTS is a
// no-op on any db that already has the table). This rollback does NOT restore
// that FK: doing so would require re-validating every existing op_id against
// operations(id), and any 'document-replay' row (whose op_id is a
// deterministic string, not a real operations(id)) would then fail to
// reinsert. The FK removal is one-way; rolling back v66 rolls back the seven
// participant tables and the two capacity columns only.
//
// Usage:  node electron/db/rollback/v66_down.js <path-to-shoresh.sqlite>

// Reverse DOMAIN_SNAPSHOT_ORDER, so foreign_keys = ON never sees a dangling
// child: every table is dropped before the table it declares a REFERENCES to.
const DROP_ORDER = [
  'elective_assignments',
  'elective_preferences',
  'elective_choice_offerings',
  'elective_choices',
  'elective_occurrences',
  'elective_assignment_runs',
  'campers',
]

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

const countIfPresent = (db, table) =>
  hasTable(db, table) ? db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c : 0

export function rollbackV66(db) {
  // Count BEFORE destroying, so the report is honest about what went.
  const discarded = {
    campers: countIfPresent(db, 'campers'),
    electivePreferences: countIfPresent(db, 'elective_preferences'),
    electiveAssignments: countIfPresent(db, 'elective_assignments'),
  }

  db.transaction(() => {
    for (const t of DROP_ORDER) db.exec(`DROP TABLE IF EXISTS ${t}`)

    const esaCols = () => db.pragma('table_info(elective_set_activities)').map((c) => c.name)
    // capacity_limit first: it is the later column, and dropping in reverse
    // declaration order keeps the remaining column order stable.
    if (esaCols().includes('capacity_limit')) {
      db.exec('ALTER TABLE elective_set_activities DROP COLUMN capacity_limit')
    }
    if (esaCols().includes('capacity_mode')) {
      db.exec('ALTER TABLE elective_set_activities DROP COLUMN capacity_mode')
    }

    // `>= 66`, not `= 66`. This repo's convention since v46_down, and stated in
    // PLATFORM_STATE: a bare equality strands any HIGHER version in the table, so
    // rolling back v66 on a database that has since migrated to v67 leaves
    // getSchemaVersion() reporting 67 while v66's tables are gone — a shape no
    // migration path can produce and none will repair. v67 (T162) is the first
    // migration stacked on top of this one, and is what exposed it.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 66').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v66_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v66_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v66_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV66(db)
  db.close()
  console.log(
    `v66 rolled back: discarded ${result.campers} camper(s), ` +
      `${result.electivePreferences} preference(s), ${result.electiveAssignments} assignment(s)`
  )
  console.log(
    'NOTE: this app build still declares schema version 66 — reopening it recreates the seven ' +
    'tables, which the Automerge document then repopulates on the next projection. A ROLLBACK ' +
    'IS NOT A PURGE: the op-log and the Automerge document are not touched, so these records ' +
    'still exist off-projection. The purge path is T202.'
  )
}
