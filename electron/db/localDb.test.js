// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
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
