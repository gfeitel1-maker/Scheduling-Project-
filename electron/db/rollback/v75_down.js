// Inverse of migration v75 (electron/db/localDb.js): drops the
// activities.catalog_role column it added (T266,
// docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md).
// Follows the v74_down.js / v71_down.js convention: presence-checked,
// reporting a discarded count, idempotent.
//
// What rolling this back actually COSTS, stated plainly rather than as
// boilerplate. The column is the only record of which activity rows ingest
// pass 1/2 claimed as pinned events. Dropping it does NOT delete any activity
// row — the rows were never duplicates, they are the events' identities, and
// anchor name resolution keeps working exactly as it did before v75. What comes
// back is the v74-and-earlier BEHAVIOUR: those event rows reappear in the
// free-choice catalogue and in the engine's placeable pool. That is the reported
// symptom returning, not data loss. The classification is recoverable by
// re-importing the source sheet.
//
// Usage:  node electron/db/rollback/v75_down.js <path-to-shoresh.sqlite>

export function rollbackV75(db) {
  // Count BEFORE dropping, so the report is honest about what went. This is the
  // number of activity rows that will re-enter the free-choice catalogue.
  const cols = db.pragma('table_info(activities)').map((c) => c.name)
  const discarded = {
    pinnedEventMarkers: cols.includes('catalog_role')
      ? db.prepare("SELECT COUNT(*) c FROM activities WHERE catalog_role IS NOT NULL").get().c
      : 0,
  }

  db.transaction(() => {
    const has = () => db.pragma('table_info(activities)').map((c) => c.name).includes('catalog_role')
    if (has()) {
      db.exec('ALTER TABLE activities DROP COLUMN catalog_role')
    }

    // `>= 75`, not `= 75` — this repo's convention since v46_down (see T220): a
    // bare equality strands any HIGHER version in the table, so rolling back v75
    // on a database that has since migrated further leaves getSchemaVersion()
    // reporting the higher version while v75's column is gone — a shape no
    // migration path can produce and none will repair.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 75').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v75_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v75_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v75_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV75(db)
  db.close()
  console.log(`v75 rolled back: discarded ${result.pinnedEventMarkers} pinned-event marker(s)`)
  console.log(
    'NOTE: this app build still declares schema version 75 — reopening it recreates the column, ' +
    'but every marker is NULL again, so pinned events reappear in the free-choice catalogue until ' +
    'the source sheet is re-imported.'
  )
}
