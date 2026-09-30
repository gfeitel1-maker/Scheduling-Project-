// Inverse of migration v72 (electron/db/localDb.js) -- T233, the `tombstones`
// table (docs/adr/2026-09-19-multi-device-erasure-propagation.md).
//
//   1. The forward v72 block is MARKER-ONLY: it never creates `tombstones`
//      itself -- schema.sql's `CREATE TABLE IF NOT EXISTS tombstones` already
//      runs unconditionally on every open, so the table exists before the v72
//      guard is even reached. The v72 migration block's entire body is a
//      single `INSERT OR IGNORE INTO schema_migrations (version, applied_at)
//      VALUES (72, ...)` backfilling the version marker.
//   2. The honest inverse of a marker-only forward migration is a
//      marker-only rollback: delete the `schema_migrations` row(s) >= 72 and
//      touch nothing else. There is no table this migration introduced to
//      drop, because it did not introduce one.
//   3. `tombstones` and every row in it SURVIVE this rollback ON PURPOSE.
//      They are Host-signed, monotonically-versioned purge-tombstones that
//      the accepted ADR requires to propagate erasure between devices --
//      dropping the table would destroy that propagation state for no
//      rollback benefit, and schema.sql would simply recreate the table
//      empty on the next open anyway, which is strictly worse than leaving
//      it alone: real data loss in exchange for nothing undone.
//   4. No registry membership restored: this script does not touch
//      PROJECTIONS (electron/ops/projections.js) -- same ruling as every
//      other schema-only rollback in this directory.
//
// Usage:  node electron/db/rollback/v72_down.js <path-to-shoresh.sqlite>

export function rollbackV72(db) {
  db.prepare('DELETE FROM schema_migrations WHERE version >= 72').run()

  return { droppedTables: [] }
}

// Direct invocation (node electron/db/rollback/v72_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v72_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v72_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  rollbackV72(db)
  db.close()
  console.log(
    'v72 rolled back: schema_migrations row(s) >= 72 removed. The `tombstones` table and all its ' +
    'rows were left untouched -- this migration never created that table (schema.sql does, on ' +
    'every open, regardless of version), so there was nothing for this rollback to drop. This app ' +
    'build still declares schema version 72 -- reopening it re-stamps the marker.'
  )
}
