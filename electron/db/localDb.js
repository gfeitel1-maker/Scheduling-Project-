import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function initSchema(db) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  db.exec(schema)
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(
    new Date().toISOString()
  )
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(
    new Date().toISOString()
  )

  if (getSchemaVersion(db) < 4) {
    const campIdColumn = db
      .pragma('table_info(users)')
      .find((col) => col.name === 'camp_id')
    const campIdIsNotNull = campIdColumn ? campIdColumn.notnull === 1 : false

    if (campIdIsNotNull) {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE users_new (
            id TEXT PRIMARY KEY,
            camp_id TEXT REFERENCES camps(id),
            name TEXT NOT NULL,
            pin_hash TEXT NOT NULL,
            pin_salt TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'staff'))
          );
          INSERT INTO users_new SELECT * FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_users_camp_name ON users(camp_id, name);
        `)
      })()
    }

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)').run(
      new Date().toISOString()
    )
  }

  if (getSchemaVersion(db) < 5) {
    const hasLastSyncedAt = db
      .pragma('table_info(devices)')
      .some((col) => col.name === 'last_synced_at')

    if (!hasLastSyncedAt) {
      db.exec('ALTER TABLE devices ADD COLUMN last_synced_at TEXT')
    }

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?)').run(
      new Date().toISOString()
    )
  }

  if (getSchemaVersion(db) < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        name TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT
      );
    `)

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (6, ?)').run(
      new Date().toISOString()
    )
  }

  // Task 10 round-4 Fix 3: per-device op-log watermark so a reconnecting
  // device can be sent exactly the `operations` rows it missed while it was
  // offline (see syncServer.js's sendMissedOps). Distinct from
  // last_synced_at, which only gates the one-time first-pairing full_sync of
  // users/camps and is never advanced afterward.
  if (getSchemaVersion(db) < 7) {
    const hasLastSyncedSeq = db
      .pragma('table_info(devices)')
      .some((col) => col.name === 'last_synced_seq')

    if (!hasLastSyncedSeq) {
      db.exec('ALTER TABLE devices ADD COLUMN last_synced_seq INTEGER')
    }

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (7, ?)').run(
      new Date().toISOString()
    )
  }

  // Task 10 round-5 Fix 1 (durable write queue) and Fix 3 (retry idempotency
  // key): add the pending_writes table and the operations.client_write_id
  // column to existing databases that predate this schema.
  if (getSchemaVersion(db) < 8) {
    const hasClientWriteId = db
      .pragma('table_info(operations)')
      .some((col) => col.name === 'client_write_id')

    if (!hasClientWriteId) {
      db.exec('ALTER TABLE operations ADD COLUMN client_write_id TEXT')
    }

    // Created here (not in schema.sql's unconditional exec) because this
    // column may only just have been added above by the ALTER on a
    // pre-migration db — see the comment on this index's omission in
    // schema.sql for why.
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_client_write_id ON operations(client_write_id) WHERE client_write_id IS NOT NULL'
    )

    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_writes (
        pending_id TEXT PRIMARY KEY,
        client_write_id TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT,
        parent_op_id TEXT,
        created_at TEXT NOT NULL
      );
    `)

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (8, ?)').run(
      new Date().toISOString()
    )
  }
}

export function openLocalDb(filePath) {
  let db
  try {
    db = new Database(filePath)
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    initSchema(db)
  } catch (err) {
    throw new Error(`Failed to open local database at ${filePath}: ${err.message}`)
  }
  return db
}

export function getSchemaVersion(db) {
  const row = db.prepare('SELECT MAX(version) as version FROM schema_migrations').get()
  return row && row.version != null ? row.version : 0
}

export function getOrCreateDeviceId(db) {
  const existing = db.prepare('SELECT id FROM device_identity LIMIT 1').get()
  if (existing) return existing.id
  const id = randomUUID()
  db.prepare('INSERT INTO device_identity (id, created_at) VALUES (?, ?)').run(
    id,
    new Date().toISOString()
  )
  return id
}
