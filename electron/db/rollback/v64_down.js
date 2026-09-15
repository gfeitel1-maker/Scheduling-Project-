// Inverse of migration v64 (electron/db/localDb.js): drops the
// `import_decision_failures` table.
//
//   1. DROP TABLE import_decision_failures — schema-only. Every row is a
//      diagnostic (a decision-journal write that failed), never director-
//      authored camp data, so nothing here is unrecoverable in the way a
//      camp entity would be.
//   2. No registry membership to undo — never added to PROJECTIONS,
//      DIRECT_CAMP_ENTITIES, or campDocument.js's MODELED_ENTITIES
//      (host-local by design, like sync_health_events / T174).
//   3. `>= 64`, not `= 64` (v32_down/v46_down/v59_down/v63_down precedent):
//      a later migration's schema_migrations row surviving this rollback
//      would make getSchemaVersion() report higher than 64, defeating the
//      v64 migration's own `>= 63 && < 64` guard on the next initSchema().
//
// Usage:  node electron/db/rollback/v64_down.js <path-to-shoresh.sqlite>

export function rollbackV64(db) {
  const discarded = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='import_decision_failures'").get().c
    ? db.prepare('SELECT COUNT(*) c FROM import_decision_failures').get().c
    : 0

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS import_decision_failures')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 64').run()
  })()

  return { discardedRows: discarded, dataRestored: false }
}

// Direct invocation (node electron/db/rollback/v64_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v64_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v64_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV64(db)
  console.log(JSON.stringify(result))
  db.close()
}
