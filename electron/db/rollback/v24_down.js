// Inverse of migration v24 (electron/db/localDb.js).
//
// v24 only ever moves a child row FROM a template_id with no parent row TO a
// template_id with one, and only into a child table that was empty for that
// parent. The inverse moves each journalled row back, newest-first, guarded on
// the row still sitting where v24 put it — so it is idempotent and a no-op for
// any row the director has since moved themselves.
//
// NOT DURABLE ON ITS OWN. CURRENT_SCHEMA_VERSION in electron/db/localDb.js is
// 24 and getSchemaVersion() reads MAX(version), so deleting the version row
// makes the SAME app build re-run v24 on the next launch and re-adopt whatever
// this script just reverted. A rollback only sticks if the app binary is
// downgraded to a pre-v24 build (or the app is kept closed) at the same time.
// Run this with the app quit, and downgrade before reopening.
//
// Usage:  node electron/db/rollback/v24_down.js <path-to-shoresh.sqlite> [--purge-journal]
// The journal is KEPT by default, so a rollback can itself be rolled forward
// again and so support can see exactly what moved.

// Whitelist, never interpolate an unchecked table name into SQL.
const TABLES = new Set(['template_slots', 'template_overlays', 'schedule_snapshots'])

export function rollbackV24(db, { purgeJournal = false } = {}) {
  const hasJournal = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration_v24_repoint_log'")
    .get()
  if (!hasJournal) return { reverted: 0 }

  let reverted = 0
  db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, table_name, row_id, old_template_id, new_template_id
           FROM migration_v24_repoint_log ORDER BY id DESC`
      )
      .all()

    for (const r of rows) {
      if (!TABLES.has(r.table_name)) {
        throw new Error(`migration_v24_repoint_log holds an unknown table_name: ${r.table_name}`)
      }
      const res = db
        .prepare(`UPDATE ${r.table_name} SET template_id = ? WHERE id = ? AND template_id = ?`)
        .run(r.old_template_id, r.row_id, r.new_template_id)
      reverted += res.changes
    }

    db.prepare('DELETE FROM schema_migrations WHERE version = 24').run()
    if (purgeJournal) db.exec('DROP TABLE migration_v24_repoint_log')
  })()

  return { reverted }
}

// Direct invocation (node electron/db/rollback/v24_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v24_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v24_down.js <path-to-shoresh.sqlite> [--purge-journal]')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV24(db, { purgeJournal: process.argv.includes('--purge-journal') })
  db.close()
  console.log(`v24 rolled back: ${result.reverted} row(s) restored`)
  console.log(
    'WARNING: this app build still declares schema version 24 — reopening it re-applies v24 ' +
    'and re-adopts these rows. Downgrade to a pre-v24 build before launching the app again.'
  )
}
