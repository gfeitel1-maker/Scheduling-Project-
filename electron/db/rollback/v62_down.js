// Rollback for v62 (T174) — drops sync_health_events.
//
// Safe to run: the table holds this device's own diagnostics (a document save
// that failed, a merged document that would not project). Nothing else reads it
// and no camp data depends on it. Dropping it loses the record of past
// divergences on this device, which is a real loss for support but not a loss of
// camp state.
import Database from 'better-sqlite3'

export function down(dbPath) {
  const db = new Database(dbPath)
  try {
    db.exec('DROP TABLE IF EXISTS sync_health_events')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 62').run()
  } finally {
    db.close()
  }
}
