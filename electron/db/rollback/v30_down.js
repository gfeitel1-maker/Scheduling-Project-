// Inverse of migration v30 (electron/db/localDb.js): drops source_aliases,
// the host-local "this imported label means this existing entity" memory
// (docs/adr/2026-08-09-s1b-host-local-aliases.md).
//
// Dropping the table IS the whole rollback, the same demonstration v25_down
// gives for pending_restores:
//   - No foreign keys in either direction. Nothing in schema.sql references
//     source_aliases, and entity_id is deliberately plain TEXT (entity_type
//     varies; no single-table target), so nothing becomes uninsertable or
//     undeletable because a row in another table moved.
//   - No registry membership. It is absent from PROJECTIONS
//     (electron/ops/projections.js), from DIRECT_CAMP_ENTITIES (electron/
//     ops/campScopedEntities.js) and from PERMISSIONS.ENTITIES (electron/
//     auth/permissions.js), so no read, write, sync or authorize path
//     resolves the name.
//   - It holds memory, not data. The worst case on drop is that confirmed
//     aliases are forgotten and a director re-confirms them on the next
//     import; the entities themselves and their full op-log history are
//     untouched.
//
// Usage:  node electron/db/rollback/v30_down.js <path-to-shoresh.sqlite>

export function rollbackV30(db) {
  const aliases = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_aliases'")
    .get()
    ? db.prepare('SELECT COUNT(*) c FROM source_aliases').get().c
    : 0

  db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS idx_source_aliases_lookup')
    db.exec('DROP TABLE IF EXISTS source_aliases')
    db.prepare('DELETE FROM schema_migrations WHERE version = 30').run()
  })()

  return { discardedAliases: aliases }
}

// Direct invocation (node electron/db/rollback/v30_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v30_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v30_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV30(db)
  db.close()
  console.log(`v30 rolled back: ${result.discardedAliases} confirmed alias(es) discarded`)
  console.log(
    'NOTE: this app build still declares schema version 30 — reopening it recreates ' +
    'source_aliases as an empty table. No data is at risk either way; the entities the ' +
    'aliases pointed to and their full history live untouched in `operations`.'
  )
}
