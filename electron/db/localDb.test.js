// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from './localDb.js'

let tmpFile

afterEach(() => {
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('openLocalDb', () => {
  it('creates all expected tables', () => {
    tmpFile = path.join(os.tmpdir(), `shoresh-test-${Date.now()}.sqlite`)
    const db = openLocalDb(tmpFile)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    expect(tables).toEqual(expect.arrayContaining([
      'camps', 'users', 'devices', 'operations', 'locks', 'groups', 'tiers', 'activities', 'template_slots',
    ]))
    db.close()
  })

  it('enforces foreign keys', () => {
    tmpFile = path.join(os.tmpdir(), `shoresh-test-${Date.now()}.sqlite`)
    const db = openLocalDb(tmpFile)
    expect(() => {
      db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('g1', 'nonexistent-camp', 'Aleph')
    }).toThrow()
    db.close()
  })
})

describe('openLocalDb at-rest key guard', () => {
  afterEach(() => {
    delete process.env.SHORESH_AT_REST_ENCRYPTION
    vi.resetModules()
  })

  it('refuses to open with a named error when encryption is on and no key was supplied', async () => {
    process.env.SHORESH_AT_REST_ENCRYPTION = 'on'
    vi.resetModules()
    const { openLocalDb: openLocalDbEncOn } = await import('./localDb.js')

    tmpFile = path.join(os.tmpdir(), `shoresh-test-guard-${Date.now()}.sqlite`)
    // Simulate an encrypted-on-disk file: garbage, non-SQLite bytes. The guard must fire before
    // any open is attempted, regardless of what's on disk.
    fs.writeFileSync(tmpFile, Buffer.from('not a sqlite file, pretend encrypted bytes'))

    let caught
    try {
      openLocalDbEncOn(tmpFile, {})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(caught.code).toBe('db_key_unavailable')
    expect(caught.message).toMatch(/key/i)
    expect(caught.message).toMatch(/KEY_RECOVERY_STORY/)
  })

  it('is inert when encryption is off — opens normally with no key', async () => {
    delete process.env.SHORESH_AT_REST_ENCRYPTION
    vi.resetModules()
    const { openLocalDb: openLocalDbEncOff } = await import('./localDb.js')

    tmpFile = path.join(os.tmpdir(), `shoresh-test-guard-off-${Date.now()}.sqlite`)
    const db = openLocalDbEncOff(tmpFile, {})
    expect(db).toBeDefined()
    db.close()
  })
})
