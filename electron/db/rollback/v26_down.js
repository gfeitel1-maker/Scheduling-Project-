// Inverse of migration v26 (electron/db/localDb.js).
//
// v26 deletes rows, which is why its journal carries the FULL deleted row as
// JSON rather than v24's pair of template ids: there is nothing left in the
// database to compute the inverse from. Each journalled row is re-inserted
// through an explicit per-table column whitelist, so a future ALTER TABLE that
// adds a column cannot silently produce a positional mismatch.
//
// THE VERSION IS LEFT IN PLACE, deliberately. Two reasons, the second stronger:
// the director may already have restored from it, so removing it would turn a
// rollback into a data loss; and this codebase has already decided that
// deleting a Version is the director's call and never an automatic cleanup
// (see deleteSnapshot in src/screens/ScheduleScreen.jsx). Consequence support
// should NOT read as a bug: after a rollback the week exists TWICE — the
// restored rows and the retained Version. A Version is inert until restored, so
// this is harmless and strictly safer than the alternative. `--purge-snapshots`
// exists for a supervised cleanup when a director asks; it is off by default.
//
// NOT DURABLE ON ITS OWN. CURRENT_SCHEMA_VERSION is 26 and getSchemaVersion()
// reads MAX(version), so deleting the version row makes the SAME app build
// re-run v26 on the next launch and re-delete what this just restored. Run with
// the app quit, and downgrade to a pre-v26 build before reopening. (v26's
// snapshot id is deterministic, so a rollback/roll-forward cycle at least
// cannot accumulate duplicate Versions in the director's list.)
//
// Usage:
//   node electron/db/rollback/v26_down.js <path-to-shoresh.sqlite> [--purge-journal] [--purge-snapshots]
// The journal is KEPT by default so support can see exactly what was retired.

// Whitelist, never interpolate an unchecked table name into SQL.
const COLUMNS = {
  template_slots: [
    'id', 'template_id', 'group_id', 'activity_id', 'day_id', 'time_block_id',
    'flags', 'is_released', 'is_span_head', 'anchor_id', 'is_anchor',
  ],
  template_overlays: [
    'id', 'template_id', 'unit_id', 'day_id', 'from_block_order', 'to_block_order', 'label',
  ],
}

export function rollbackV26(db, { purgeJournal = false, purgeSnapshots = false } = {}) {
  const hasJournal = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration_v26_retired_orphan_log'")
    .get()
  if (!hasJournal) return { restored: 0, unrestorable: 0, snapshotsRemoved: 0 }

  let restored = 0
  let unrestorable = 0
  let snapshotsRemoved = 0
  db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, table_name, row_id, row_json, snapshot_id
           FROM migration_v26_retired_orphan_log
          WHERE outcome = 'retired' ORDER BY id DESC`
      )
      .all()

    for (const r of rows) {
      const columns = COLUMNS[r.table_name]
      if (!columns) {
        throw new Error(`migration_v26_retired_orphan_log holds an unknown table_name: ${r.table_name}`)
      }
      const row = JSON.parse(r.row_json)
      // INSERT OR IGNORE: idempotent, and a no-op for any row that is somehow
      // already back.
      //
      // Per-row, not all-or-nothing. template_overlays carries a real FK to
      // schedule_templates, so an overlay row that WAS orphaned cannot be
      // re-inserted under its parentless template_id — SQLite refuses. Letting
      // that abort the whole rollback would throw away the template_slots rows
      // this exists to restore, and those have no FK and always come back. In
      // the field the case is unreachable (the same FK, with PRAGMA
      // foreign_keys = ON, is why orphan overlays cannot arise at all), so this
      // is a floor, not an expected path — but a rollback that restores less
      // than everything must say so rather than fail silently or fail entirely.
      try {
        const res = db
          .prepare(
            `INSERT OR IGNORE INTO ${r.table_name} (${columns.join(', ')})
             VALUES (${columns.map(() => '?').join(', ')})`
          )
          .run(...columns.map((c) => (row[c] === undefined ? null : row[c])))
        restored += res.changes
      } catch {
        unrestorable += 1
      }
    }

    if (purgeSnapshots) {
      const ids = [...new Set(rows.map((r) => r.snapshot_id).filter(Boolean))]
      for (const id of ids) {
        snapshotsRemoved += db.prepare('DELETE FROM schedule_snapshots WHERE id = ?').run(id).changes
      }
    }

    db.prepare('DELETE FROM schema_migrations WHERE version = 26').run()
    if (purgeJournal) db.exec('DROP TABLE migration_v26_retired_orphan_log')
  })()

  return { restored, unrestorable, snapshotsRemoved }
}

// Direct invocation (node electron/db/rollback/v26_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v26_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error(
      'usage: node electron/db/rollback/v26_down.js <path-to-shoresh.sqlite> [--purge-journal] [--purge-snapshots]'
    )
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV26(db, {
    purgeJournal: process.argv.includes('--purge-journal'),
    purgeSnapshots: process.argv.includes('--purge-snapshots'),
  })
  db.close()
  console.log(
    `v26 rolled back: ${result.restored} row(s) restored, ${result.unrestorable} could not be restored, ` +
    `${result.snapshotsRemoved} version(s) removed`
  )
  console.log(
    'NOTE: the recovered Version is kept unless --purge-snapshots was passed, so the week now ' +
    'exists both as schedule rows and as a saved Version. That is expected, not a fault.'
  )
  console.log(
    'WARNING: this app build still declares schema version 26 — reopening it re-applies v26 ' +
    'and re-retires these rows. Downgrade to a pre-v26 build before launching the app again.'
  )
}
