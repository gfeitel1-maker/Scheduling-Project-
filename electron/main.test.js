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
  createSyncClient: vi.fn((db, opts) => {
    const client = {
      opts,
      write: vi.fn(async () => ({ status: 'applied' })),
      onOpApplied: vi.fn(),
    }
    lastCreatedSyncClient = client
    return client
  }),
}))

import { openLocalDb, getOrCreateDeviceId } from './db/localDb.js'
import { createUser } from './auth/localAuth.js'
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
  vi.clearAllMocks()
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function seedCampAndUser({ name = 'Alice', pin = '1234', role = 'staff' } = {}) {
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Shoresh')
  const user = createUser(db, { camp_id: campId, name, pin, role })
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

  it('builds a validated ws:// url from discovered host/port and creates a syncClient', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })

    expect(createSyncClient).toHaveBeenCalledWith(db, {
      device_id: deviceId,
      author_user_id: null,
      serverUrl: 'ws://192.168.1.5:7100',
    })
  })

  it('accepts a pre-validated hostAddress string directly', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    expect(createSyncClient).toHaveBeenCalledWith(db, {
      device_id: deviceId,
      author_user_id: null,
      serverUrl: 'ws://192.168.1.5:7100',
    })
  })

  it('rejects an unrecognized mode', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.chooseMode({ mode: 'bogus' })).toThrow()
  })
})

describe('login', () => {
  it('succeeds with correct camp-scoped name and pin', () => {
    seedCampAndUser({ name: 'Alice', pin: '1234' })
    const handlers = makeHandlers(db, deviceId, {})
    const result = handlers.login({ name: 'Alice', pin: '1234' })
    expect(result).toBeTruthy()
    expect(result.token).toEqual(expect.any(String))
    expect(result.role).toBe('staff')
  })

  it('fails with wrong pin', () => {
    seedCampAndUser({ name: 'Alice', pin: '1234' })
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

describe('createUser handler', () => {
  it('validates required fields before delegating to createUser', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.createUser({ name: 'Bob', pin: '1234', role: 'staff' })).toThrow()
    expect(() => handlers.createUser({ camp_id: 'x', name: 'Bob', pin: '1234', role: 'admin-ish' })).toThrow()
  })

  it('creates a user when all fields are valid', () => {
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Shoresh')
    const handlers = makeHandlers(db, deviceId, {})
    const created = handlers.createUser({ camp_id: campId, name: 'Bob', pin: '1234', role: 'staff' })
    expect(created.name).toBe('Bob')
  })
})

describe('write handler', () => {
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
    const { user } = seedCampAndUser({ name: 'Carol', pin: '4321' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7102 })
    const { token } = handlers.login({ name: 'Carol', pin: '4321' })

    await handlers.write({ token, entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim' })

    expect(lastCreatedSyncClient.write).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'activities', author_user_id: user.id })
    )
  })
})
