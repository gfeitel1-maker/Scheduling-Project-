// Inverse of migration v31 (electron/db/localDb.js): drops import_evidence,
// the host-local "what did the source data show" memory behind an import's
// inferred fields (docs/adr/2026-08-10-ingestion-evidence-persistence.md).
//
// Dropping the table IS the whole rollback, the same demonstration v30_down
// gives for source_aliases:
//   - No foreign keys in either direction. Nothing in schema.sql references
//     import_evidence, and entity_id is deliberately plain TEXT (entity_type
//     varies; no single-table target), so nothing becomes uninsertable or
//     undeletable because a row in another table moved.
//   - No registry membership. It is absent from PROJECTIONS
//     (electron/ops/projections.js), from DIRECT_CAMP_ENTITIES (electron/
//     ops/campScopedEntities.js) and from every full-sync payload builder, so
//     no read, write, sync or authorize path resolves the name.
//   - It holds memory, not data. The worst case on drop is that a director's
//     "why does Shoresh think this?" answer is gone until the camp's next
//     re-import; the entities themselves and their full op-log history are
//     untouched.
//
// Usage:  node electron/db/rollback/v31_down.js <path-to-shoresh.sqlite>

export function rollbackV31(db) {
  const evidence = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'import_evidence'")
    .get()
    ? db.prepare('SELECT COUNT(*) c FROM import_evidence').get().c
    : 0

  db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS idx_import_evidence_latest')
    db.exec('DROP TABLE IF EXISTS import_evidence')
    db.prepare('DELETE FROM schema_migrations WHERE version = 31').run()
  })()

  return { discardedEvidence: evidence }
}

// Direct invocation (node electron/db/rollback/v31_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v31_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v31_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV31(db)
  db.close()
  console.log(`v31 rolled back: ${result.discardedEvidence} import evidence row(s) discarded`)
  console.log(
    'NOTE: this app build still declares schema version 31 — reopening it recreates ' +
    'import_evidence as an empty table. No data is at risk either way; the entities the ' +
    'evidence described and their full history live untouched in `operations`.'
  )
}
