// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  getCurrentProjectPath,
  setCurrentProjectPath,
  readRecentProjects,
  addRecentProject,
  writeUserBackup,
  writePreMigrationBackup,
} from './projectManager.js'
import { openLocalDb, CURRENT_SCHEMA_VERSION, getSchemaVersion } from './localDb.js'

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-pm-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// getCurrentProjectPath / setCurrentProjectPath
// ---------------------------------------------------------------------------
describe('getCurrentProjectPath', () => {
  it('returns defaultPath when no current-project.json exists', () => {
    const def = '/default/shoresh.sqlite'
    expect(getCurrentProjectPath(tmpDir, def)).toBe(def)
  })

  it('returns stored path when the file exists on disk', () => {
    const dbFile = path.join(tmpDir, 'mycamp.db')
    fs.writeFileSync(dbFile, '') // touch so existsSync passes
    setCurrentProjectPath(tmpDir, dbFile)
    expect(getCurrentProjectPath(tmpDir, '/default')).toBe(dbFile)
  })

  it('falls back to defaultPath when stored path no longer exists on disk', () => {
    setCurrentProjectPath(tmpDir, '/does/not/exist.db')
    expect(getCurrentProjectPath(tmpDir, '/default')).toBe('/default')
  })
})

// ---------------------------------------------------------------------------
// addRecentProject / readRecentProjects
// ---------------------------------------------------------------------------
describe('recent projects', () => {
  it('returns empty array when file missing', () => {
    expect(readRecentProjects(tmpDir)).toEqual([])
  })

  it('adds an entry and reads it back', () => {
    const dbFile = path.join(tmpDir, 'camp.db')
    fs.writeFileSync(dbFile, '')
    addRecentProject(tmpDir, { path: dbFile, campName: 'Test Camp' })
    const entries = readRecentProjects(tmpDir)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(dbFile)
    expect(entries[0].campName).toBe('Test Camp')
    expect(entries[0].lastOpenedAt).toBeTruthy()
  })

  it('prepends new entry and deduplicates by path', () => {
    const db1 = path.join(tmpDir, 'a.db')
    const db2 = path.join(tmpDir, 'b.db')
    fs.writeFileSync(db1, '')
    fs.writeFileSync(db2, '')
    addRecentProject(tmpDir, { path: db1, campName: 'Camp A' })
    addRecentProject(tmpDir, { path: db2, campName: 'Camp B' })
    addRecentProject(tmpDir, { path: db1, campName: 'Camp A updated' })
    const entries = readRecentProjects(tmpDir)
    expect(entries[0].path).toBe(db1)
    expect(entries[0].campName).toBe('Camp A updated')
    // db2 still present, db1 not duplicated
    expect(entries).toHaveLength(2)
  })

  it('caps list at 5 entries', () => {
    for (let i = 0; i < 7; i++) {
      const f = path.join(tmpDir, `c${i}.db`)
      fs.writeFileSync(f, '')
      addRecentProject(tmpDir, { path: f, campName: `Camp ${i}` })
    }
    expect(readRecentProjects(tmpDir)).toHaveLength(5)
  })

  it('filters out entries whose files no longer exist', () => {
    const live = path.join(tmpDir, 'live.db')
    fs.writeFileSync(live, '')
    addRecentProject(tmpDir, { path: '/dead/path.db', campName: 'Dead' })
    addRecentProject(tmpDir, { path: live, campName: 'Live' })
    // Write the raw JSON with the dead path ourselves to simulate deletion.
    fs.writeFileSync(
      path.join(tmpDir, 'recent-projects.json'),
      JSON.stringify([
        { path: live, campName: 'Live', lastOpenedAt: new Date().toISOString() },
        { path: '/dead/path.db', campName: 'Dead', lastOpenedAt: new Date().toISOString() },
      ])
    )
    const entries = readRecentProjects(tmpDir)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(live)
  })
})

// ---------------------------------------------------------------------------
// writeUserBackup — rotation
// ---------------------------------------------------------------------------
describe('writeUserBackup', () => {
  it('creates a backup file', () => {
    const dbFile = path.join(tmpDir, 'shoresh.db')
    fs.writeFileSync(dbFile, 'data')
    const backupPath = writeUserBackup(dbFile, tmpDir)
    expect(fs.existsSync(backupPath)).toBe(true)
    expect(fs.readFileSync(backupPath, 'utf8')).toBe('data')
  })

  it('rotates backups to keep max 10', () => {
    const dbFile = path.join(tmpDir, 'shoresh.db')
    const backupDir = path.join(tmpDir, 'backups')
    fs.mkdirSync(backupDir)
    // Pre-create 10 dummy backup files with distinct mtimes.
    for (let i = 0; i < 10; i++) {
      const f = path.join(backupDir, `shoresh-2024-0${i < 9 ? '0' : ''}${i + 1}T000000-000Z.db`)
      fs.writeFileSync(f, `backup ${i}`)
      // Touch mtime so oldest is index 0.
      const mtime = new Date(2024, 0, i + 1)
      fs.utimesSync(f, mtime, mtime)
    }
    fs.writeFileSync(dbFile, 'latest data')
    writeUserBackup(dbFile, tmpDir)
    const remaining = fs.readdirSync(backupDir).filter(f => /^shoresh-.*\.db$/.test(f))
    expect(remaining).toHaveLength(10)
  })
})

// ---------------------------------------------------------------------------
// writePreMigrationBackup
// ---------------------------------------------------------------------------
describe('writePreMigrationBackup', () => {
  it('creates a .bak file alongside the db', () => {
    const dbFile = path.join(tmpDir, 'shoresh.db')
    fs.writeFileSync(dbFile, 'db contents')
    const bakPath = writePreMigrationBackup(dbFile)
    expect(bakPath).toBeTruthy()
    expect(fs.existsSync(bakPath)).toBe(true)
    expect(bakPath).toMatch(/\.pre-migration-.*\.bak$/)
  })

  it('returns null for a non-existent file (fresh db)', () => {
    const result = writePreMigrationBackup(path.join(tmpDir, 'nonexistent.db'))
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// openLocalDb — schema-too-new guard
// ---------------------------------------------------------------------------
describe('schema_too_new guard', () => {
  it('creates a valid DB at the current schema version', () => {
    const dbFile = path.join(tmpDir, 'current.db')
    const db = openLocalDb(dbFile)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('throws with code schema_too_new when file version exceeds CURRENT_SCHEMA_VERSION', () => {
    // Write a DB that claims to be at a future schema version.
    const dbFile = path.join(tmpDir, 'future.db')
    const raw = new Database(dbFile)
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)')
    raw.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(CURRENT_SCHEMA_VERSION + 1, new Date().toISOString())
    raw.close()

    expect(() => openLocalDb(dbFile)).toThrow(expect.objectContaining({ code: 'schema_too_new' }))
  })

  it('writes a pre-migration backup when existing version is below current', () => {
    // Create a DB at version 19 (one behind current 20) and verify a .bak appears.
    const dbFile = path.join(tmpDir, 'old.db')
    const raw = new Database(dbFile)
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)')
    // Insert versions 1–19 so getSchemaVersion returns 19 < 20.
    for (let v = 1; v < CURRENT_SCHEMA_VERSION; v++) {
      raw.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?, ?)').run(v, new Date().toISOString())
    }
    raw.close()

    // openLocalDb will attempt to run migration 20 after writing a .bak.
    // It will fail because the DB is minimal (missing real tables), but the
    // .bak must already exist at that point. We catch the failure.
    try { openLocalDb(dbFile) } catch { /* expected — minimal db */ }

    const baks = fs.readdirSync(tmpDir).filter(f => f.endsWith('.bak'))
    expect(baks.length).toBeGreaterThanOrEqual(1)
  })
})
