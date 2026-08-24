// Inverse of migration v47 (electron/db/localDb.js): drops
// declined_two_row_splits, the host-local "director said no to this split
// suggestion" memory (docs/adr/2026-08-23-two-rows-multipattern-split.md,
// docs/work/specs/2026-08-23-two-rows-slice2-affordance.md "Decline-memory").
//
// Dropping the table IS the whole rollback, the same demonstration v30_down
// gives for source_aliases:
//   - No foreign keys FROM anything else — nothing in schema.sql references
//     declined_two_row_splits.
//   - No registry membership. It is absent from PROJECTIONS (electron/ops/
//     projections.js), from DIRECT_CAMP_ENTITIES (electron/ops/
//     campScopedEntities.js) and from PERMISSIONS.ENTITIES (electron/auth/
//     permissions.js), so no read, write, sync or authorize path resolves
//     the name.
//   - It holds memory, not data. The worst case on drop is that a declined
//     split suggestion is forgotten and the director sees the suggestion
//     again on the next import; the activities it concerns and their full
//     op-log history are untouched.
//
// Usage:  node electron/db/rollback/v47_down.js <path-to-shoresh.sqlite>

export function rollbackV47(db) {
  const declines = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'declined_two_row_splits'")
    .get()
    ? db.prepare('SELECT COUNT(*) c FROM declined_two_row_splits').get().c
    : 0

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS declined_two_row_splits')
    db.prepare('DELETE FROM schema_migrations WHERE version = 47').run()
  })()

  return { discardedDeclines: declines }
}

// Direct invocation (node electron/db/rollback/v47_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v47_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v47_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV47(db)
  db.close()
  console.log(`v47 rolled back: ${result.discardedDeclines} declined split(s) discarded`)
  console.log(
    'NOTE: this app build still declares schema version 47 — reopening it recreates ' +
    'declined_two_row_splits as an empty table. No data is at risk either way; the activities ' +
    'the declines concerned and their full history live untouched in `operations`.'
  )
}
