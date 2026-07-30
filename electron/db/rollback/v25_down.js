// Inverse of migration v25 (electron/db/localDb.js): drops pending_restores,
// the local-only durable queue of undelivered restore requests
// (docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md).
//
// Dropping the table IS the whole rollback, and that is demonstrated rather
// than assumed:
//   - No foreign keys in either direction. Nothing in schema.sql references
//     pending_restores, and it references nothing (requested_by is a bare
//     TEXT column on purpose, following pending_writes, so a queue row can
//     never become uninsertable or undeletable because a users row moved).
//   - No registry membership. It is absent from PROJECTIONS
//     (electron/ops/projections.js), from DIRECT_CAMP_ENTITIES and
//     PARENT_SCOPED_ENTITIES (electron/ops/campScopedEntities.js) and from
//     PERMISSIONS.ENTITIES (electron/auth/permissions.js), so no read, write,
//     sync or authorize path resolves the name.
//   - It holds intent, not data. The worst case on drop is that an
//     undelivered restore request disappears; the deleted record and its full
//     history are untouched in `operations`, and the director can press
//     Restore again.
//
// DIFFERENT FROM v24, and support must not treat the two as equally
// hazardous. Both share the same durability caveat — CURRENT_SCHEMA_VERSION
// is 25 and getSchemaVersion() reads MAX(version), so the SAME app build
// re-runs v25 on the next launch — but re-application here simply recreates
// an EMPTY table, whereas v24's re-application re-adopted rows. A rollback
// only sticks alongside a downgrade to a pre-v25 binary; running it against
// the current build is harmless either way.
//
// Feature rollback is a separate, and usually better, lever: because restore
// executes on the Host, a Host that no longer answers restore_request only
// degrades Clients to the queued/waiting state — never to data loss. Reverting
// the commit is the primary rollback; this script exists so the schema can be
// walked back independently.
//
// Usage:  node electron/db/rollback/v25_down.js <path-to-shoresh.sqlite>

export function rollbackV25(db) {
  const pending = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_restores'")
    .get()
    ? db.prepare('SELECT COUNT(*) c FROM pending_restores').get().c
    : 0

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS pending_restores')
    db.prepare('DELETE FROM schema_migrations WHERE version = 25').run()
  })()

  return { discardedRequests: pending }
}

// Direct invocation (node electron/db/rollback/v25_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v25_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v25_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV25(db)
  db.close()
  console.log(`v25 rolled back: ${result.discardedRequests} undelivered restore request(s) discarded`)
  console.log(
    'NOTE: this app build still declares schema version 25 — reopening it recreates ' +
    'pending_restores as an empty table. No data is at risk either way; the deleted ' +
    'records and their history live in `operations`, untouched.'
  )
}
