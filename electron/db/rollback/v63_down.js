// Inverse of migration v63 (electron/db/localDb.js): drops the
// `import_decisions` table added by T173 slice 1
// (docs/superpowers/specs/2026-09-15-seedlings-importer-learning-design.md).
//
//   1. DROP TABLE import_decisions — schema-only, same as the table's own
//      creation. Every row is a diagnostic journal entry, not director-
//      authored camp data, so nothing here is unrecoverable in the way a
//      camp entity would be; the loss is only future learning-design evidence.
//   2. No registry membership to undo: import_decisions was never added to
//      PROJECTIONS, DIRECT_CAMP_ENTITIES, or campDocument.js's
//      MODELED_ENTITIES (it is host-local by design, like compound_cell_
//      decisions), so there is nothing there for this script to touch.
//   3. `>= 63`, not `= 63` (v32_down/v46_down/v59_down precedent): a later
//      migration's schema_migrations row surviving this rollback would make
//      getSchemaVersion() report higher than 63, defeating the v63
//      migration's own `>= 62 && < 63` guard on the next initSchema().
//
// Usage:  node electron/db/rollback/v63_down.js <path-to-shoresh.sqlite>

export function rollbackV63(db) {
  const discarded = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='import_decisions'").get().c
    ? db.prepare('SELECT COUNT(*) c FROM import_decisions').get().c
    : 0

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS import_decisions')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 63').run()
  })()

  return { discardedRows: discarded, dataRestored: false }
}

// Direct invocation (node electron/db/rollback/v63_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v63_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v63_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV63(db)
  console.log(JSON.stringify(result))
  db.close()
}
