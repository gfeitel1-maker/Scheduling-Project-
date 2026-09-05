// Tests for the ingestion CLI core (T51). Mirrors
// test/integration/scenarios/21-ingest-prior-year.js's temp-db setup, but
// drives the exported runIngestCli directly — not via a subprocess — so
// these exercise real logic and stay fast enough to be the focused gate.

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { openLocalDb } from '../electron/db/localDb.js'
import { runIngestCli } from './ingestCli.js'

const SAMPLE = path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt')

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-cli-'))
}

function bootstrapDb(dir) {
  const dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  const campId = randomUUID()
  const deviceId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Host')
  db.close()
  return { dbPath, campId, deviceId }
}

describe('runIngestCli', () => {
  const dirs = []
  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('--preview writes nothing and reports created/updated/unchanged/conflict counts plus residuals', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const before = openLocalDb(dbPath)
    const countsBefore = {
      groups: before.prepare('SELECT COUNT(*) c FROM groups').get().c,
      activities: before.prepare('SELECT COUNT(*) c FROM activities').get().c,
      ops: before.prepare('SELECT COUNT(*) c FROM operations').get().c,
    }
    before.close()

    const result = runIngestCli({ file: SAMPLE, dbPath, action: 'preview' })

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.summary.created.groups).toBe(14)
    expect(result.summary.held).toBe(false)
    expect(result.summary.conflicts).toBe(0)
    expect(typeof result.summary.unchanged).toBe('number')
    expect(Array.isArray(result.residual.cells)).toBe(true)
    expect(Array.isArray(result.residual.sheets)).toBe(true)

    const after = openLocalDb(dbPath)
    expect(after.prepare('SELECT COUNT(*) c FROM groups').get().c).toBe(countsBefore.groups)
    expect(after.prepare('SELECT COUNT(*) c FROM activities').get().c).toBe(countsBefore.activities)
    expect(after.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(countsBefore.ops)
    after.close()
  })

  it('--commit writes the expected rows', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const result = runIngestCli({ file: SAMPLE, dbPath, action: 'commit' })

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.summary.created.groups).toBe(14)

    const db = openLocalDb(dbPath)
    expect(db.prepare('SELECT COUNT(*) c FROM groups').get().c).toBe(14)
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'groups'").get().c).toBeGreaterThan(0)
    db.close()
  })

  it('--json result has the stable documented keys', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const result = runIngestCli({ file: SAMPLE, dbPath, action: 'preview', json: true })

    for (const key of ['ok', 'action', 'mode', 'file', 'db', 'error', 'summary', 'conflicts', 'residual', 'exitCode']) {
      expect(result).toHaveProperty(key)
    }
    for (const key of ['created', 'updated', 'unchanged', 'conflicts', 'held', 'total', 'fixedEventsCreated']) {
      expect(result.summary).toHaveProperty(key)
    }
  })

  it('errors on a missing file', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const result = runIngestCli({ file: path.join(dir, 'nope.txt'), dbPath, action: 'preview' })

    expect(result.ok).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.error).toMatch(/cannot read file/)
  })

  it('errors on a missing db', () => {
    const dir = makeTmpDir()
    dirs.push(dir)

    const result = runIngestCli({ file: SAMPLE, dbPath: path.join(dir, 'nope.sqlite'), action: 'preview' })

    expect(result.ok).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.error).toMatch(/db not found/)
  })

  it('errors on a db with no camp bootstrapped', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const dbPath = path.join(dir, 'shoresh.sqlite')
    openLocalDb(dbPath).close() // fresh schema, no camps row

    const result = runIngestCli({ file: SAMPLE, dbPath, action: 'preview' })

    expect(result.ok).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.error).toMatch(/no camp bootstrapped/)
  })

  it('attributes written ops to --author when given, and leaves them unattributed when omitted', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)
    const db0 = openLocalDb(dbPath)
    const userId = randomUUID()
    db0.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, (SELECT id FROM camps LIMIT 1), 'Ruth', 'h', 's', 'admin')")
      .run(userId)
    db0.close()

    const withAuthor = runIngestCli({ file: SAMPLE, dbPath, action: 'commit', authorUserId: userId })
    expect(withAuthor.ok).toBe(true)

    const db1 = openLocalDb(dbPath)
    const unattributed = db1
      .prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'groups' AND author_user_id IS NULL")
      .get().c
    const attributed = db1
      .prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'groups' AND author_user_id = ?")
      .get(userId).c
    expect(unattributed).toBe(0)
    expect(attributed).toBeGreaterThan(0)
    db1.close()
  })

  it('leaves ops unattributed when --author is omitted', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const result = runIngestCli({ file: SAMPLE, dbPath, action: 'commit' })
    expect(result.ok).toBe(true)

    const db = openLocalDb(dbPath)
    const attributed = db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'groups' AND author_user_id IS NOT NULL").get().c
    expect(attributed).toBe(0)
    db.close()
  })

  it('re-importing the same file twice creates nothing new the second time', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    runIngestCli({ file: SAMPLE, dbPath, action: 'commit' })
    const second = runIngestCli({ file: SAMPLE, dbPath, action: 'commit' })

    expect(second.ok).toBe(true)
    expect(second.summary.created.groups).toBe(0)
    expect(second.summary.created.activities).toBe(0)
  })
})
