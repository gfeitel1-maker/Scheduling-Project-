// Inverse of migration v77 (electron/db/localDb.js) — T267:
// docs/adr/2026-09-26-fixed-recurring-event-identity-model.md.
//
//   1. Drop `fixed_event_identity_gaps` entirely — a SQLite-only migration-time
//      worklist (never modeled in PROJECTIONS/MODELED_ENTITIES), so nothing
//      else references it and there is no registry membership to clean up.
//   2. `ALTER TABLE fixed_events DROP COLUMN activity_id` — unlike v51's `kind`
//      (referenced by a table-level CHECK, which SQLite's DROP COLUMN
//      refuses), `activity_id` sits in no index and no CHECK constraint, so
//      the plain single-statement form applies here (v42_down's shape, not
//      v51_down's recreate-and-copy).
//   3. `ALTER TABLE fixed_events RENAME TO anchor_activities` — the inverse of
//      the v77 rename, mirroring the v64 block's `sync_health_events` <->
//      `device_health_events` precedent for a genuine cross-name rename.
//   4. No registry membership restored: this script does not touch
//      PROJECTIONS (electron/ops/projections.js), campDocument.js's
//      MODELED_ENTITIES, seed.js, or src/localClient.mock.js — those are
//      separate, deliberate code changes a schema-only rollback does not
//      undo. A build still running the v77 code (which expects the table
//      named `fixed_events`) would fail its next query against this db; the
//      correct failure mode is to also revert those code changes together
//      with running this script, not to have this script paper over it.
//   5. Data loss: `activity_id` values written by the v77 backfill (or by any
//      write path built on top of it) are discarded — there is no prior
//      non-null value to restore, since the column did not exist before v77.
//      Names (`name`) are untouched throughout, so re-running the v77
//      backfill logic after a future re-migration would reproduce the same
//      resolution it produced before, given the same catalog state.
//   6. Clears the durable domain_state_migration_pending marker for version 77
//      (v70_down.js's identical precedent) — the forward migration writes one
//      when the backfill resolves any row, and reversing the migration must
//      not leave a stale marker refusing sync for a version this db no
//      longer declares.
//
// Usage:  node electron/db/rollback/v77_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

export function rollbackV77(db) {
  const discarded = {
    identityGaps: hasTable(db, 'fixed_event_identity_gaps')
      ? db.prepare('SELECT COUNT(*) c FROM fixed_event_identity_gaps').get().c
      : 0,
  }

  db.transaction(() => {
    if (hasTable(db, 'fixed_event_identity_gaps')) {
      db.exec('DROP TABLE fixed_event_identity_gaps')
    }
    if (hasTable(db, 'fixed_events')) {
      const cols = db.pragma('table_info(fixed_events)').map((c) => c.name)
      if (cols.includes('activity_id')) {
        db.exec('ALTER TABLE fixed_events DROP COLUMN activity_id')
      }
      if (!hasTable(db, 'anchor_activities')) {
        db.exec('ALTER TABLE fixed_events RENAME TO anchor_activities')
      }
    }
    // `>= 77`, not `= 77` — a bare equality strands any HIGHER version in the table, so rolling
    // back v77 on a database that has since migrated further leaves getSchemaVersion() reporting
    // the higher version while v77's rename is undone — a shape no migration path can produce and
    // none will repair. Convention since v46_down (see T220), reused by v71_down.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 77').run()
    if (hasTable(db, 'domain_state_migration_pending')) {
      db.prepare('DELETE FROM domain_state_migration_pending WHERE version = 77').run()
    }
  })()

  return { discarded, renamed: ['fixed_events -> anchor_activities'] }
}

// Direct invocation (node electron/db/rollback/v77_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v77_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v77_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV77(db)
  db.close()
  console.log(`v77 rolled back: ${result.renamed.join(', ')}`)
  console.log(
    `NOTE: discarded ${result.discarded.identityGaps} fixed_event_identity_gaps row(s) and every ` +
    'activity_id value — there was no prior value to restore, since the column did not exist ' +
    'before v77. This app build still declares schema version 77 — reopening it re-runs the ' +
    'rename and backfill.'
  )
}
