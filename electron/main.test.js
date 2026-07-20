// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

const fakeSyncServer = { close: vi.fn() }
const fakeAdvertised = { stop: vi.fn() }
let lastCreatedSyncClient

vi.mock('./sync/syncServer.js', () => ({
  startSyncServer: vi.fn(() => fakeSyncServer),
}))

vi.mock('./sync/discovery.js', () => ({
  advertiseHost: vi.fn(() => fakeAdvertised),
  discoverHosts: vi.fn(() => Promise.resolve([{ name: 'Camp', host: '192.168.1.5', port: 7000 }])),
}))

vi.mock('./sync/syncClient.js', () => ({
  createSyncClient: vi.fn((mockDb, opts) => {
    const client = {
      opts,
      // Mirrors real local-mode syncClient behavior (appendOp + projection) so
      // that tests exercising createUser/bootstrapCamp through this mocked
      // syncClient still end up with a real, queryable users row.
      write: vi.fn(async ({ entity, entity_id, field, value, author_user_id }) => {
        const op = appendOp(mockDb, {
          entity,
          entity_id,
          field,
          value,
          author_user_id: author_user_id ?? opts.author_user_id ?? null,
          device_id: opts.device_id,
          parent_op_id: null,
        })
        return { status: 'applied', op }
      }),
      onOpApplied: vi.fn(),
    }
    lastCreatedSyncClient = client
    return client
  }),
}))

import { openLocalDb, getOrCreateDeviceId } from './db/localDb.js'
import { createUser } from './auth/localAuth.js'
import { appendOp } from './ops/operations.js'
import { makeHandlers } from './main.js'
import { startSyncServer } from './sync/syncServer.js'
import { advertiseHost } from './sync/discovery.js'
import { createSyncClient } from './sync/syncClient.js'

let tmpFile
let db
let deviceId

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-main-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  deviceId = getOrCreateDeviceId(db)
  db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(deviceId, os.hostname())
  vi.clearAllMocks()
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

// Test-only write function matching syncClient's write() signature, used to seed
// users directly against the local db (bypassing any real syncClient/mode setup)
// for tests that only care about pre-existing login state.
function localTestWrite() {
  return async ({ entity, entity_id, field, value }) => {
    const op = appendOp(db, {
      entity,
      entity_id,
      field,
      value,
      author_user_id: null,
      device_id: deviceId,
      parent_op_id: null,
    })
    return { status: 'applied', op }
  }
}

async function seedCampAndUser({ name = 'Alice', pin = '1234', role = 'staff' } = {}) {
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Shoresh')
  const user = await createUser(db, { camp_id: campId, name, pin, role }, localTestWrite())
  return { campId, user }
}

describe('makeHandlers: device row setup', () => {
  it('inserts a devices row for the device id before first use', () => {
    makeHandlers(db, deviceId, {})
    const row = db.prepare('SELECT id, name FROM devices WHERE id = ?').get(deviceId)
    expect(row).toBeTruthy()
    expect(row.name).toBe(os.hostname())
  })
})

describe('chooseMode: host path', () => {
  it('starts a sync server, advertises, and creates a local syncClient with author_user_id null', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7100 })

    expect(startSyncServer).toHaveBeenCalledWith(db, { port: 7100 })
    expect(advertiseHost).toHaveBeenCalledWith({ campName: 'Camp Test', port: 7100 })
    expect(createSyncClient).toHaveBeenCalledWith(db, {
      device_id: deviceId,
      author_user_id: null,
    })
    expect(lastCreatedSyncClient.onOpApplied).toHaveBeenCalled()
  })
})

describe('chooseMode: client path', () => {
  it('rejects a malformed port before ever calling createSyncClient', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: -1 })).toThrow()
    expect(createSyncClient).not.toHaveBeenCalled()
  })

  it('rejects a malformed host before ever calling createSyncClient', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.chooseMode({ mode: 'client', host: 'evil host; rm -rf', port: 7100 })).toThrow()
    expect(createSyncClient).not.toHaveBeenCalled()
  })

  it('validates the host/port and stores the serverUrl WITHOUT creating a syncClient yet (Fix E)', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const result = await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })

    expect(result).toEqual({ mode: 'client' })
    expect(createSyncClient).not.toHaveBeenCalled()
  })

  it('accepts a pre-validated hostAddress string directly without creating a syncClient yet', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    expect(createSyncClient).not.toHaveBeenCalled()
  })

  it('creates the syncClient with a token only after a successful login (Fix E)', async () => {
    const { user } = await seedCampAndUser({ name: 'Dana', pin: '5555' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })
    expect(createSyncClient).not.toHaveBeenCalled()

    const result = handlers.login({ name: 'Dana', pin: '5555' })

    expect(result).toBeTruthy()
    expect(createSyncClient).toHaveBeenCalledWith(db, {
      device_id: deviceId,
      author_user_id: null,
      serverUrl: 'ws://192.168.1.5:7100',
      token: result.token,
    })
    expect(lastCreatedSyncClient.onOpApplied).toHaveBeenCalled()
    void user
  })

  it('rejects an unrecognized mode', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.chooseMode({ mode: 'bogus' })).toThrow()
  })
})

describe('chooseMode: idempotency (Fix C)', () => {
  it('throws if chooseMode is called a second time for the same session', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7199 })
    expect(() => handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7199 })).toThrow(
      'mode already chosen for this session'
    )
    expect(startSyncServer).toHaveBeenCalledTimes(1)
  })
})

describe('login', () => {
  it('succeeds with correct camp-scoped name and pin', async () => {
    await seedCampAndUser({ name: 'Alice', pin: '1234' })
    const handlers = makeHandlers(db, deviceId, {})
    const result = handlers.login({ name: 'Alice', pin: '1234' })
    expect(result).toBeTruthy()
    expect(result.token).toEqual(expect.any(String))
    expect(result.role).toBe('staff')
  })

  it('fails with wrong pin', async () => {
    await seedCampAndUser({ name: 'Alice', pin: '1234' })
    const handlers = makeHandlers(db, deviceId, {})
    const result = handlers.login({ name: 'Alice', pin: '9999' })
    expect(result).toBeNull()
  })

  it('rejects missing name/pin at the IPC boundary', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.login({ name: '', pin: '1234' })).toThrow()
    expect(() => handlers.login({})).toThrow()
  })
})

describe('login: rate limiting (Fix B)', () => {
  it('locks out a name after 5 failed attempts and rejects further attempts (even with the correct pin) until the lockout expires', async () => {
    await seedCampAndUser({ name: 'Eve', pin: '1111' })
    const handlers = makeHandlers(db, deviceId, {})

    for (let i = 0; i < 5; i++) {
      expect(handlers.login({ name: 'Eve', pin: 'wrong' })).toBeNull()
    }

    // now locked out: even the CORRECT pin is rejected the same way, but the client
    // is told it is specifically locked out (with a retry time) rather than getting
    // the generic null a wrong PIN would get — this is safe since the client already
    // knows it made 5 failed attempts itself.
    const result = handlers.login({ name: 'Eve', pin: '1111' })
    expect(result).toEqual({ locked: true, retryAfterMs: expect.any(Number) })
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  it('still returns plain null for a simple wrong PIN (not locked)', async () => {
    await seedCampAndUser({ name: 'Zara', pin: '3333' })
    const handlers = makeHandlers(db, deviceId, {})
    expect(handlers.login({ name: 'Zara', pin: 'wrong' })).toBeNull()
  })

  it('resets the failure counter for a name after a successful login', async () => {
    await seedCampAndUser({ name: 'Frank', pin: '2222' })
    const handlers = makeHandlers(db, deviceId, {})

    for (let i = 0; i < 3; i++) {
      expect(handlers.login({ name: 'Frank', pin: 'wrong' })).toBeNull()
    }
    expect(handlers.login({ name: 'Frank', pin: '2222' })).toBeTruthy()

    // counter reset: two more failures should not trigger lockout (needs 5 in a row)
    expect(handlers.login({ name: 'Frank', pin: 'wrong' })).toBeNull()
    expect(handlers.login({ name: 'Frank', pin: 'wrong' })).toBeNull()
    expect(handlers.login({ name: 'Frank', pin: '2222' })).toBeTruthy()
  })
})

describe('bootstrapCamp (Fix A)', () => {
  it('creates the first camp and admin user when no camps exist yet', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Shoresh', port: 7200 })
    const result = await handlers.bootstrapCamp({ campName: 'Camp Shoresh', adminName: 'Root', adminPin: '9999' })

    expect(result.campId).toEqual(expect.any(String))
    expect(result.userId).toEqual(expect.any(String))

    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(result.userId)
    expect(user.role).toBe('admin')
  })

  it('refuses to run again once a camp already exists', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Shoresh', port: 7201 })
    await handlers.bootstrapCamp({ campName: 'Camp Shoresh', adminName: 'Root', adminPin: '9999' })

    await expect(
      handlers.bootstrapCamp({ campName: 'Camp Two', adminName: 'Root2', adminPin: '8888' })
    ).rejects.toThrow('camp already exists')
  })
})

describe('createUser handler (Fix A: admin-gated)', () => {
  it('rejects create-user with no token at all (no unauthenticated privilege escalation)', async () => {
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Shoresh')
    const handlers = makeHandlers(db, deviceId, {})
    await expect(
      handlers.createUser({ camp_id: campId, name: 'Mallory', pin: '1234', role: 'admin' })
    ).rejects.toThrow('token is required')
  })

  it('rejects create-user when the token belongs to a non-admin (staff) user', async () => {
    const { campId } = await seedCampAndUser({ name: 'StaffPerson', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = handlers.login({ name: 'StaffPerson', pin: '1234' })

    await expect(
      handlers.createUser({ token, camp_id: campId, name: 'Mallory', pin: '1234', role: 'admin' })
    ).rejects.toThrow('admin role required')
  })

  it('validates required fields once an admin session is presented', async () => {
    const { campId } = await seedCampAndUser({ name: 'AdminPerson', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = handlers.login({ name: 'AdminPerson', pin: '1234' })

    await expect(handlers.createUser({ token, name: 'Bob', pin: '1234', role: 'staff' })).rejects.toThrow()
    await expect(
      handlers.createUser({ token, camp_id: campId, name: 'Bob', pin: '1234', role: 'admin-ish' })
    ).rejects.toThrow()
  })

  it('creates a user when an admin session and all fields are valid', async () => {
    const { campId } = await seedCampAndUser({ name: 'AdminPerson2', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Shoresh', port: 7202 })
    const { token } = handlers.login({ name: 'AdminPerson2', pin: '1234' })

    const created = await handlers.createUser({ token, camp_id: campId, name: 'Bob', pin: '1234', role: 'staff' })
    expect(created.name).toBe('Bob')
  })

  it('propagates a clear rejection through the IPC handler when the syncClient write resolves a non-applied status', async () => {
    const { campId } = await seedCampAndUser({ name: 'AdminPerson3', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Shoresh', port: 7203 })
    const { token } = handlers.login({ name: 'AdminPerson3', pin: '1234' })

    lastCreatedSyncClient.write.mockImplementationOnce(async () => ({ status: 'disconnected' }))

    await expect(
      handlers.createUser({ token, camp_id: campId, name: 'Offline', pin: '1234', role: 'staff' })
    ).rejects.toThrow(/active connection to the camp's sync host/)
  })
})

describe('write handler', () => {
  it('rejects a write with a clear error when no syncClient exists yet (Fix D)', async () => {
    const { user } = await seedCampAndUser({ name: 'Gina', pin: '6666' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = handlers.login({ name: 'Gina', pin: '6666' })

    expect(() => handlers.write({ token, entity: 'x', entity_id: 'y', field: 'z', value: 1 })).toThrow(
      'sync not initialized — choose a mode first'
    )
    void user
  })

  it('rejects a malformed/invalid token cleanly without crashing', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7101 })

    expect(() => handlers.write({ token: 'not-a-real-token', entity: 'x', entity_id: 'y', field: 'z', value: 1 })).toThrow()
  })

  it('rejects a missing token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.write({ entity: 'x', entity_id: 'y', field: 'z', value: 1 })).toThrow()
  })

  it('delegates to syncClient.write with a valid session token', async () => {
    const { user } = await seedCampAndUser({ name: 'Carol', pin: '4321' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7102 })
    const { token } = handlers.login({ name: 'Carol', pin: '4321' })

    await handlers.write({ token, entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim' })

    expect(lastCreatedSyncClient.write).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'activities', author_user_id: user.id })
    )
  })
})
