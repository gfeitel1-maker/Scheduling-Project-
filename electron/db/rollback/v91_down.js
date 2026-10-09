// Inverse of migration v91 (electron/db/localDb.js) — T311: recreates pending_writes and
// pending_restores, EMPTY, exactly as schema.sql declared them at v90.
//
//   1. Both were device-local offline queues, vestigial since the Stage 6c cutover (nothing read
//      or wrote them), so the dropped rows are not recoverable and not missed. The DDL below is
//      the text that schema.sql / the v8 and v25 migration blocks carried at v90 (the v25 copy is
//      PENDING_RESTORES_DDL in localDb.js).
//   2. No registry membership to restore: neither was ever in PROJECTIONS, DIRECT_CAMP_ENTITIES,
//      PARENT_SCOPED_ENTITIES or MODELED_ENTITIES.
//   3. Reopening this build re-applies v91 and drops them again — a rollback only sticks
//      alongside a downgrade to a pre-v91 binary. Harmless either way: nothing uses the tables.
//
// Usage:  node electron/db/rollback/v91_down.js <path-to-shoresh.sqlite>

import { assertHighestApplied } from './assertHighestApplied.js'

const PENDING_WRITES_DDL = `CREATE TABLE IF NOT EXISTS pending_writes (
  pending_id TEXT PRIMARY KEY,
  client_write_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  parent_op_id TEXT,
  created_at TEXT NOT NULL
)`

const PENDING_RESTORES_DDL = `CREATE TABLE IF NOT EXISTS pending_restores (
  pending_id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE (entity, entity_id)
)`

export function rollbackV91(db) {
  db.transaction(() => {
    db.exec(PENDING_WRITES_DDL)
    db.exec(PENDING_RESTORES_DDL)
    // `>= 91`, never `= 91` (bareEqualityRollback.guard.test.js's class).
    db.prepare('DELETE FROM schema_migrations WHERE version >= 91').run()
  })()
  return { ok: true }
}

// Direct invocation (node electron/db/rollback/v91_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v91_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v91_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 91)
  rollbackV91(db)
  db.close()
  console.log(
    'v91 rolled back: pending_writes and pending_restores recreated empty. NOTE: this app build ' +
    'still declares schema version 91: reopening it drops both tables again.'
  )
}
