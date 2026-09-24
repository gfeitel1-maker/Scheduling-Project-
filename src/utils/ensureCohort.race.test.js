// @vitest-environment node
//
// Round 2 Red Hat fix (Sub-plan B Task 2), HIGH finding 1: a real
// concurrent-race regression test, not just a unit test of the guard logic
// in isolation. Two ensureCohort() calls run against the SAME underlying
// SQLite db (via electron/ops/operations.js's real appendOp, exactly what
// production IPC ends up calling), with each localClient.write() deferred a
// tick so the two calls' field-write loops genuinely interleave — the exact
// window the original bug lived in.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../electron/db/testDbTemplate.js'
import { appendOp } from '../../electron/ops/operations.js'


// Discards the cached template. Per-test cleanup would rebuild the chain every time and
// undo the saving, so this runs once, at the end (T188/F2).
afterAll(() => {
  cleanupTemplatedDbs()
})
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
  // Was openLocalDb(freshPath) — replays the whole migration chain, ~304ms per test.
  // The template copy is the database that chain produces, ~10x cheaper (T188/F2).
  const __templated = openTemplatedDb()
  db = __templated.db
  tmpFile = __templated.file
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
    // Mirror localClient.write's real contract: the IPC handler returns
    // { status, op } (electron/sync/localWriteClient.js), not appendOp's bare
    // op row. ensureCohort now checks that status, so a mock that omitted it
    // would fail a write that actually succeeded.
    const op = appendOp(db, {
      entity: 'cohorts',
      entity_id,
      field,
      value,
      device_id: 'device-1',
    })
    return { status: 'applied', op }
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

  it('reuses an existing pre-derived-id Main cohort (random uuid, from before this fix) instead of minting a second one', async () => {
    // Simulates every camp that already exists today: its Main cohort row was
    // minted by crypto.randomUUID() before deterministic ids existed, and
    // nothing may re-key or duplicate it now.
    db.prepare(
      `INSERT INTO cohorts (id, camp_id, name, session_week_start, session_week_end, capacity_source, anchor_model)
       VALUES (?, ?, 'Main', 1, 1, 'groups_per_slot', 'fixed')`
    ).run('legacy-random-uuid-id', 'camp-1')

    await Promise.all([ensureCohort('camp-1'), ensureCohort('camp-1')])

    const rows = db.prepare('SELECT * FROM cohorts WHERE camp_id = ?').all('camp-1')
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('legacy-random-uuid-id')
    expect(localClient.write).not.toHaveBeenCalled()
  })
})
