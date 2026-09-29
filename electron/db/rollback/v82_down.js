// Inverse of migration v82 (electron/db/localDb.js) — T312, a camp's remembered
// column mapping for the elective preference import.
//
//   1. `DROP TABLE camp_seedlings`, and its one index goes with it. v82 added a
//      table and touched no existing one, so there is nothing to recreate-and-copy
//      (v51_down's shape) and no column to drop out of a table-level CHECK
//      (v80_down's concern). The table's only CHECK is column-level on `status`
//      and is dropped with the table.
//   2. The index is NOT dropped separately. SQLite drops an index with its table,
//      and an explicit `DROP INDEX` after the table is gone is an error rather
//      than a no-op on some builds. Stated because the reflex is to mirror the
//      migration statement for statement.
//   3. No registry membership restored: this script does not touch PROJECTIONS
//      (electron/ops/projections.js), MODELED_ENTITIES
//      (electron/automerge/campDocument.js), DIRECT_CAMP_ENTITIES
//      (electron/ops/campScopedEntities.js) or src/localClient.mock.js. Those are
//      separate, deliberate code changes a schema-only rollback does not undo,
//      and the correct failure mode is to revert them together with running this
//      script rather than to have this script paper over it. Same ruling as
//      v77_down point 4, v79_down point 3 and v80_down point 3.
//   4. THIS ENTITY REPLICATES, and that changes what a
//      rollback means. Dropping the table removes this device's PROJECTION of
//      the rows; it does not remove them from the Automerge document, and it
//      does not tell any peer. A device still on v82 keeps its copy and will
//      re-send it. So this is a local un-projection, not a fleet erasure — if the
//      intent is that no device remembers these mappings, that is a purge
//      (T233's path), not this script.
//   5. Data loss, stated as the consequence rather than the row count: every
//      column mapping a director confirmed is forgotten ON THIS DEVICE, so the
//      next import of a sheet this camp has imported before asks the mapping
//      question again from scratch. Nothing a camper submitted is touched —
//      `payload` holds header text and rank numbers only, by design (ADR §6.0),
//      and no preference, camper or run row is read or written here.
//
// Usage:  node electron/db/rollback/v82_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

/**
 * @returns {{ok:true, discarded:{seedlings:number, activeSeedlings:number}}}
 */
export function rollbackV82(db) {
  // BOTH NUMBERS, and they differ for a reason worth keeping. `seedlings` counts
  // every row including superseded ones — the history of what this camp has
  // confirmed. `activeSeedlings` counts only the rows that would actually have
  // pre-filled a mapping screen, which is the number a director would recognise
  // as "mappings I no longer have". Reporting only the total would overstate the
  // loss; reporting only the active count would hide that the history goes too.
  const discarded = { seedlings: 0, activeSeedlings: 0 }

  if (hasTable(db, 'camp_seedlings')) {
    discarded.seedlings = db.prepare('SELECT COUNT(*) c FROM camp_seedlings').get().c
    discarded.activeSeedlings = db
      .prepare("SELECT COUNT(*) c FROM camp_seedlings WHERE status = 'active'")
      .get().c
    db.exec('DROP TABLE camp_seedlings')
  }

  // `>= 81`, never `= 81`. A bare equality leaves any LATER migration row behind,
  // so a database rolled back from a future version would claim a version whose
  // shape it no longer has — the class this repo has a dedicated guard for
  // (bareEqualityRollback.guard.test.js). Unconditional, outside the hasTable
  // branch: a table already dropped by hand must still lower the claimed version,
  // or initSchema will not re-create it.
  db.prepare('DELETE FROM schema_migrations WHERE version >= 82').run()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v82_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v82_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v82_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV82(db)
  db.close()
  console.log(
    `v82 rolled back: dropped camp_seedlings with ${result.discarded.seedlings} row(s), ` +
    `${result.discarded.activeSeedlings} of them active. The next import of a sheet this camp ` +
    'has imported before will ask for its column mapping again from scratch. No camper data is ' +
    'affected — the table held header text and rank numbers only. NOTE: this entity REPLICATES, ' +
    'so this removes only THIS device\'s projection; a peer still on v82 keeps its copy and will ' +
    're-send it. This app build still declares schema version 82 — reopening it re-adds the ' +
    'table, empty.'
  )
}
