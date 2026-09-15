// Rollback for v64 — renames device_health_events back to sync_health_events.
//
// v64 folded three diagnostic tables into one and renamed it to match what it
// actually holds. Rolling back restores the old name; rows whose `kind` is
// 'import_journal_write_failed' will then sit in a table named for sync health,
// which is the inaccuracy v64 existed to remove. They are diagnostics, so this
// is untidy rather than harmful — but it is why rolling back past v64 is not
// something to do casually.
import Database from 'better-sqlite3'

export function down(dbPath) {
  const db = new Database(dbPath)
  try {
    const hasNew = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_health_events'").get()
    const hasOld = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_health_events'").get()
    if (hasNew && !hasOld) db.exec('ALTER TABLE device_health_events RENAME TO sync_health_events')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 64').run()
  } finally {
    db.close()
  }
}
