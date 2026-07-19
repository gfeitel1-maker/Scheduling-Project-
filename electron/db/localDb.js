import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function initSchema(db) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  db.exec(schema)
}

export function openLocalDb(filePath) {
  const db = new Database(filePath)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}
