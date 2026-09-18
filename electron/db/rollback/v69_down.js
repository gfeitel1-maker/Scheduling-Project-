// Inverse of migration v69 (electron/db/localDb.js): drops the rendezvous_sequence table — the
// T210 device-local, disposable publish sequence for signed rendezvous records
// (docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md, Decision 2).
//
// DISCLOSED ROLLBACK LOSS: this device's current rendezvous sequence counter is discarded. That is
// harmless by design — the ADR states `seq` is disposable and need not be gapless, only
// increasing, and it is never synced or replicated (the same exclusion class as
// device_identity_key/host_signing_key), so there is nothing here a rollback could strand on
// another device.
//
// Usage:  node electron/db/rollback/v69_down.js <path-to-shoresh.sqlite>

export function rollbackV69(db) {
  const discarded = {
    lastSequence:
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rendezvous_sequence'").get()
        ? (db.prepare('SELECT seq FROM rendezvous_sequence WHERE id = 1').get()?.seq ?? 0)
        : 0,
  }

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS rendezvous_sequence')

    // `>= 69`, not `= 69` — a bare equality strands any HIGHER version in the table (T220
    // convention, electron/db/rollback/bareEqualityRollback.guard.test.js).
    db.prepare('DELETE FROM schema_migrations WHERE version >= 69').run()
  })()

  return discarded
}

// Direct invocation (node electron/db/rollback/v69_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v69_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v69_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV69(db)
  db.close()
  console.log(`v69 rolled back: rendezvous sequence counter (was ${result.lastSequence}) discarded`)
  console.log(
    'NOTE: this app build still declares a higher schema version — reopening it recreates the ' +
    'rendezvous_sequence table starting at 0. Harmless: the counter is device-local and disposable.'
  )
}
