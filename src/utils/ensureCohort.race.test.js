// @vitest-environment node
//
// Round 2 Red Hat fix (Sub-plan B Task 2), HIGH finding 1: a real
// concurrent-race regression test, not just a unit test of the guard logic
// in isolation. Two ensureCohort() calls run against the SAME underlying
// SQLite db (via electron/ops/operations.js's real appendOp, exactly what
// production IPC ends up calling), with each localClient.write() deferred a
// tick so the two calls' field-write loops genuinely interleave — the exact
// window the original bug lived in.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../../electron/db/localDb.js'
import { appendOp } from '../../electron/ops/operations.js'

let tmpFile
let db

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
  },
}))

import { ensureCohort } from './ensureCohort'
import { localClient } from '../localClient'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-race-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device')

  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })

  let uuidCounter = 0
  vi.stubGlobal('crypto', { randomUUID: () => `race-cohort-id-${++uuidCounter}` })

  localClient.list.mockReset().mockImplementation(async () => {
    return db.prepare('SELECT * FROM cohorts').all()
  })
  localClient.write.mockReset().mockImplementation(async (_token, _entity, entity_id, field, value) => {
    // Defer a tick so two in-flight ensureCohort() field-write loops actually
    // interleave, instead of one running to completion before the other starts.
    await new Promise((resolve) => setTimeout(resolve, 0))
    return appendOp(db, {
      entity: 'cohorts',
      entity_id,
      field,
      value,
      device_id: 'device-1',
    })
  })
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  vi.unstubAllGlobals()
})

describe('ensureCohort concurrent race', () => {
  it('two simultaneous ensureCohort() calls for the same camp create exactly one cohort', async () => {
    await Promise.all([ensureCohort('camp-1'), ensureCohort('camp-1')])

    const rows = db.prepare('SELECT * FROM cohorts WHERE camp_id = ?').all('camp-1')
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('Main')
    expect(Number(rows[0].session_week_start)).toBe(1)
    expect(Number(rows[0].session_week_end)).toBe(1)
    expect(rows[0].capacity_source).toBe('groups_per_slot')
    expect(rows[0].anchor_model).toBe('fixed')
  })

  it('neither concurrent call throws to its caller', async () => {
    await expect(Promise.all([ensureCohort('camp-1'), ensureCohort('camp-1')])).resolves.toBeDefined()
  })
})
