// @vitest-environment node
//
// Door-level acceptance for the atomic setup-import swap (board
// q-atomic-import-primitive, part 2). The ops-level primitive is covered by
// electron/ops/importSetupRows.test.js; this exercises it THROUGH the
// `shoresh:import-setup-rows` handler (auth gate + author/device wiring), which
// is the "door" the seven setup screens call. The acceptance the ticket names:
// an injected failure on row N leaves the DB byte-identical and the director is
// told which row failed.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { randomUUID, randomBytes } from 'node:crypto'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { getOrCreateDeviceId } from './db/localDb.js'
import { ensureHostSigningKey, createUser } from './auth/localAuth.js'
import { appendOp } from './ops/operations.js'
import { makeHandlers } from './main.js'

let tmpFile
let db
let deviceId
let handlers
let token
let campId

function localTestWrite() {
  return async ({ entity, entity_id, field, value }) => {
    const op = appendOp(db, { entity, entity_id, field, value, author_user_id: null, device_id: deviceId, parent_op_id: null })
    return { status: 'applied', op }
  }
}

beforeEach(async () => {
  const templated = openTemplatedDb()
  db = templated.db
  tmpFile = templated.file
  deviceId = getOrCreateDeviceId(db)
  db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(deviceId, os.hostname())
  db.prepare("UPDATE devices SET authorized_at = ?, device_secret_identifier = ?, pairing_status = 'authorized' WHERE id = ?")
    .run(new Date().toISOString(), randomBytes(32).toString('hex'), deviceId)

  const hostKey = ensureHostSigningKey(db)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret, signing_public_key) VALUES (?, ?, ?, ?)')
    .run(campId, 'Camp Shoresh', 'a'.repeat(64), hostKey.public_key)
  await createUser(db, { camp_id: campId, name: 'Root', pin: '999999', role: 'admin' }, localTestWrite())

  handlers = makeHandlers(db, deviceId, {})
  const login = await handlers.login({ name: 'Root', pin: '999999' })
  token = login.token

  // One baseline day already in the camp, seeded via the direct op-log path
  // (no chooseMode/syncClient needed for this test — the import door uses the
  // atomic primitive, not syncClient.write).
  appendOp(db, { entity: 'days_of_operation', entity_id: 'day-mon', field: 'day_of_week', value: 1, author_user_id: null, device_id: deviceId })
  appendOp(db, { entity: 'days_of_operation', entity_id: 'day-mon', field: 'label', value: 'Monday', author_user_id: null, device_id: deviceId })
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

afterAll(() => {
  cleanupTemplatedDbs()
})

function snapshot() {
  return {
    days: JSON.stringify(db.prepare('SELECT * FROM days_of_operation ORDER BY id').all()),
    ops: db.prepare('SELECT COUNT(*) AS n FROM operations').get().n,
  }
}

describe('import-setup-rows door — atomicity', () => {
  it('applies a clean batch all at once (create + update)', () => {
    const result = handlers.importSetupRows({
      token,
      rows: [
        { action: 'create', entity: 'days_of_operation', entity_id: 'day-tue', fields: { day_of_week: 2, label: 'Tuesday' }, name: 'Tuesday' },
        { action: 'update', entity: 'days_of_operation', entity_id: 'day-mon', fields: { sort_order: 5 }, name: 'Monday' },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.created).toBe(1)
    expect(result.updated).toBe(1)
    const labels = db.prepare('SELECT label FROM days_of_operation ORDER BY day_of_week').all().map((r) => r.label)
    expect(labels).toEqual(['Monday', 'Tuesday'])
    expect(db.prepare('SELECT sort_order FROM days_of_operation WHERE id = ?').get('day-mon').sort_order).toBe(5)
  })

  it('a failure on row N rolls the WHOLE import back — the DB is byte-identical — and names the row', () => {
    const before = snapshot()
    const result = handlers.importSetupRows({
      token,
      rows: [
        // row 1: a valid create that WOULD land if the import were not atomic
        { action: 'create', entity: 'days_of_operation', entity_id: 'day-wed', fields: { day_of_week: 3, label: 'Wednesday' }, name: 'Wednesday' },
        // row 2: a create missing the UNIQUE field (day_of_week) — orderFieldsForCreate throws
        { action: 'create', entity: 'days_of_operation', entity_id: 'day-bad', fields: { label: 'Nowhere' }, name: 'Nowhere' },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.created).toBe(0)
    expect(result.updated).toBe(0)
    // the director is told WHICH row failed, by its batch position and name
    expect(result.failedRow.number).toBe(2)
    expect(result.failedRow.name).toBe('Nowhere')
    expect(result.reason).toMatch(/day_of_week|unique/i)

    // byte-identical: row 1 (Wednesday) did NOT land, no new op rows, Monday intact
    const after = snapshot()
    expect(after.days).toBe(before.days)
    expect(after.ops).toBe(before.ops)
    expect(db.prepare("SELECT 1 FROM days_of_operation WHERE id = 'day-wed'").get()).toBeUndefined()
  })

  it('rejects an empty or malformed batch without touching the DB', () => {
    expect(() => handlers.importSetupRows({ token, rows: [] })).toThrow(/non-empty/i)
    expect(() => handlers.importSetupRows({ rows: [{ action: 'create', entity: 'days_of_operation', entity_id: 'x', fields: {} }] })).toThrow(/token/i)
  })

  it('refuses an unauthenticated token', () => {
    expect(() => handlers.importSetupRows({
      token: 'not-a-real-token',
      rows: [{ action: 'create', entity: 'days_of_operation', entity_id: 'z', fields: { day_of_week: 4, label: 'Thursday' }, name: 'Thursday' }],
    })).toThrow()
    // nothing landed
    expect(db.prepare("SELECT 1 FROM days_of_operation WHERE id = 'z'").get()).toBeUndefined()
  })
})
