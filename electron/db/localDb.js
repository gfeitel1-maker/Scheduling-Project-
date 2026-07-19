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
