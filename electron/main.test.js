// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { ENTITIES } from './auth/permissions.js'

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

const fakeSyncServer = {
  close: vi.fn(),
  sendPairingApproved: vi.fn(() => true),
  sendPairingDenied: vi.fn(() => true),
  wss: { clients: new Set() },
}
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
    // Mirrors real syncClient's "socket not OPEN yet" behavior: while
    // `connected` is false, loginRemote() returns 'disconnected' synchronously
    // (just like the real readyState guard does) and waitUntilConnected()'s
    // promise stays pending until __setConnected(true) is called — letting
    // tests simulate both "connects shortly after" (call __setConnected(true)
    // after a short delay) and "never connects" (never call it).
    let connected = true
    let resolveConnected = null
    let connectedPromise = Promise.resolve()
    // T87 Part 4: distinct from `connected` — mirrors the real syncClient's
    // own connected/authenticated distinction (see its `authenticated`
    // comment). Defaults to true so every EXISTING test in this file (none
    // of which cares about the connecting-vs-authenticated distinction)
    // keeps seeing 'client-connected', not a new default of 'client-connecting'.
    let authenticated = true
    const client = {
      opts,
      // Mirrors real local-mode syncClient behavior (appendOp + projection) so
      // that tests exercising createUser/bootstrapCamp through this mocked
      // syncClient still end up with a real, queryable users row.
      write: vi.fn(async ({ entity, entity_id, field, value, author_user_id, parent_op_id = null, source = 'human' }) => {
        const op = appendOp(mockDb, {
          entity,
          entity_id,
          field,
          value,
          author_user_id: author_user_id ?? opts.author_user_id ?? null,
          device_id: opts.device_id,
          parent_op_id,
          // Mirror the real client seam (S2a/S2b R1): default 'human', but honor
          // an explicit source (a stale-accept passes 'import') and parent_op_id.
          source,
        })
        return { status: 'applied', op }
      }),
      writeBulkReplace: vi.fn(async ({ entity, scope_id, rows, author_user_id }) => {
        const op = appendBulkReplaceOp(mockDb, {
          entity,
          scope_id,
          rows,
          author_user_id: author_user_id ?? opts.author_user_id ?? null,
          device_id: opts.device_id,
        })
        return { status: 'applied', op }
      }),
      onOpApplied: vi.fn(),
      onOpConflict: vi.fn(),
      onOpRejected: vi.fn(),
      onPairingApproved: vi.fn(),
      onPairingDenied: vi.fn(),
      onTokenRenewed: vi.fn(),
      // T87 Part 3
      onAuthRejected: vi.fn(),
      loginRemote: vi.fn(async ({ name, pin }) => {
        if (!connected) return { status: 'disconnected' }
        const result = attemptLoginRef({ name, pin, deviceId: opts.device_id })
        if (!result) return { status: 'failed' }
        if (result.locked) return { status: 'failed', locked: true, retryAfterMs: result.retryAfterMs }
        return { status: 'ok', token: result.token, userId: result.userId, role: result.role }
      }),
      waitUntilConnected: vi.fn(async () => {
        await connectedPromise
      }),
      // test-only: simulate the socket transitioning between CONNECTING and
      // OPEN. Starting a client "not yet connected" and later flipping it to
      // connected mirrors a real handshake finishing after login() was called.
      __setConnected(value) {
        connected = value
        if (!value) authenticated = false
        if (value && resolveConnected) {
          resolveConnected()
          resolveConnected = null
        } else if (!value) {
          connectedPromise = new Promise((resolve) => {
            resolveConnected = resolve
          })
        }
      },
      isConnected: vi.fn(() => connected),
      // T87 Part 4
      isAuthenticated: vi.fn(() => authenticated),
      __setAuthenticated(value) { authenticated = value },
    }
    lastCreatedSyncClient = client
    return client
  }),
}))

import { openLocalDb, getOrCreateDeviceId } from './db/localDb.js'
import { createUser, attemptLogin, ensureHostSigningKey } from './auth/localAuth.js'
let attemptLoginRef = (args) => attemptLogin(db, args)
import { appendOp, appendBulkReplaceOp, latestOp } from './ops/operations.js'
import { makeHandlers, sanitizeConflictForIpc, sanitizeOpRejectedForIpc } from './main.js'
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

  // Device trust (docs/adr/2026-07-25-device-trust-revocation.md): the vast
  // majority of this file's tests predate pairing/authorization and assume
  // "this device can log in and act the moment a camp/user exists" — mirror
  // what real bootstrapCamp() now does for the Host's own device, so those
  // tests keep exercising what they actually test (role/entity gating, not
  // device pairing, which is sub-task 2's concern) without every one of them
  // individually authorizing this device.
  db.prepare(
    "UPDATE devices SET authorized_at = ?, device_secret_identifier = ?, pairing_status = 'authorized' WHERE id = ?"
  ).run(new Date().toISOString(), randomBytes(32).toString('hex'), deviceId)

  // This file has many call sites that INSERT INTO camps directly (bypassing
  // the real bootstrapCamp(), which is what normally sets
  // signing_public_key). ensureHostSigningKey + a temp trigger keeps every
  // one of those working as a 'camp'-token-issuing Host db, matching what
  // handlers.login actually produces (issueTokenForThisDevice sees this
  // device's host_signing_key and issues a camp token), without editing
  // every individual INSERT INTO camps call site in this file.
  const hostKey = ensureHostSigningKey(db)
  db.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS trg_test_set_signing_public_key
    AFTER INSERT ON camps
    WHEN NEW.signing_public_key IS NULL
    BEGIN
      UPDATE camps SET signing_public_key = '${hostKey.public_key}' WHERE id = NEW.id;
    END;
  `)

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
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Shoresh', 'a'.repeat(64))
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

    expect(startSyncServer).toHaveBeenCalledWith(db, expect.objectContaining({ port: 7100 }))
    expect(advertiseHost).toHaveBeenCalledWith({ campName: 'Camp Test', port: 7100 })
    // T85 Part 3 (docs/adr/2026-08-16-device-fk-seeding-and-delivery-
    // watermark.md): the Host's own no-serverUrl client is now constructed
    // with `wss` so its interactive local writes broadcast to connected
    // Clients — startSyncServer's own wss instance must be threaded through.
    expect(createSyncClient).toHaveBeenCalledWith(db, {
      device_id: deviceId,
      author_user_id: null,
      wss: fakeSyncServer.wss,
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

  it('validates the host/port and creates a syncClient immediately, without a token', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const result = await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })

    expect(result).toEqual({ mode: 'client' })
    expect(createSyncClient).toHaveBeenCalledWith(db, expect.objectContaining({
      device_id: deviceId,
      author_user_id: null,
      serverUrl: 'ws://192.168.1.5:7100',
    }))
    expect(lastCreatedSyncClient.onOpApplied).toHaveBeenCalled()
  })

  // T87 (docs/adr/2026-08-16-client-reauth-on-restart.md, Part 2): a
  // returning Client's locally-verified token must reach the transport
  // layer, so connect()'s existing `if (token) → authenticate` branch
  // actually fires on startup instead of always falling back to
  // pairing_request.
  it('forwards a provided token straight through to createSyncClient (T87 Part 2)', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100, token: 'a-verified-token' })

    expect(createSyncClient).toHaveBeenCalledWith(db, expect.objectContaining({
      device_id: deviceId,
      serverUrl: 'ws://192.168.1.5:7100',
      token: 'a-verified-token',
    }))
  })

  it('accepts a pre-validated hostAddress string directly and creates a syncClient without a token', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    expect(createSyncClient).toHaveBeenCalledWith(db, expect.objectContaining({
      device_id: deviceId,
      author_user_id: null,
      serverUrl: 'ws://192.168.1.5:7100',
    }))
  })

  it('a fresh client with zero local users can still log in via the syncClient.loginRemote path', async () => {
    const { user } = await seedCampAndUser({ name: 'Dana', pin: '5555' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    const result = await handlers.login({ name: 'Dana', pin: '5555' })

    expect(result).toBeTruthy()
    expect(result.token).toEqual(expect.any(String))
    expect(lastCreatedSyncClient.loginRemote).toHaveBeenCalledWith({ name: 'Dana', pin: '5555' })
    void user
  })

  it('returns a distinct offline signal for a fresh device with no local camp and no live connection', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    lastCreatedSyncClient.loginRemote.mockResolvedValueOnce({ status: 'disconnected' })

    const result = await handlers.login({ name: 'Dana', pin: '5555' })
    expect(result).toEqual({ offline: true, reason: expect.any(String) })
  })

  it('succeeds when the socket is still CONNECTING at login() time but opens shortly after (Round 2 Fix)', async () => {
    const { user } = await seedCampAndUser({ name: 'Dana', pin: '5555' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    // Simulate the natural "connect, then immediately submit PIN" race: the
    // socket is still CONNECTING when login() is called...
    lastCreatedSyncClient.__setConnected(false)
    setTimeout(() => lastCreatedSyncClient.__setConnected(true), 50)

    const result = await handlers.login({ name: 'Dana', pin: '5555' })

    // ...but because it opens well within the bounded wait, login() must
    // succeed via loginRemote rather than falling back to the false "offline"
    // signal.
    expect(result).toBeTruthy()
    expect(result.token).toEqual(expect.any(String))
    void user
  })

  it('falls back to offline after the bounded wait when the Host is genuinely unreachable (Round 2 Fix)', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    // Socket never opens — a genuinely unreachable Host, not a mid-handshake race.
    lastCreatedSyncClient.__setConnected(false)

    const result = await handlers.login({ name: 'Dana', pin: '5555' })

    expect(result).toEqual({ offline: true, reason: expect.any(String) })
  }, 10000)

  it('rejects an unrecognized mode', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.chooseMode({ mode: 'bogus' })).toThrow()
  })
})

// T87 (docs/adr/2026-08-16-client-reauth-on-restart.md, Part 4): a socket
// can be open without being authenticated — 'client-connected' now means
// transport-open AND authenticated, so the in-between window gets its own
// distinct 'client-connecting' state instead of overclaiming "linked".
describe('getSyncStatus: client tri-state (Part 4)', () => {
  it('reports standalone before any mode is chosen', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(handlers.getSyncStatus()).toEqual({ mode: null, connected: false, state: 'standalone' })
  })

  it('reports host unconditionally once host mode is chosen', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7199 })
    expect(handlers.getSyncStatus()).toEqual({ mode: 'host', connected: true, state: 'host' })
  })

  it('reports client-disconnected when the transport is not open', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })
    lastCreatedSyncClient.__setConnected(false)

    expect(handlers.getSyncStatus()).toEqual({
      mode: 'client', connected: false, authenticated: false, state: 'client-disconnected',
    })
  })

  it('reports client-connecting when the transport is open but not yet authenticated', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })
    lastCreatedSyncClient.__setConnected(true)
    lastCreatedSyncClient.__setAuthenticated(false)

    expect(handlers.getSyncStatus()).toEqual({
      mode: 'client', connected: true, authenticated: false, state: 'client-connecting',
    })
  })

  it('reports client-connected only once BOTH connected and authenticated are true', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })
    lastCreatedSyncClient.__setConnected(true)
    lastCreatedSyncClient.__setAuthenticated(true)

    expect(handlers.getSyncStatus()).toEqual({
      mode: 'client', connected: true, authenticated: true, state: 'client-connected',
    })
  })

  it('falls back to unauthenticated (never throws) when isAuthenticated is not a function', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })
    lastCreatedSyncClient.__setConnected(true)
    // Simulate a stale/old syncClient shape (Migration guard) — must degrade
    // to 'client-connecting', never throw.
    delete lastCreatedSyncClient.isAuthenticated

    expect(() => handlers.getSyncStatus()).not.toThrow()
    expect(handlers.getSyncStatus()).toEqual({
      mode: 'client', connected: true, authenticated: false, state: 'client-connecting',
    })
  })
})

describe('chooseMode: idempotency (Fix C)', () => {
  it('throws if chooseMode is called a second time with a genuinely different mode', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7199 })
    expect(() => handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })).toThrow(
      'mode already chosen for this session'
    )
    expect(startSyncServer).toHaveBeenCalledTimes(1)
  })
})

describe('chooseMode: same-mode replay is a no-op (Round 2 Fix 1)', () => {
  it('returns successfully without re-starting the sync server when replayed with the same mode/args', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const first = await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7199 })
    const second = await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7199 })

    expect(first).toEqual({ mode: 'host' })
    expect(second).toEqual({ mode: 'host' })
    expect(startSyncServer).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when replayed for client mode, without creating a SECOND syncClient', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })
    const result = await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7100 })

    expect(result).toEqual({ mode: 'client' })
    expect(createSyncClient).toHaveBeenCalledTimes(1)
  })

  it('simulates a renderer reload after mode was chosen: replaying the same mode never throws', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Reload Camp', port: 7198 })

    // A renderer reload re-runs useDeviceMode's init effect, which re-calls
    // chooseMode with the same persisted mode. This must not throw.
    let result
    expect(() => {
      result = handlers.chooseMode({ mode: 'host', campName: 'Reload Camp', port: 7198 })
    }).not.toThrow()
    expect(result).toEqual({ mode: 'host' })
  })
})

describe('login', () => {
  it('succeeds with correct camp-scoped name and pin', async () => {
    await seedCampAndUser({ name: 'Alice', pin: '1234' })
    const handlers = makeHandlers(db, deviceId, {})
    const result = await handlers.login({ name: 'Alice', pin: '1234' })
    expect(result).toBeTruthy()
    expect(result.token).toEqual(expect.any(String))
    expect(result.role).toBe('staff')
  })

  it('fails with wrong pin', async () => {
    await seedCampAndUser({ name: 'Alice', pin: '1234' })
    const handlers = makeHandlers(db, deviceId, {})
    const result = await handlers.login({ name: 'Alice', pin: '9999' })
    expect(result).toBeNull()
  })

  it('rejects missing name/pin at the IPC boundary', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await expect(handlers.login({ name: '', pin: '1234' })).rejects.toThrow()
    await expect(handlers.login({})).rejects.toThrow()
  })
})

describe('login: rate limiting (Fix B)', () => {
  it('locks out a name after 5 failed attempts and rejects further attempts (even with the correct pin) until the lockout expires', async () => {
    await seedCampAndUser({ name: 'Eve', pin: '1111' })
    const handlers = makeHandlers(db, deviceId, {})

    for (let i = 0; i < 5; i++) {
      expect(await handlers.login({ name: 'Eve', pin: 'wrong' })).toBeNull()
    }

    // now locked out: even the CORRECT pin is rejected the same way, but the client
    // is told it is specifically locked out (with a retry time) rather than getting
    // the generic null a wrong PIN would get — this is safe since the client already
    // knows it made 5 failed attempts itself.
    const result = await handlers.login({ name: 'Eve', pin: '1111' })
    expect(result).toEqual({ locked: true, retryAfterMs: expect.any(Number) })
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  it('still returns plain null for a simple wrong PIN (not locked)', async () => {
    await seedCampAndUser({ name: 'Zara', pin: '3333' })
    const handlers = makeHandlers(db, deviceId, {})
    expect(await handlers.login({ name: 'Zara', pin: 'wrong' })).toBeNull()
  })

  it('resets the failure counter for a name after a successful login', async () => {
    await seedCampAndUser({ name: 'Frank', pin: '2222' })
    const handlers = makeHandlers(db, deviceId, {})

    for (let i = 0; i < 3; i++) {
      expect(await handlers.login({ name: 'Frank', pin: 'wrong' })).toBeNull()
    }
    expect(await handlers.login({ name: 'Frank', pin: '2222' })).toBeTruthy()

    // counter reset: two more failures should not trigger lockout (needs 5 in a row)
    expect(await handlers.login({ name: 'Frank', pin: 'wrong' })).toBeNull()
    expect(await handlers.login({ name: 'Frank', pin: 'wrong' })).toBeNull()
    expect(await handlers.login({ name: 'Frank', pin: '2222' })).toBeTruthy()
  })
})

describe('login: lockout persists across a simulated app restart (Round 2 Fix 2)', () => {
  it('survives a fresh openLocalDb/makeHandlers call against the same db file', async () => {
    await seedCampAndUser({ name: 'Heidi', pin: '4444' })
    const handlers1 = makeHandlers(db, deviceId, {})

    for (let i = 0; i < 5; i++) {
      expect(await handlers1.login({ name: 'Heidi', pin: 'wrong' })).toBeNull()
    }
    const lockedResult = await handlers1.login({ name: 'Heidi', pin: '4444' })
    expect(lockedResult).toEqual({ locked: true, retryAfterMs: expect.any(Number) })

    // Simulate an app restart: close and reopen the same db file, rebuild handlers.
    db.close()
    db = openLocalDb(tmpFile)
    const deviceId2 = getOrCreateDeviceId(db)
    const handlers2 = makeHandlers(db, deviceId2, {})

    // Even the correct PIN must still be rejected as locked — an in-memory Map
    // would have reset here, but the persisted table should not have.
    const stillLocked = await handlers2.login({ name: 'Heidi', pin: '4444' })
    expect(stillLocked).toEqual({ locked: true, retryAfterMs: expect.any(Number) })
  })
})

describe('shoresh:verify-session handler (Round 2 Fix 3)', () => {
  it('returns valid:true with userId/role for a valid session token', async () => {
    const { user } = await seedCampAndUser({ name: 'Ivan', pin: '7777', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = await handlers.login({ name: 'Ivan', pin: '7777' })

    const result = handlers.verifySession({ token })
    expect(result).toEqual({ valid: true, userId: user.id, role: 'admin' })
  })

  it('returns valid:false (without throwing) for a malformed/garbage token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.verifySession({ token: 'not-a-real-token' })).not.toThrow()
    expect(handlers.verifySession({ token: 'not-a-real-token' })).toEqual({ valid: false })
  })

  it('returns valid:false for a missing token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(handlers.verifySession({})).toEqual({ valid: false })
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

describe('bootstrapCamp: device trust (docs/adr/2026-07-25-device-trust-revocation.md)', () => {
  it('generates a host_signing_key, sets camps.signing_public_key, and authorizes the bootstrapping device — a write() right after bootstrap succeeds without device_not_authorized', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Shoresh', port: 7204 })
    const result = await handlers.bootstrapCamp({ campName: 'Camp Shoresh', adminName: 'Root', adminPin: '9999' })

    const keyRow = db.prepare('SELECT * FROM host_signing_key WHERE id = 1').get()
    expect(keyRow).toBeTruthy()
    expect(keyRow.public_key).toEqual(expect.any(String))
    expect(keyRow.private_key).toEqual(expect.any(String))

    const campRow = db.prepare('SELECT signing_public_key FROM camps WHERE id = ?').get(result.campId)
    expect(campRow.signing_public_key).toBe(keyRow.public_key)

    const deviceRow = db.prepare('SELECT authorized_at, pairing_status FROM devices WHERE id = ?').get(deviceId)
    expect(deviceRow.authorized_at).toEqual(expect.any(String))
    expect(deviceRow.pairing_status).toBe('authorized')

    // The actual behavior this all exists for: an ordinary write right after
    // bootstrap must not be denied as 'device_not_authorized'.
    const { token } = await handlers.login({ name: 'Root', pin: '9999' })
    await expect(
      handlers.write({ token, entity: 'cohorts', entity_id: 'c1', field: 'name', value: 'Main' })
    ).resolves.toBeTruthy()
  })

  it('does not generate a second host_signing_key if bootstrapCamp somehow runs on a device that already has one', async () => {
    const { ensureHostSigningKey } = await import('./auth/localAuth.js')
    const preExisting = ensureHostSigningKey(db)

    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Shoresh', port: 7205 })
    await handlers.bootstrapCamp({ campName: 'Camp Shoresh', adminName: 'Root', adminPin: '9999' })

    const rows = db.prepare('SELECT * FROM host_signing_key').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].public_key).toBe(preExisting.public_key)
  })
})

describe('devAuthorizeDevice (removed in sub-task 2, superseded by approveDevice)', () => {
  it('is no longer exposed on handlers — use approveDevice instead', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(handlers.devAuthorizeDevice).toBeUndefined()
  })
})

describe('createUser handler (Fix A: admin-gated)', () => {
  it('rejects create-user with no token at all (no unauthenticated privilege escalation)', async () => {
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Shoresh', 'a'.repeat(64))
    const handlers = makeHandlers(db, deviceId, {})
    await expect(
      handlers.createUser({ camp_id: campId, name: 'Mallory', pin: '1234', role: 'admin' })
    ).rejects.toThrow('token is required')
  })

  it('rejects create-user when the token belongs to a non-admin (staff) user', async () => {
    const { campId } = await seedCampAndUser({ name: 'StaffPerson', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = await handlers.login({ name: 'StaffPerson', pin: '1234' })

    await expect(
      handlers.createUser({ token, camp_id: campId, name: 'Mallory', pin: '1234', role: 'admin' })
    ).rejects.toThrow('admin role required')
  })

  it('validates required fields once an admin session is presented', async () => {
    const { campId } = await seedCampAndUser({ name: 'AdminPerson', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = await handlers.login({ name: 'AdminPerson', pin: '1234' })

    await expect(handlers.createUser({ token, name: 'Bob', pin: '1234', role: 'staff' })).rejects.toThrow()
    await expect(
      handlers.createUser({ token, camp_id: campId, name: 'Bob', pin: '1234', role: 'admin-ish' })
    ).rejects.toThrow()
  })

  it('creates a user when an admin session and all fields are valid', async () => {
    const { campId } = await seedCampAndUser({ name: 'AdminPerson2', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Shoresh', port: 7202 })
    const { token } = await handlers.login({ name: 'AdminPerson2', pin: '1234' })

    const created = await handlers.createUser({ token, camp_id: campId, name: 'Bob', pin: '1234', role: 'staff' })
    expect(created.name).toBe('Bob')
  })

  it('propagates a clear rejection through the IPC handler when the syncClient write resolves a non-applied status', async () => {
    const { campId } = await seedCampAndUser({ name: 'AdminPerson3', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Shoresh', port: 7203 })
    const { token } = await handlers.login({ name: 'AdminPerson3', pin: '1234' })

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
    const { token } = await handlers.login({ name: 'Gina', pin: '6666' })

    // entity must be a real staff-writable entity (per PERMISSIONS.staff in
    // electron/auth/permissions.js) now that write() routes ordinary field
    // writes through authorize() as '<entity>.write' — 'x' isn't in the
    // matrix and would (correctly) fail authorization before ever reaching
    // the syncClient check this test is about.
    expect(() => handlers.write({ token, entity: 'cohorts', entity_id: 'y', field: 'z', value: 1 })).toThrow(
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
    const { token } = await handlers.login({ name: 'Carol', pin: '4321' })

    await handlers.write({ token, entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim' })

    expect(lastCreatedSyncClient.write).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'activities', author_user_id: user.id })
    )
  })

  describe('DELETE_FIELD authorization (Round 2 Security MEDIUM #1: admin-gated delete)', () => {
    it('rejects a delete write from a non-admin (staff) session', async () => {
      const { campId } = await seedCampAndUser({ name: 'StaffDeleter', pin: '2468', role: 'staff' })
      const handlers = makeHandlers(db, deviceId, {})
      await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7104 })
      const { token } = await handlers.login({ name: 'StaffDeleter', pin: '2468' })

      expect(() =>
        handlers.write({ token, entity: 'cohorts', entity_id: 'some-cohort', field: '__deleted__', value: 1 })
      ).toThrow('admin role required')
      expect(lastCreatedSyncClient.write).not.toHaveBeenCalled()
      void campId
    })

    it('allows a delete write from an admin session', async () => {
      await seedCampAndUser({ name: 'AdminDeleter', pin: '2468', role: 'admin' })
      const handlers = makeHandlers(db, deviceId, {})
      await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7105 })
      const { token } = await handlers.login({ name: 'AdminDeleter', pin: '2468' })

      await handlers.write({ token, entity: 'cohorts', entity_id: 'some-cohort', field: '__deleted__', value: 1 })

      expect(lastCreatedSyncClient.write).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'cohorts', field: '__deleted__' })
      )
    })

    it('does not gate ordinary (non-delete) field writes for a non-admin', async () => {
      const { user } = await seedCampAndUser({ name: 'StaffWriter', pin: '1357', role: 'staff' })
      const handlers = makeHandlers(db, deviceId, {})
      await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7106 })
      const { token } = await handlers.login({ name: 'StaffWriter', pin: '1357' })

      await handlers.write({ token, entity: 'cohorts', entity_id: 'some-cohort', field: 'name', value: 'X' })

      expect(lastCreatedSyncClient.write).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'cohorts', field: 'name', author_user_id: user.id })
      )
    })
  })
})

describe('bulkReplace handler', () => {
  it('rejects a missing token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() =>
      handlers.bulkReplace({ entity: 'template_slots', scope_id: 't1', rows: [] })
    ).toThrow()
  })

  it('rejects a malformed/invalid token cleanly', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7201 })
    expect(() =>
      handlers.bulkReplace({ token: 'not-a-real-token', entity: 'template_slots', scope_id: 't1', rows: [] })
    ).toThrow()
  })

  it('rejects a bulk_replace from a non-admin (staff) session', async () => {
    await seedCampAndUser({ name: 'StaffBulk', pin: '1111', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7202 })
    const { token } = await handlers.login({ name: 'StaffBulk', pin: '1111' })

    expect(() =>
      handlers.bulkReplace({ token, entity: 'template_slots', scope_id: 't1', rows: [] })
    ).toThrow('admin role required')
    expect(lastCreatedSyncClient.writeBulkReplace).not.toHaveBeenCalled()
  })

  it('delegates to syncClient.writeBulkReplace for an admin session', async () => {
    const { user } = await seedCampAndUser({ name: 'AdminBulk', pin: '2222', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7203 })
    const { token } = await handlers.login({ name: 'AdminBulk', pin: '2222' })

    const rows = [{ id: 'slot-1', template_id: 't1' }]
    await handlers.bulkReplace({ token, entity: 'template_slots', scope_id: 't1', rows })

    expect(lastCreatedSyncClient.writeBulkReplace).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'template_slots', scope_id: 't1', rows, author_user_id: user.id })
    )
  })

  it('rejects with a clear error when no syncClient exists yet', async () => {
    await seedCampAndUser({ name: 'NoSync', pin: '3333', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = await handlers.login({ name: 'NoSync', pin: '3333' })

    expect(() =>
      handlers.bulkReplace({ token, entity: 'template_slots', scope_id: 't1', rows: [] })
    ).toThrow('sync not initialized — choose a mode first')
  })
})

describe('camps.rename authorization (admin-only, distinct from ordinary write)', () => {
  it('rejects a camps.name write from a non-admin (staff) session', async () => {
    await seedCampAndUser({ name: 'StaffRenamer', pin: '1122', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7107 })
    const { token } = await handlers.login({ name: 'StaffRenamer', pin: '1122' })

    const campId = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    expect(() =>
      handlers.write({ token, entity: 'camps', entity_id: campId, field: 'name', value: 'New Name' })
    ).toThrow('admin role required')
    expect(lastCreatedSyncClient.write).not.toHaveBeenCalled()
  })

  it('allows a camps.name write from an admin session', async () => {
    await seedCampAndUser({ name: 'AdminRenamer', pin: '1122', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7108 })
    const { token } = await handlers.login({ name: 'AdminRenamer', pin: '1122' })

    const campId = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    await handlers.write({ token, entity: 'camps', entity_id: campId, field: 'name', value: 'New Name' })

    expect(lastCreatedSyncClient.write).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'camps', field: 'name' })
    )
  })
})

// Design doc testing-plan item 3: the single most load-bearing test in this
// phase. Issues a token for a user, flips that SAME user's role directly in
// the db (never mints a fresh token), and confirms the SAME still-valid
// token is denied/allowed on the very next call — proving authorize()
// re-derives role fresh from the db on every IPC call rather than trusting
// anything cached on the token/session.
describe('role-change-takes-effect (IPC path, same token reused)', () => {
  it('an admin token is denied for users.create (shoresh:create-user) after being demoted to staff mid-session', async () => {
    const { campId, user } = await seedCampAndUser({ name: 'DemotedAdmin', pin: '9090', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7109 })
    const { token } = await handlers.login({ name: 'DemotedAdmin', pin: '9090' })

    // Confirm the token starts out genuinely admin-capable.
    await expect(
      handlers.createUser({ token, camp_id: campId, name: 'FirstHire', pin: '1234', role: 'staff' })
    ).resolves.toBeTruthy()

    // Simulate another admin disabling/demoting this user elsewhere — the
    // token itself is untouched, only the DB row changes.
    db.prepare("UPDATE users SET role = 'staff' WHERE id = ?").run(user.id)

    await expect(
      handlers.createUser({ token, camp_id: campId, name: 'SecondHire', pin: '1234', role: 'staff' })
    ).rejects.toThrow('admin role required')
  })

  it('a staff token is denied for shoresh:write with DELETE_FIELD, then allowed on the SAME token after being promoted to admin mid-session', async () => {
    const { user } = await seedCampAndUser({ name: 'PromotedStaff', pin: '4560', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7110 })
    const { token } = await handlers.login({ name: 'PromotedStaff', pin: '4560' })

    expect(() =>
      handlers.write({ token, entity: 'cohorts', entity_id: 'c1', field: '__deleted__', value: 1 })
    ).toThrow('admin role required')

    // Another admin promotes this user — same token, no fresh login.
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id)

    await handlers.write({ token, entity: 'cohorts', entity_id: 'c1', field: '__deleted__', value: 1 })
    expect(lastCreatedSyncClient.write).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'cohorts', field: '__deleted__' })
    )
  })
})

// Design doc testing-plan item 4: every entity/action reachable by BOTH
// admin and staff today (per the ADR's PERMISSIONS.staff matrix) must remain
// reachable by both after this change — guards against accidentally
// admin-gating something staff currently uses. Sweeps the FULL entity list
// from electron/auth/permissions.js's ENTITIES, not a sample.
describe('existing-behavior-preserved: full entity sweep (staff + admin both reach ordinary read/write)', () => {
  // Imported from the real permission matrix (not hand-copied) so this
  // sweep can't silently degrade to a sample if a future entity is added
  // to permissions.js and this list isn't updated in lockstep.

  // Not every entity's PROJECTIONS.fields (electron/ops/projections.js)
  // includes a literal 'name' field — days_of_operation uses 'label' and
  // day_override_template_slots has no name-shaped field at all. Writing an
  // unregistered field throws 'field not allowed for entity' before
  // authorize() even matters, which would be a false failure unrelated to
  // this sweep's actual purpose (proving the AUTHORIZATION gate, not the
  // projection field allowlist, doesn't regress staff access).
  const WRITABLE_FIELD_BY_ENTITY = {
    groups: 'name',
    tiers: 'name',
    activities: 'name',
    cohorts: 'name',
    days_of_operation: 'label',
    time_blocks: 'name',
    anchor_activities: 'name',
    schedule_templates: 'name',
    day_override_templates: 'name',
    schedule_weeks: 'name',
    template_slots: 'activity_id',
    template_overlays: 'label',
    schedule_snapshots: 'name',
    day_override_template_slots: 'time_block_id',
    // Exclusion rows have no name-shaped field; 'week_id' is the field their
    // projection's ensureExists keys on (electron/ops/projections.js:205-226).
    week_activity_exclusions: 'week_id',
    week_group_exclusions: 'week_id',
    locations: 'name',
    // location_id, not week_id: week_id would trigger ensureExists's INSERT with
    // a FK to schedule_weeks (the sweep's 'V' is not a real week). Same
    // non-ensureExists-field trick template_slots uses with activity_id.
    week_location_exclusions: 'location_id',
  }

  // Login is scoped to the single camp in this db (`SELECT id FROM camps
  // LIMIT 1` — single-camp-per-device-db convention), so both sessions here
  // must share ONE seeded camp rather than each calling seedCampAndUser
  // (which mints a fresh camp per call) — otherwise the second login can
  // silently fail to find its user under the "current" camp.
  async function seedTwoRoleSessions(handlers, { staffName, adminName }) {
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Sweep Camp', 'c'.repeat(64))
    await createUser(db, { camp_id: campId, name: staffName, pin: '1234', role: 'staff' }, localTestWrite())
    await createUser(db, { camp_id: campId, name: adminName, pin: '1234', role: 'admin' }, localTestWrite())
    const { token: staffToken } = await handlers.login({ name: staffName, pin: '1234' })
    const { token: adminToken } = await handlers.login({ name: adminName, pin: '1234' })
    return { staffToken, adminToken }
  }

  it('every entity is readable (shoresh:list) by both a staff and an admin session', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const { staffToken, adminToken } = await seedTwoRoleSessions(handlers, {
      staffName: 'SweepStaffReader',
      adminName: 'SweepAdminReader',
    })

    for (const entity of ENTITIES) {
      expect(() => handlers.list(staffToken, entity), `staff read ${entity}`).not.toThrow()
      expect(() => handlers.list(adminToken, entity), `admin read ${entity}`).not.toThrow()
    }
  })

  it('every entity accepts an ordinary (non-delete, non-rename) field write from both a staff and an admin session', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7111 })
    const { staffToken, adminToken } = await seedTwoRoleSessions(handlers, {
      staffName: 'SweepStaffWriter',
      adminName: 'SweepAdminWriter',
    })

    for (const entity of ENTITIES) {
      const field = WRITABLE_FIELD_BY_ENTITY[entity]
      await expect(
        handlers.write({ token: staffToken, entity, entity_id: 'x1', field, value: 'V' }),
        `staff write ${entity}`
      ).resolves.toBeTruthy()
      await expect(
        handlers.write({ token: adminToken, entity, entity_id: 'x1', field, value: 'V' }),
        `admin write ${entity}`
      ).resolves.toBeTruthy()
    }
  })

  // deleteWeekHandler is the one week op that is admin-only: it authorizes
  // 'schedule_weeks.delete' (not '.write'), because deleteWeek() is a
  // permanent, non-restorable cascade. Auth is checked BEFORE weekId/camp
  // lookup, so a bogus weekId still exercises the gate. This guards against a
  // regression to the '.write' gate, which staff hold — the matrix assertion in
  // authorize.test.js only bites if the handler actually uses '.delete'.
  it('deletes a week for an admin but denies a staff session (admin-only, .delete-gated)', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7112 })
    const { staffToken, adminToken } = await seedTwoRoleSessions(handlers, {
      staffName: 'WeekDelStaff',
      adminName: 'WeekDelAdmin',
    })

    expect(() => handlers.deleteWeek({ token: staffToken, weekId: 'nonexistent' })).toThrow(
      'admin role required'
    )
    // Admin clears the authorization gate and reaches the data layer — the only
    // remaining failure is a benign data-layer guard (here 'last-week', since
    // this camp was seeded with no weeks), never 'admin role required'.
    expect(() => handlers.deleteWeek({ token: adminToken, weekId: 'nonexistent' })).not.toThrow()
    expect(handlers.deleteWeek({ token: adminToken, weekId: 'nonexistent' })).toEqual({
      error: 'last-week',
    })
  })
})

describe('sanitizeConflictForIpc (Round 2 Fix 1: main-process PIN filtering)', () => {
  it('strips value from a users.pin_hash op on both sides', () => {
    const msg = {
      type: 'op_conflict',
      incomingOp: { id: 'op1', entity: 'users', entity_id: 'u1', field: 'pin_hash', value: 'scrypt$deadbeef...', author_user_id: 'u1', device_id: 'dA', timestamp: 't1' },
      existingOp: { id: 'op2', entity: 'users', entity_id: 'u1', field: 'pin_hash', value: 'scrypt$c0ffee...', author_user_id: 'u1', device_id: 'dB', timestamp: 't2' },
    }
    const sanitized = sanitizeConflictForIpc(msg)
    expect(sanitized.incomingOp).not.toHaveProperty('value')
    expect(sanitized.existingOp).not.toHaveProperty('value')
    // Confirm the raw digest string is nowhere in the serialized message —
    // this is the actual IPC payload shape, not just what the UI renders.
    expect(JSON.stringify(sanitized)).not.toContain('deadbeef')
    expect(JSON.stringify(sanitized)).not.toContain('c0ffee')
    // Non-value fields the UI needs (author/device/timestamp/id) survive.
    expect(sanitized.incomingOp.id).toBe('op1')
    expect(sanitized.incomingOp.device_id).toBe('dA')
  })

  it('strips value from a users.pin_salt op', () => {
    const msg = {
      incomingOp: { id: 'op1', entity: 'users', entity_id: 'u1', field: 'pin_salt', value: 'saltvalue123' },
      existingOp: { id: 'op2', entity: 'users', entity_id: 'u1', field: 'pin_salt', value: 'saltvalue456' },
    }
    const sanitized = sanitizeConflictForIpc(msg)
    expect(sanitized.incomingOp).not.toHaveProperty('value')
    expect(sanitized.existingOp).not.toHaveProperty('value')
  })

  it('leaves non-PIN fields (e.g. a name conflict) untouched, value included', () => {
    const msg = {
      incomingOp: { id: 'op1', entity: 'users', entity_id: 'u1', field: 'name', value: 'Alice' },
      existingOp: { id: 'op2', entity: 'users', entity_id: 'u1', field: 'name', value: 'Alicia' },
    }
    const sanitized = sanitizeConflictForIpc(msg)
    expect(sanitized.incomingOp.value).toBe('Alice')
    expect(sanitized.existingOp.value).toBe('Alicia')
  })

  it('leaves non-users-entity fields untouched even if the field is named pin_hash', () => {
    const msg = {
      incomingOp: { id: 'op1', entity: 'template_slots', entity_id: 's1', field: 'pin_hash', value: 'not-actually-a-pin' },
      existingOp: { id: 'op2', entity: 'template_slots', entity_id: 's1', field: 'pin_hash', value: 'also-not-a-pin' },
    }
    const sanitized = sanitizeConflictForIpc(msg)
    expect(sanitized.incomingOp.value).toBe('not-actually-a-pin')
  })
})

describe('wireOpApplied: op-applied forwarding to renderer (Round 3 Fix 1)', () => {
  it('sends a SANITIZED applied-op message via webContents.send — the raw PIN op value never crosses the IPC boundary', async () => {
    const sendSpy = vi.fn()
    const fakeWindow = { webContents: { send: sendSpy } }
    const handlers = makeHandlers(db, deviceId, { getMainWindow: () => fakeWindow })
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7160 })

    expect(lastCreatedSyncClient.onOpApplied).toHaveBeenCalled()
    const registeredCallback = lastCreatedSyncClient.onOpApplied.mock.calls[0][0]

    const rawOp = { id: 'op1', entity: 'users', entity_id: 'u1', field: 'pin_hash', value: 'RAW-SCRYPT-DIGEST', device_id: 'dA' }
    registeredCallback(rawOp)

    expect(sendSpy).toHaveBeenCalledWith('shoresh:op-applied', expect.any(Object))
    const sentOp = sendSpy.mock.calls.find((c) => c[0] === 'shoresh:op-applied')[1]
    expect(JSON.stringify(sentOp)).not.toContain('RAW-SCRYPT-DIGEST')
    expect(sentOp).not.toHaveProperty('value')
  })

  it('sends pin_salt applied ops sanitized too', async () => {
    const sendSpy = vi.fn()
    const fakeWindow = { webContents: { send: sendSpy } }
    const handlers = makeHandlers(db, deviceId, { getMainWindow: () => fakeWindow })
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7161 })

    const registeredCallback = lastCreatedSyncClient.onOpApplied.mock.calls[0][0]
    const rawOp = { id: 'op2', entity: 'users', entity_id: 'u1', field: 'pin_salt', value: 'RAW-SALT', device_id: 'dA' }
    registeredCallback(rawOp)

    const sentOp = sendSpy.mock.calls.find((c) => c[0] === 'shoresh:op-applied')[1]
    expect(JSON.stringify(sentOp)).not.toContain('RAW-SALT')
    expect(sentOp).not.toHaveProperty('value')
  })

  it('leaves non-PIN applied ops untouched, value included', async () => {
    const sendSpy = vi.fn()
    const fakeWindow = { webContents: { send: sendSpy } }
    const handlers = makeHandlers(db, deviceId, { getMainWindow: () => fakeWindow })
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7162 })

    const registeredCallback = lastCreatedSyncClient.onOpApplied.mock.calls[0][0]
    const rawOp = { id: 'op3', entity: 'users', entity_id: 'u1', field: 'name', value: 'Alice', device_id: 'dA' }
    registeredCallback(rawOp)

    const sentOp = sendSpy.mock.calls.find((c) => c[0] === 'shoresh:op-applied')[1]
    expect(sentOp.value).toBe('Alice')
  })
})

// T87 (docs/adr/2026-08-16-client-reauth-on-restart.md, Part 3): mirrors the
// onPairingDenied forwarding shape exactly.
describe('wirePairingCallbacks: auth-rejected forwarding to renderer (T87 Part 3)', () => {
  it('sends the close code to the renderer, and nothing else', async () => {
    const sendSpy = vi.fn()
    const fakeWindow = { webContents: { send: sendSpy } }
    const handlers = makeHandlers(db, deviceId, { getMainWindow: () => fakeWindow })
    await handlers.chooseMode({ mode: 'client', host: '192.168.1.5', port: 7163 })

    expect(lastCreatedSyncClient.onAuthRejected).toHaveBeenCalled()
    const registeredCallback = lastCreatedSyncClient.onAuthRejected.mock.calls[0][0]

    registeredCallback(4404)

    expect(sendSpy).toHaveBeenCalledWith('shoresh:auth-rejected', { code: 4404 })
    // Negative security (Test strategy item 4): the payload carries only the
    // numeric code — no token, no device_id, nothing else.
    const payload = sendSpy.mock.calls.find((c) => c[0] === 'shoresh:auth-rejected')[1]
    expect(Object.keys(payload)).toEqual(['code'])
  })
})

describe('wireOpApplied: op-conflict forwarding to renderer (Round 2 Fix 1)', () => {
  it('sends a SANITIZED conflict message via webContents.send — the raw PIN op never crosses the IPC boundary', async () => {
    const sendSpy = vi.fn()
    const fakeWindow = { webContents: { send: sendSpy } }
    const handlers = makeHandlers(db, deviceId, { getMainWindow: () => fakeWindow })
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7150 })

    expect(lastCreatedSyncClient.onOpConflict).toHaveBeenCalled()
    const registeredCallback = lastCreatedSyncClient.onOpConflict.mock.calls[0][0]

    const rawMsg = {
      type: 'op_conflict',
      incomingOp: { id: 'op1', entity: 'users', entity_id: 'u1', field: 'pin_hash', value: 'RAW-SCRYPT-DIGEST', device_id: 'dA' },
      existingOp: { id: 'op2', entity: 'users', entity_id: 'u1', field: 'pin_hash', value: 'RAW-SCRYPT-DIGEST-2', device_id: 'dB' },
    }
    registeredCallback(rawMsg)

    expect(sendSpy).toHaveBeenCalledWith('shoresh:op-conflict', expect.any(Object))
    const sentMsg = sendSpy.mock.calls[0][1]
    expect(JSON.stringify(sentMsg)).not.toContain('RAW-SCRYPT-DIGEST')
    expect(sentMsg.incomingOp).not.toHaveProperty('value')
    expect(sentMsg.existingOp).not.toHaveProperty('value')
  })
})

// T8 (docs/adr/2026-08-15-locations-concurrent-create-collision.md addendum,
// Finding E): op_rejected's `op` is the full submitted op, unsanitized — the
// same PIN-bearing-field risk op-applied/op-conflict already close. Mirrors
// the op-conflict forwarding test above exactly.
describe('sanitizeOpRejectedForIpc (Finding E)', () => {
  it('strips value from a users.pin_hash op inside msg.op', () => {
    const msg = {
      type: 'op_rejected',
      op: { id: 'op1', entity: 'users', entity_id: 'u1', field: 'pin_hash', value: 'RAW-SCRYPT-DIGEST', device_id: 'dA' },
      reason: 'unique_field',
      field: 'pin_hash',
      existing: { id: 'u2', name: 'someone' },
    }
    const sanitized = sanitizeOpRejectedForIpc(msg)
    expect(sanitized.op).not.toHaveProperty('value')
    expect(JSON.stringify(sanitized)).not.toContain('RAW-SCRYPT-DIGEST')
    // Everything else passes through untouched.
    expect(sanitized.reason).toBe('unique_field')
    expect(sanitized.existing).toEqual({ id: 'u2', name: 'someone' })
  })

  it('leaves a non-PIN op (the real locations case) untouched, value included', () => {
    const msg = {
      type: 'op_rejected',
      op: { id: 'op1', entity: 'locations', entity_id: 'loc-b', field: 'name', value: 'Pool', device_id: 'dA' },
      reason: 'unique_field',
      field: 'name',
      existing: { id: 'loc-a', name: 'Pool', capacity: 2, notes: null },
    }
    const sanitized = sanitizeOpRejectedForIpc(msg)
    expect(sanitized.op.value).toBe('Pool')
  })

  it('handles a msg with no op (the host-local direct-write rejection shape) without throwing', () => {
    const msg = { status: 'rejected', reason: 'unique_field', existing: { id: 'loc-a', name: 'Pool' } }
    expect(() => sanitizeOpRejectedForIpc(msg)).not.toThrow()
  })
})

describe('wireOpApplied: op-rejected forwarding to renderer (T8 / Finding E)', () => {
  it('sends a SANITIZED rejected message via webContents.send — the raw PIN op never crosses the IPC boundary', async () => {
    const sendSpy = vi.fn()
    const fakeWindow = { webContents: { send: sendSpy } }
    const handlers = makeHandlers(db, deviceId, { getMainWindow: () => fakeWindow })
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7151 })

    expect(lastCreatedSyncClient.onOpRejected).toHaveBeenCalled()
    const registeredCallback = lastCreatedSyncClient.onOpRejected.mock.calls[0][0]

    const rawMsg = {
      type: 'op_rejected',
      op: { id: 'op1', entity: 'users', entity_id: 'u1', field: 'pin_hash', value: 'RAW-SCRYPT-DIGEST', device_id: 'dA' },
      reason: 'unique_field',
      field: 'pin_hash',
      existing: { id: 'u2', name: 'someone' },
    }
    registeredCallback(rawMsg)

    expect(sendSpy).toHaveBeenCalledWith('shoresh:op-rejected', expect.any(Object))
    const sentMsg = sendSpy.mock.calls.find((c) => c[0] === 'shoresh:op-rejected')[1]
    expect(JSON.stringify(sentMsg)).not.toContain('RAW-SCRYPT-DIGEST')
    expect(sentMsg.op).not.toHaveProperty('value')
  })

  it('leaves the real (non-PIN) locations rejection untouched, value included', async () => {
    const sendSpy = vi.fn()
    const fakeWindow = { webContents: { send: sendSpy } }
    const handlers = makeHandlers(db, deviceId, { getMainWindow: () => fakeWindow })
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7152 })

    const registeredCallback = lastCreatedSyncClient.onOpRejected.mock.calls[0][0]
    const rawMsg = {
      type: 'op_rejected',
      op: { id: 'op1', entity: 'locations', entity_id: 'loc-b', field: 'name', value: 'Pool', device_id: 'dA' },
      reason: 'unique_field',
      field: 'name',
      existing: { id: 'loc-a', name: 'Pool', capacity: 2, notes: null },
    }
    registeredCallback(rawMsg)

    const sentMsg = sendSpy.mock.calls.find((c) => c[0] === 'shoresh:op-rejected')[1]
    expect(sentMsg.op.value).toBe('Pool')
    expect(sentMsg.existing).toEqual({ id: 'loc-a', name: 'Pool', capacity: 2, notes: null })
  })
})

describe('list: generic entity-read IPC', () => {
  it('direct camp_id table (groups): returns only the requesting camp rows, not another camp\'s', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const campId = randomUUID()
    const otherCampId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp A', 'a'.repeat(64))
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(otherCampId, 'Camp B', 'b'.repeat(64))
    // list() scopes by whichever camp `SELECT id FROM camps LIMIT 1` returns
    // (single-camp-per-db convention) — SQLite's row order for a TEXT
    // primary key is not insertion order, so ask the db which camp that is
    // rather than assuming it's campId, then seed "mine"/"not mine" rows
    // relative to that camp. Both camps' groups rows exist simultaneously to
    // prove the query actually filters rather than returning everything.
    const myCampId = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    const foreignCampId = myCampId === campId ? otherCampId : campId
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), myCampId, 'Mine')
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), foreignCampId, 'Not Mine')
    const user = await createUser(db, { camp_id: myCampId, name: 'Lister', pin: '1234', role: 'staff' }, localTestWrite())
    const { token } = await handlers.login({ name: 'Lister', pin: '1234' })
    void user

    const rows = handlers.list(token, 'groups')
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Mine')
    expect(rows[0].camp_id).toBe(myCampId)
  })

  it('parent-scoped table (template_overlays): scoped via JOIN through schedule_templates, not a literal camp_id column', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const campId = randomUUID()
    const otherCampId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp A', 'a'.repeat(64))
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(otherCampId, 'Camp B', 'b'.repeat(64))
    const myCampId = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    const foreignCampId = myCampId === campId ? otherCampId : campId

    const myTemplateId = randomUUID()
    const otherTemplateId = randomUUID()
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(myTemplateId, myCampId, 'Mine Template')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(otherTemplateId, foreignCampId, 'Other Camp Template')

    db.prepare('INSERT INTO template_overlays (id, template_id, label) VALUES (?, ?, ?)').run(randomUUID(), myTemplateId, 'Mine Overlay')
    db.prepare('INSERT INTO template_overlays (id, template_id, label) VALUES (?, ?, ?)').run(randomUUID(), otherTemplateId, 'Other Overlay')
    await createUser(db, { camp_id: myCampId, name: 'Lister2', pin: '1234', role: 'staff' }, localTestWrite())
    const { token } = await handlers.login({ name: 'Lister2', pin: '1234' })

    const rows = handlers.list(token, 'template_overlays')
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe('Mine Overlay')
    expect(rows[0].template_id).toBe(myTemplateId)
  })

  it('template_slots has no camp_id column in schema.sql (only template_id) — it is scoped via JOIN through schedule_templates, same as the other 3 parent-scoped tables, not treated as a direct camp_id table', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const campId = randomUUID()
    const otherCampId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp A', 'a'.repeat(64))
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(otherCampId, 'Camp B', 'b'.repeat(64))
    const myCampId = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    const foreignCampId = myCampId === campId ? otherCampId : campId

    const myTemplateId = randomUUID()
    const otherTemplateId = randomUUID()
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(myTemplateId, myCampId, 'Mine')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(otherTemplateId, foreignCampId, 'Other')

    db.prepare('INSERT INTO template_slots (id, template_id) VALUES (?, ?)').run(randomUUID(), myTemplateId)
    db.prepare('INSERT INTO template_slots (id, template_id) VALUES (?, ?)').run(randomUUID(), otherTemplateId)
    await createUser(db, { camp_id: myCampId, name: 'Lister3', pin: '1234', role: 'staff' }, localTestWrite())
    const { token } = await handlers.login({ name: 'Lister3', pin: '1234' })

    const rows = handlers.list(token, 'template_slots')
    expect(rows).toHaveLength(1)
    expect(rows[0].template_id).toBe(myTemplateId)
  })

  it('rejects a non-string entity without touching the db', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = await seedCampAndUser({ name: 'Lister4', pin: '1234' }).then(async ({ campId }) => {
      void campId
      return handlers.login({ name: 'Lister4', pin: '1234' })
    })
    expect(() => handlers.list(token, 123)).toThrow()
    expect(() => handlers.list(token, null)).toThrow()
    expect(() => handlers.list(token, undefined)).toThrow()
  })

  it('rejects an unrecognized entity string, including a SQL-injection-shaped one, without throwing an unhandled exception or touching the db', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const { campId } = await seedCampAndUser({ name: 'Lister5', pin: '1234' })
    const { token } = await handlers.login({ name: 'Lister5', pin: '1234' })
    void campId

    expect(() => handlers.list(token, 'users; DROP TABLE users;--')).toThrow()
    expect(() => handlers.list(token, 'nonexistent_table')).toThrow()

    // Prove the injection attempt never reached the db: users table is intact.
    const stillExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()
    expect(stillExists).toBeTruthy()
  })

  it('rejects list() with no token at all', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.list(undefined, 'groups')).toThrow('token is required')
  })

  describe('authorize() wiring (staff/admin)', () => {
    it('allows a staff session to read a staff-permitted entity (<entity>.read)', async () => {
      const { campId } = await seedCampAndUser({ name: 'StaffReader', pin: '1234', role: 'staff' })
      const handlers = makeHandlers(db, deviceId, {})
      const { token } = await handlers.login({ name: 'StaffReader', pin: '1234' })
      void campId

      expect(() => handlers.list(token, 'groups')).not.toThrow()
    })

    it('rejects a malformed/invalid token cleanly', () => {
      const handlers = makeHandlers(db, deviceId, {})
      expect(() => handlers.list('not-a-real-token', 'groups')).toThrow()
    })
  })
})

describe('listByScope: scope-filtered entity-read IPC (C4)', () => {
  it('rejects day_override_template_slots even though it is in PARENT_SCOPED_ENTITIES (SCOPED_LIST_ENTITIES gate)', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const { campId } = await seedCampAndUser({ name: 'Scoper1', pin: '1234' })
    const { token } = await handlers.login({ name: 'Scoper1', pin: '1234' })
    void campId

    expect(() => handlers.listByScope(token, 'day_override_template_slots', 'anything')).toThrow(
      'Unrecognized entity'
    )
  })

  it('rejects an entity absent from both registries', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const { campId } = await seedCampAndUser({ name: 'Scoper2', pin: '1234' })
    const { token } = await handlers.login({ name: 'Scoper2', pin: '1234' })
    void campId

    expect(() => handlers.listByScope(token, 'nonexistent_table', 'x')).toThrow('Unrecognized entity')
  })

  it('returns only rows for the requested template_id, scoped additionally by camp (cross-camp rows excluded)', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const campId = randomUUID()
    const otherCampId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp A', 'a'.repeat(64))
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(otherCampId, 'Camp B', 'b'.repeat(64))
    const myCampId = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    const foreignCampId = myCampId === campId ? otherCampId : campId

    const myTemplateId = randomUUID()
    const myOtherTemplateId = randomUUID()
    const foreignTemplateId = randomUUID()
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(myTemplateId, myCampId, 'Mine')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(myOtherTemplateId, myCampId, 'Mine Other')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(foreignTemplateId, foreignCampId, 'Foreign')

    // Same template_id value used across camps would be a coincidence in
    // production (ids are UUIDs), but the camp predicate must still exclude
    // a foreign camp's row even if it happened to share the requested id —
    // so seed a foreign-camp slot under a DIFFERENT template_id to prove the
    // "correct rows for a valid entity" case, and a same-camp-different-
    // template slot to prove the scope predicate isn't just "any camp row".
    db.prepare('INSERT INTO template_slots (id, template_id) VALUES (?, ?)').run(randomUUID(), myTemplateId)
    db.prepare('INSERT INTO template_slots (id, template_id) VALUES (?, ?)').run(randomUUID(), myOtherTemplateId)
    db.prepare('INSERT INTO template_slots (id, template_id) VALUES (?, ?)').run(randomUUID(), foreignTemplateId)

    await createUser(db, { camp_id: myCampId, name: 'Scoper3', pin: '1234', role: 'staff' }, localTestWrite())
    const { token } = await handlers.login({ name: 'Scoper3', pin: '1234' })

    const rows = handlers.listByScope(token, 'template_slots', myTemplateId)
    expect(rows).toHaveLength(1)
    expect(rows[0].template_id).toBe(myTemplateId)
  })

  it('an unminted/null scopeId returns [] without throwing', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const { campId } = await seedCampAndUser({ name: 'Scoper4', pin: '1234' })
    const { token } = await handlers.login({ name: 'Scoper4', pin: '1234' })
    void campId

    expect(handlers.listByScope(token, 'template_slots', null)).toEqual([])
    expect(handlers.listByScope(token, 'template_slots', undefined)).toEqual([])
  })

  it('rejects with no token at all', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.listByScope(undefined, 'template_slots', 'x')).toThrow('token is required')
  })
})

describe('listUsers handler (users.read, staff+admin)', () => {
  it('rejects with no token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.listUsers(undefined)).toThrow('token is required')
  })

  it('allows a staff session', async () => {
    await seedCampAndUser({ name: 'StaffLister', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = await handlers.login({ name: 'StaffLister', pin: '1234' })
    expect(() => handlers.listUsers(token)).not.toThrow()
  })
})

describe('getDeviceId handler (devices.read, staff+admin)', () => {
  it('rejects with no token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.getDeviceId(undefined)).toThrow('token is required')
  })

  it('allows a staff session and returns this device\'s id', async () => {
    await seedCampAndUser({ name: 'StaffDevice', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = await handlers.login({ name: 'StaffDevice', pin: '1234' })
    expect(handlers.getDeviceId(token)).toBe(deviceId)
  })
})

describe('listPendingConflicts handler (conflicts.read, staff+admin)', () => {
  it('rejects with no token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.listPendingConflicts(undefined)).toThrow('token is required')
  })

  it('allows a staff session', async () => {
    await seedCampAndUser({ name: 'StaffConflicts', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = await handlers.login({ name: 'StaffConflicts', pin: '1234' })
    expect(() => handlers.listPendingConflicts(token)).not.toThrow()
  })
})

describe('resolveConflict handler (conflicts.resolve, staff+admin)', () => {
  it('rejects with no token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() =>
      handlers.resolveConflict({ entity: 'groups', entity_id: 'g1', field: 'name', chosen_op_id: 'op1' })
    ).toThrow('token is required')
  })

  it('rejects a malformed/invalid token cleanly', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7301 })
    expect(() =>
      handlers.resolveConflict({
        token: 'not-a-real-token',
        entity: 'groups',
        entity_id: 'g1',
        field: 'name',
        chosen_op_id: 'op1',
      })
    ).toThrow()
  })

  it('allows a staff session past authorization (fails later on chosen_op_id, proving it got past the auth gate)', async () => {
    await seedCampAndUser({ name: 'StaffResolver', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7302 })
    const { token } = await handlers.login({ name: 'StaffResolver', pin: '1234' })

    expect(() =>
      handlers.resolveConflict({ token, entity: 'groups', entity_id: 'g1', field: 'name', chosen_op_id: 'does-not-exist' })
    ).toThrow('chosen operation not found')
  })

  // S2b R1 (§3a): the source-aware stale-accept path. Accepting an import value
  // must stamp source:'import' so the acceptance sticks and future re-imports
  // update quietly; any other resolution stays 'human'.
  it('stale_accept:true stamps source=import on the resolution write; default stays human', async () => {
    await seedCampAndUser({ name: 'AdminResolver', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7305 })
    const { token } = await handlers.login({ name: 'AdminResolver', pin: '1234' })

    // A group whose name was hand-edited (human), plus an op holding the value
    // the director will ACCEPT from the import.
    const gid = randomUUID()
    appendOp(db, { entity: 'groups', entity_id: gid, field: 'camp_id', value: db.prepare('SELECT id FROM camps LIMIT 1').get().id, device_id: deviceId, source: 'import' })
    const humanOp = appendOp(db, { entity: 'groups', entity_id: gid, field: 'name', value: 'Hand Edited', device_id: deviceId, source: 'human' })
    const importOp = appendOp(db, { entity: 'groups', entity_id: gid, field: 'name', value: 'Imported Value', device_id: deviceId, source: 'import' })

    // Accept the import value → source:'import'.
    handlers.resolveConflict({
      token, entity: 'groups', entity_id: gid, field: 'name',
      chosen_op_id: importOp.id, parent_op_id: humanOp.id, stale_accept: true,
    })
    let latest = latestOp(db, 'groups', gid, 'name')
    expect(latest.value).toBe('Imported Value')
    expect(latest.source).toBe('import')

    // A NON-accept resolution (default) stays human.
    handlers.resolveConflict({
      token, entity: 'groups', entity_id: gid, field: 'name',
      chosen_op_id: humanOp.id, parent_op_id: latest.id,
    })
    latest = latestOp(db, 'groups', gid, 'name')
    expect(latest.value).toBe('Hand Edited')
    expect(latest.source).toBe('human')
  })
})

describe('listPendingPairingRequests handler (devices.read, staff+admin)', () => {
  it('requires a token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.listPendingPairingRequests({})).toThrow('token is required')
  })

  it('returns pending devices for a staff user', async () => {
    await seedCampAndUser({ name: 'StaffLister', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7400 })
    const { token: staffToken } = await handlers.login({ name: 'StaffLister', pin: '1234' })

    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run('pending-device-1', 'iPad')

    const result = handlers.listPendingPairingRequests({ token: staffToken })
    const found = result.find((d) => d.id === 'pending-device-1')
    expect(found).toBeTruthy()
    expect(found.name).toBe('iPad')
  })

  it('does not return already-authorized or revoked devices', async () => {
    await seedCampAndUser({ name: 'AdminLister', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7401 })
    const { token: adminToken } = await handlers.login({ name: 'AdminLister', pin: '1234' })

    db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at) VALUES (?, ?, 'authorized', ?)").run('authorized-device', 'Laptop', new Date().toISOString())
    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run('pending-device-2', 'Phone')

    const result = handlers.listPendingPairingRequests({ token: adminToken })
    expect(result.find((d) => d.id === 'authorized-device')).toBeUndefined()
    expect(result.find((d) => d.id === 'pending-device-2')).toBeTruthy()
  })
})

describe('listDevices handler (devices.read, staff+admin)', () => {
  it('requires a token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.listDevices({})).toThrow('token is required')
  })

  it('returns all devices including authorized and pending', async () => {
    await seedCampAndUser({ name: 'DeviceLister', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7402 })
    const { token: adminToken } = await handlers.login({ name: 'DeviceLister', pin: '1234' })

    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run('ld-pending', 'Tablet')

    const result = handlers.listDevices({ token: adminToken })
    expect(result.find((d) => d.id === 'ld-pending')).toBeTruthy()
    // The host device itself (deviceId) should also appear
    expect(result.find((d) => d.id === deviceId)).toBeTruthy()
  })

  it('omits pairing_status=\'unknown\' stub rows (T85 Risk 3a: op-log FK-seed phantoms) while keeping real paired devices', async () => {
    await seedCampAndUser({ name: 'DeviceLister2', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7403 })
    const { token: adminToken } = await handlers.login({ name: 'DeviceLister2', pin: '1234' })

    db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at) VALUES (?, ?, 'authorized', ?)").run('ld-real-paired', 'Real Laptop', new Date().toISOString())
    // Same shape the op-log FK stub-seed leaves behind for a device this one
    // has only ever HEARD an op from — never paired with it directly.
    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'unknown')").run('ld-stub-unknown', 'Device ld-stub-')

    const result = handlers.listDevices({ token: adminToken })
    expect(result.find((d) => d.id === 'ld-real-paired')).toBeTruthy()
    expect(result.find((d) => d.id === 'ld-stub-unknown')).toBeUndefined()
  })
})

describe('approveDevice handler (devices.approve, admin-only)', () => {
  it('requires a token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.approveDevice({ deviceId: 'some-device' })).toThrow('token is required')
  })

  it('rejects a staff-role caller', async () => {
    await seedCampAndUser({ name: 'StaffApprover', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7403 })
    const { token: staffToken } = await handlers.login({ name: 'StaffApprover', pin: '1234' })

    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run('approve-target-1', 'iPad')

    expect(() => handlers.approveDevice({ token: staffToken, deviceId: 'approve-target-1' })).toThrow()
  })

  it('authorizes a pending device for an admin caller, minting device_secret_identifier', async () => {
    await seedCampAndUser({ name: 'AdminApprover', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7404 })
    const { token: adminToken } = await handlers.login({ name: 'AdminApprover', pin: '1234' })

    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run('approve-target-2', 'Laptop')

    const result = handlers.approveDevice({ token: adminToken, deviceId: 'approve-target-2' })
    expect(result).toEqual({ deviceId: 'approve-target-2', authorized: true })

    const row = db.prepare('SELECT authorized_at, pairing_status, device_secret_identifier FROM devices WHERE id = ?').get('approve-target-2')
    expect(row.authorized_at).toEqual(expect.any(String))
    expect(row.pairing_status).toBe('authorized')
    expect(row.device_secret_identifier).toEqual(expect.any(String))
  })

  it('rejects a nonexistent deviceId', async () => {
    await seedCampAndUser({ name: 'AdminApprover2', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7405 })
    const { token: adminToken } = await handlers.login({ name: 'AdminApprover2', pin: '1234' })

    expect(() => handlers.approveDevice({ token: adminToken, deviceId: 'does-not-exist' })).toThrow('device not found')
  })
})

describe('denyDevice handler (devices.approve, admin-only)', () => {
  it('requires a token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.denyDevice({ deviceId: 'some-device' })).toThrow('token is required')
  })

  it('rejects a staff-role caller', async () => {
    await seedCampAndUser({ name: 'StaffDenier', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7406 })
    const { token: staffToken } = await handlers.login({ name: 'StaffDenier', pin: '1234' })

    expect(() => handlers.denyDevice({ token: staffToken, deviceId: 'some-device' })).toThrow()
  })

  it('returns denied=true for an admin caller', async () => {
    await seedCampAndUser({ name: 'AdminDenier', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7407 })
    const { token: adminToken } = await handlers.login({ name: 'AdminDenier', pin: '1234' })

    const result = handlers.denyDevice({ token: adminToken, deviceId: 'deny-target' })
    expect(result).toEqual({ deviceId: 'deny-target', denied: true })
  })
})

describe('revokeDevice handler (devices.revoke, admin-only)', () => {
  it('requires a token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.revokeDevice({ deviceId: 'some-device' })).toThrow('token is required')
  })

  it('rejects a staff-role caller', async () => {
    await seedCampAndUser({ name: 'StaffRevoker', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7408 })
    const { token: staffToken } = await handlers.login({ name: 'StaffRevoker', pin: '1234' })

    db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at) VALUES (?, ?, 'authorized', ?)").run('revoke-target-1', 'Tablet', new Date().toISOString())

    expect(() => handlers.revokeDevice({ token: staffToken, deviceId: 'revoke-target-1' })).toThrow()
  })

  it('revokes a device and stamps revoked_at for an admin caller', async () => {
    await seedCampAndUser({ name: 'AdminRevoker', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7409 })
    const { token: adminToken } = await handlers.login({ name: 'AdminRevoker', pin: '1234' })

    db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at) VALUES (?, ?, 'authorized', ?)").run('revoke-target-2', 'MacBook', new Date().toISOString())

    const result = handlers.revokeDevice({ token: adminToken, deviceId: 'revoke-target-2', reason: 'lost' })
    expect(result).toEqual({ deviceId: 'revoke-target-2', revoked: true })

    const row = db.prepare('SELECT revoked_at, revocation_reason, pairing_status FROM devices WHERE id = ?').get('revoke-target-2')
    expect(row.revoked_at).toEqual(expect.any(String))
    expect(row.revocation_reason).toBe('lost')
    expect(row.pairing_status).toBe('revoked')
  })

  it('rejects a nonexistent deviceId', async () => {
    await seedCampAndUser({ name: 'AdminRevoker2', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7410 })
    const { token: adminToken } = await handlers.login({ name: 'AdminRevoker2', pin: '1234' })

    expect(() => handlers.revokeDevice({ token: adminToken, deviceId: 'no-such-device' })).toThrow('device not found')
  })

  it('iterates syncServer.wss.clients and calls close(4404) on the revoked device\'s socket', async () => {
    await seedCampAndUser({ name: 'AdminRevokerWS', pin: '1234', role: 'admin' })
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7411 })
    const { token: adminToken } = await handlers.login({ name: 'AdminRevokerWS', pin: '1234' })

    const remoteDeviceId = randomUUID()
    db.prepare(
      "INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES (?, ?, ?, ?, 'authorized')"
    ).run(remoteDeviceId, 'Remote Device', new Date().toISOString(), randomBytes(32).toString('hex'))

    // Simulate a fake WS client in fakeSyncServer.wss.clients with that deviceId
    const fakeClose = vi.fn()
    const fakeClient = { deviceId: remoteDeviceId, close: fakeClose }
    fakeSyncServer.wss.clients.add(fakeClient)

    handlers.revokeDevice({ token: adminToken, deviceId: remoteDeviceId })

    expect(fakeClose).toHaveBeenCalledWith(4404, 'device_revoked')

    fakeSyncServer.wss.clients.delete(fakeClient)
  })
})

// T61 — the handler-level half of "Replace runs in one main-process
// transaction". The data guarantees live in electron/ops/ingest.test.js; what
// is on trial here is the gate in front of them: admin only, Host only, and
// that `mode` actually reaches commitIngest without colliding with the
// closure's device-mode variable of the same name.
// docs/work/specs/S-replace-ingest-atomic-transaction.md
describe('ingestCommit: who may import, and from where', () => {
  async function adminToken(handlers) {
    await seedCampAndUser({ name: 'Ruth', pin: '4321', role: 'admin' })
    const { token } = await handlers.login({ name: 'Ruth', pin: '4321' })
    return token
  }

  it('refuses a staff token before a single row is touched', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await seedCampAndUser({ name: 'Alice', pin: '1234', role: 'staff' })
    const { token } = await handlers.login({ name: 'Alice', pin: '1234' })
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)')
      .run(randomUUID(), db.prepare('SELECT id FROM camps LIMIT 1').get().id, 'Swim')

    expect(() => handlers.ingestCommit({ token, mode: 'replace', approved: { activities: ['Archery'] } }))
      .toThrow(/admin role required/i)

    // 'groups.import' is absent from the staff permission list, so the refusal
    // comes from default-deny — and it comes before the transaction opens.
    expect(db.prepare('SELECT COUNT(*) c FROM activities').get().c).toBe(1)
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE field = '__deleted__'").get().c).toBe(0)
  })

  it('refuses a Replace on a device in Client mode, and writes nothing', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const token = await adminToken(handlers)
    const campIdHere = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campIdHere, 'Swim')
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    // commitIngest appends straight to THIS device's sqlite; on a Client the
    // Host would never see it and the camp would silently fork.
    expect(() => handlers.ingestCommit({ token, mode: 'replace', approved: { activities: ['Archery'] } }))
      .toThrow('Replace can only be run on the main computer.')

    expect(db.prepare('SELECT COUNT(*) c FROM activities').get().c).toBe(1)
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'activities' AND field = '__deleted__'").get().c).toBe(0)
  })

  it('refuses an Add on a device in Client mode too, with its own wording', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const token = await adminToken(handlers)
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    expect(() => handlers.ingestCommit({ token, approved: { activities: ['Archery'] } }))
      .toThrow('Import can only be run on the main computer.')
    expect(db.prepare('SELECT COUNT(*) c FROM activities').get().c).toBe(0)
  })

  it('runs a Replace on the Host, clearing the old setup and creating the new', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7191 })
    const token = await adminToken(handlers)
    const campIdHere = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campIdHere, 'Swim')

    const result = handlers.ingestCommit({ token, mode: 'replace', approved: { activities: ['Archery'] } })

    expect(result.replaced.entities.activities).toBe(1)
    expect(db.prepare('SELECT name FROM activities').all().map((r) => r.name)).toEqual(['Archery'])
  })

  it('leaves the camp alone when no mode is given — the device mode is not mistaken for the import mode', async () => {
    // The handler's `mode` parameter and the closure's device `mode` share a
    // name; the parameter is renamed on the way in so this cannot regress into
    // "we are the Host, therefore replace".
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7192 })
    const token = await adminToken(handlers)
    const campIdHere = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campIdHere, 'Swim')

    const result = handlers.ingestCommit({ token, approved: { activities: ['Archery'] } })

    expect(result.replaced).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) c FROM activities').get().c).toBe(2)
  })
})

describe('confirmAlias handler: who may confirm, and from where (S1b)', () => {
  async function adminToken(handlers) {
    await seedCampAndUser({ name: 'Ruth', pin: '4321', role: 'admin' })
    const { token } = await handlers.login({ name: 'Ruth', pin: '4321' })
    return token
  }

  function makeGroup(campIdHere, name) {
    const id = randomUUID()
    db.prepare('INSERT INTO groups (id, camp_id, name, availability) VALUES (?, ?, ?, ?)').run(id, campIdHere, name, 'all')
    return id
  }

  it('refuses a staff token, and writes no alias row', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7301 })
    await seedCampAndUser({ name: 'Alice', pin: '1234', role: 'staff' })
    const { token } = await handlers.login({ name: 'Alice', pin: '1234' })
    const campIdHere = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    const groupId = makeGroup(campIdHere, 'Bunk One')

    expect(() =>
      handlers.confirmAlias({ token, entity_type: 'groups', source_label: 'Cabin 1', entity_id: groupId })
    ).toThrow(/admin role required/i)
    expect(db.prepare('SELECT COUNT(*) c FROM source_aliases').get().c).toBe(0)
  })

  it('refuses a device in Client mode', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    const token = await adminToken(handlers)
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    expect(() =>
      handlers.confirmAlias({ token, entity_type: 'groups', source_label: 'Cabin 1', entity_id: 'g1' })
    ).toThrow('Confirming an import match can only be done on the main computer.')
    expect(db.prepare('SELECT COUNT(*) c FROM source_aliases').get().c).toBe(0)
  })

  it('rejects an invalid entity_type before any DB access, for an admin session too', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7302 })
    const token = await adminToken(handlers)

    expect(() =>
      handlers.confirmAlias({ token, entity_type: 'template_slots', source_label: 'x', entity_id: 'whatever' })
    ).toThrow()
    expect(db.prepare('SELECT COUNT(*) c FROM source_aliases').get().c).toBe(0)
  })

  it('lets an admin on the Host confirm an alias', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7303 })
    const token = await adminToken(handlers)
    const campIdHere = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    const groupId = makeGroup(campIdHere, 'Bunk One')

    const result = handlers.confirmAlias({ token, entity_type: 'groups', source_label: 'Cabin 1', entity_id: groupId })

    expect(result.id).toBeTruthy()
    expect(db.prepare("SELECT entity_id FROM source_aliases WHERE status = 'active'").get().entity_id).toBe(groupId)
  })

  it('refuses a confirm onto a locked activity, surfacing rather than silently binding', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7304 })
    const token = await adminToken(handlers)
    const campIdHere = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    const activityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, is_locked) VALUES (?, ?, ?, 1)').run(activityId, campIdHere, 'Swim')

    expect(() =>
      handlers.confirmAlias({ token, entity_type: 'activities', source_label: 'Swimming', entity_id: activityId })
    ).toThrow()
    expect(db.prepare('SELECT COUNT(*) c FROM source_aliases').get().c).toBe(0)
  })
})

describe('the generic write() path refuses source_aliases (S1b)', () => {
  it('throws rather than silently no-opping', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7305 })
    const { user } = await seedCampAndUser({ name: 'AdminWriter', pin: '9999', role: 'admin' })
    const { token } = await handlers.login({ name: 'AdminWriter', pin: '9999' })
    void user

    await expect(
      handlers.write({ token, entity: 'source_aliases', entity_id: 'a1', field: 'status', value: 'active' })
    ).rejects.toThrow(/source_aliases/)
    expect(db.prepare('SELECT COUNT(*) c FROM source_aliases').get().c).toBe(0)
  })
})

// docs/adr/2026-08-15-locations-merge-and-delete-rehome.md (M3c)
describe('mergeLocation handler (locations.delete, admin-only)', () => {
  async function staffToken(handlers) {
    await seedCampAndUser({ name: 'StaffMerge', pin: '1234', role: 'staff' })
    const { token } = await handlers.login({ name: 'StaffMerge', pin: '1234' })
    return token
  }
  async function adminToken(handlers) {
    await seedCampAndUser({ name: 'AdminMerge', pin: '4321', role: 'admin' })
    const { token } = await handlers.login({ name: 'AdminMerge', pin: '4321' })
    return token
  }

  it('rejects with no token', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await expect(handlers.mergeLocation({ loser_id: 'a', winner_id: 'b' })).rejects.toThrow('token is required')
  })

  it('refuses a staff token — merging deletes the loser, same gate deleteRecord uses', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7401 })
    const token = await staffToken(handlers)

    await expect(handlers.mergeLocation({ token, loser_id: 'loc-a', winner_id: 'loc-b' })).rejects.toThrow(
      /admin role required/i
    )
  })

  it('lets an admin on the Host merge two locations, re-pointing activities and deleting the loser', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7402 })
    const token = await adminToken(handlers)
    const campIdHere = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    const winnerId = randomUUID()
    const loserId = randomUUID()
    db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, ?)').run(winnerId, campIdHere, 'Pool', 3)
    db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, ?)').run(loserId, campIdHere, 'pool', 1)
    const activityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id) VALUES (?, ?, ?, ?)').run(
      activityId,
      campIdHere,
      'Swim',
      loserId
    )

    const result = await handlers.mergeLocation({
      token,
      loser_id: loserId,
      winner_id: winnerId,
      winner_capacity: 3,
      expected_ref_count: 1,
    })

    expect(result.ok).toBe(true)
    expect(result.reassigned_activity_ids).toEqual([activityId])
    expect(db.prepare('SELECT location_id FROM activities WHERE id = ?').get(activityId).location_id).toBe(winnerId)
    expect(db.prepare('SELECT 1 FROM locations WHERE id = ?').get(loserId)).toBeFalsy()
  })

  // Security finding (round 2): the WS path's validateMergeLocationRequestMsg
  // type-checks winner_capacity/expected_ref_count (Number.isInteger or
  // null/undefined); the IPC path did not, so the two entry points could
  // drift on what shape they accept. Not exploitable today (the IPC caller
  // is the trusted renderer), but closing the asymmetry keeps a future bug
  // in one surface from silently not existing on the other.
  it('rejects a non-integer winner_capacity, mirroring the WS validator', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7403 })
    const token = await adminToken(handlers)

    await expect(
      handlers.mergeLocation({ token, loser_id: 'loc-a', winner_id: 'loc-b', winner_capacity: 'three' })
    ).rejects.toThrow(/winner_capacity/i)
  })

  it('rejects a non-integer expected_ref_count, mirroring the WS validator', async () => {
    const handlers = makeHandlers(db, deviceId, {})
    await handlers.chooseMode({ mode: 'host', campName: 'Camp Test', port: 7404 })
    const token = await adminToken(handlers)

    await expect(
      handlers.mergeLocation({ token, loser_id: 'loc-a', winner_id: 'loc-b', expected_ref_count: 'two' })
    ).rejects.toThrow(/expected_ref_count/i)
  })
})

// docs/adr/2026-08-15-locations-merge-and-delete-rehome.md D3/D4 (M3c) —
// these two are LOCAL-ONLY: gated like every other IPC, but never routed to
// the Host and never emit an op, regardless of device mode.
describe('listMigrationReviews / dismissMigrationReviews handlers — local-only, never reach the Host', () => {
  it('listMigrationReviews rejects with no token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.listMigrationReviews(undefined)).toThrow('token is required')
  })

  it('dismissMigrationReviews rejects with no token', () => {
    const handlers = makeHandlers(db, deviceId, {})
    expect(() => handlers.dismissMigrationReviews({ ids: ['r1'] })).toThrow('token is required')
  })

  it('allows a staff session to read the journal (locations.read)', async () => {
    await seedCampAndUser({ name: 'StaffJournal', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = await handlers.login({ name: 'StaffJournal', pin: '1234' })
    expect(() => handlers.listMigrationReviews(token)).not.toThrow()
  })

  it('allows a staff session to dismiss a review (locations.write)', async () => {
    await seedCampAndUser({ name: 'StaffDismiss', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = await handlers.login({ name: 'StaffDismiss', pin: '1234' })
    expect(() => handlers.dismissMigrationReviews({ token, ids: ['r1'] })).not.toThrow()
  })

  it('reads and dismisses even in Client mode, synchronously — never a WS round trip, never an op', async () => {
    await seedCampAndUser({ name: 'ClientJournal', pin: '1234', role: 'staff' })
    const handlers = makeHandlers(db, deviceId, {})
    const { token } = await handlers.login({ name: 'ClientJournal', pin: '1234' })
    await handlers.chooseMode({ mode: 'client', hostAddress: 'ws://192.168.1.5:7100' })

    const campIdHere = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    const locationId = randomUUID()
    db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, ?)').run(locationId, campIdHere, 'Gym', 1)
    db.prepare(
      `INSERT INTO location_migration_reviews (id, camp_id, location_id, name, kind, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('review-1', campIdHere, locationId, 'Gym', 'was_unlimited', JSON.stringify({ seededCapacity: 1 }), new Date().toISOString())

    // Both handlers are plain synchronous functions (unlike previewDelete/
    // deleteRecord's client branch, which awaits a WS round trip) — calling
    // them with no `await` and getting the real, immediate answer back is
    // itself the proof they never reached out to the Host.
    const rows = handlers.listMigrationReviews(token)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('review-1')

    const beforeOps = db.prepare('SELECT COUNT(*) n FROM operations').get().n
    const dismissed = handlers.dismissMigrationReviews({ token, ids: ['review-1'] })
    expect(dismissed).toEqual({ ok: true, dismissed: 1 })
    expect(db.prepare('SELECT COUNT(*) n FROM operations').get().n).toBe(beforeOps)
    expect(db.prepare('SELECT 1 FROM location_migration_reviews WHERE id = ?').get('review-1')).toBeFalsy()
  })
})
