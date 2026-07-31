/**
 * Integration test harness for Shoresh LAN-sync.
 *
 * Runs Host (syncServer + SQLite) and Client (syncClient + SQLite) in the
 * same Node process using separate DB files, so the real WS handshake,
 * auth, op-log, conflict, and watermark paths all execute.  Process-restart
 * is simulated by closing and re-opening the DB + syncClient.
 *
 * No Electron APIs are used anywhere in the call chain.
 */

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'

import { openLocalDb, getOrCreateDeviceId } from '../../electron/db/localDb.js'
import { startSyncServer } from '../../electron/sync/syncServer.js'
import { createSyncClient } from '../../electron/sync/syncClient.js'
import {
  createUser,
  issueCampToken,
  ensureHostSigningKey,
} from '../../electron/auth/localAuth.js'
import { insertPendingWrite } from '../../electron/sync/pendingWrites.js'
import { listPendingRestores } from '../../electron/sync/pendingRestores.js'

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Find a free TCP port on 127.0.0.1. */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/** Create a unique temp directory for one test's DB files. */
export function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-int-'))
}

/** Remove a list of temp directories created by makeTmpDir. */
export function cleanupDirs(dirs) {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/**
 * Poll predicate() (sync or async) until it returns truthy or timeout
 * expires. Resolves on first truthy result, rejects on timeout.
 */
export function waitFor(predicate, timeoutMs = 6000, pollMs = 40) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    async function tick() {
      try {
        if (await predicate()) { resolve(); return }
      } catch { /* keep polling */ }
      if (Date.now() >= deadline) {
        reject(new Error(`waitFor timeout after ${timeoutMs}ms`))
        return
      }
      setTimeout(tick, pollMs)
    }
    tick()
  })
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/**
 * Wraps a syncServer + SQLite DB pair.
 * One Host per test scenario; close() it after the scenario finishes.
 */
export class Host {
  constructor(dbPath) {
    this.dbPath = dbPath
    this.db = null
    this.server = null     // { wss, close, sendPairingApproved, sendPairingDenied }
    this.port = null
    this.serverUrl = null
    this.deviceId = null
    this.campId = null
    this.adminUserId = null
    this.adminToken = null
    this._pairingQueue = []
    this._pairingWaiters = []
  }

  /** Open the DB and start the WS server on `port`. */
  async start(port) {
    this.db = openLocalDb(this.dbPath)
    this.deviceId = getOrCreateDeviceId(this.db)
    // Ensure a devices row so the host can authorize itself later.
    this.db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(
      this.deviceId, 'Host'
    )
    this.server = startSyncServer(this.db, {
      port,
      onPairingRequest: (deviceId, deviceName) => {
        const waiter = this._pairingWaiters.shift()
        if (waiter) waiter({ deviceId, deviceName })
        else this._pairingQueue.push({ deviceId, deviceName })
      },
    })
    this.port = port
    this.serverUrl = `ws://127.0.0.1:${port}`
  }

  /**
   * Bootstrap a fresh camp: creates the camp row, admin user, host signing
   * key, and self-authorizes the host device.  Returns the admin token.
   */
  async bootstrap({ campName = 'TestCamp', adminName = 'admin', adminPin = '1234' } = {}) {
    const campId = randomUUID()
    const signingSecret = randomBytes(32).toString('hex')
    this.db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(
      campId, campName, signingSecret
    )
    const hostKey = ensureHostSigningKey(this.db)
    this.db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(
      hostKey.public_key, campId
    )

    // Create the admin user through a no-network sync client (writes directly
    // to this DB via appendOp — same path main.js uses during bootstrapCamp).
    const localClient = createSyncClient(this.db, {
      device_id: this.deviceId,
      author_user_id: null,
    })
    const user = await createUser(
      this.db,
      { camp_id: campId, name: adminName, pin: adminPin, role: 'admin' },
      (args) => localClient.write(args)
    )

    // Self-authorize the host device.
    this.db.prepare(
      "UPDATE devices SET authorized_at = ?, authorized_by_user_id = ?, pairing_status = 'authorized' WHERE id = ?"
    ).run(new Date().toISOString(), user.id, this.deviceId)

    // Mirrors electron/main.js's bootstrapCamp: a Host trivially has 100% of
    // its own data from the instant of its own bootstrap and must never be
    // gated by the first-sync write-gate (T7 fix, design doc Part 4.1).
    this.db.prepare(
      'UPDATE device_identity SET first_sync_completed_at = COALESCE(first_sync_completed_at, ?)'
    ).run(new Date().toISOString())

    this.campId = campId
    this.adminUserId = user.id
    this.adminToken = issueCampToken(this.db, user.id, this.deviceId)
    return { campId, userId: user.id, token: this.adminToken }
  }

  /**
   * Wait for the next pairing_request to arrive (from any client device).
   * Returns { deviceId, deviceName } or throws on timeout.
   */
  waitForPairingRequest(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      // Already queued?
      if (this._pairingQueue.length > 0) {
        resolve(this._pairingQueue.shift())
        return
      }
      const timer = setTimeout(() => {
        const idx = this._pairingWaiters.indexOf(handler)
        if (idx !== -1) this._pairingWaiters.splice(idx, 1)
        reject(new Error('timeout waiting for pairing_request'))
      }, timeoutMs)
      const handler = (data) => { clearTimeout(timer); resolve(data) }
      this._pairingWaiters.push(handler)
    })
  }

  /**
   * Approve a pending device: generates a secret, writes it to the DB, and
   * sends pairing_approved over the open WS connection (if any).
   * Returns the secret so tests can verify the client stored it.
   */
  approveDevice(deviceId) {
    const secret = randomBytes(32).toString('hex')
    const now = new Date().toISOString()
    this.db.prepare(
      "UPDATE devices SET authorized_at = ?, authorized_by_user_id = ?, pairing_status = 'authorized', device_secret_identifier = ?, revoked_at = NULL WHERE id = ?"
    ).run(now, this.adminUserId, secret, deviceId)
    this.server.sendPairingApproved(deviceId, secret)
    return secret
  }

  /** Revoke a device so it gets 4404 on next authenticate. */
  revokeDevice(deviceId) {
    this.db.prepare(
      "UPDATE devices SET revoked_at = ?, revocation_reason = 'test' WHERE id = ?"
    ).run(new Date().toISOString(), deviceId)
  }

  /** Read all operations from the host DB, ordered by seq. */
  getOps() {
    return this.db.prepare('SELECT * FROM operations ORDER BY seq').all()
  }

  /** Read all unresolved conflicts from the host DB. */
  getConflicts() {
    return this.db.prepare('SELECT * FROM conflicts WHERE resolved_at IS NULL').all()
  }

  /** Count ops for a specific entity/field combination. */
  countOps(entity, entityId, field) {
    return this.db.prepare(
      'SELECT COUNT(*) as n FROM operations WHERE entity = ? AND entity_id = ? AND field = ?'
    ).get(entity, entityId, field).n
  }

  /**
   * T7 fix: reads device_identity.first_sync_completed_at directly — the
   * real IPC surface (electron/main.js's hasCompletedInitialSync handler) is
   * slice 2 of this fix, so tests read the underlying flag straight from the
   * DB, matching this file's existing dbExec-style test-only access pattern.
   */
  hasCompletedInitialSync() {
    const row = this.db.prepare('SELECT first_sync_completed_at FROM device_identity LIMIT 1').get()
    return !!(row && row.first_sync_completed_at)
  }

  /**
   * Execute raw SQL on the Host DB.  TEST-ONLY — not a real IPC surface.
   * Use for test setup and teardown that cannot go through the WS protocol
   * (e.g. mutating user roles without re-login, or injecting seed data).
   * Never call this from production code paths.
   */
  dbExec(sql, params = []) {
    if (!this.db) throw new Error('Host DB is not open')
    return this.db.prepare(sql).run(...params)
  }

  /** Simulate the host process crashing: close WS server and DB abruptly. */
  kill() {
    try { this.server?.close() } catch { /* ignore */ }
    try { this.db?.close() } catch { /* ignore */ }
    this.server = null
    this.db = null
  }

  /** Graceful shutdown. */
  close() { this.kill() }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Wraps a syncClient + SQLite DB pair.
 * Multiple clients can connect to the same Host.
 */
export class Client {
  constructor(dbPath) {
    this.dbPath = dbPath
    this.db = null
    this.syncClient = null
    this.deviceId = null
    this.token = null
    this.serverUrl = null
  }

  /** Open (or reopen) the SQLite DB.  Safe to call after kill(). */
  open() {
    this.db = openLocalDb(this.dbPath)
    this.deviceId = getOrCreateDeviceId(this.db)
    this.db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(
      this.deviceId, `Client-${this.deviceId.slice(0, 8)}`
    )
  }

  /**
   * Create a syncClient and connect to the server.
   * If a token is stored (from a previous loginRemote) it sends authenticate
   * immediately; otherwise it sends pairing_request so the Host can approve.
   */
  async connect(serverUrl) {
    this.serverUrl = serverUrl
    if (this.syncClient) { this.syncClient.close(); this.syncClient = null }

    this.syncClient = createSyncClient(this.db, {
      device_id: this.deviceId,
      author_user_id: null,
      serverUrl,
      token: this.token || undefined,
      device_name: `TestClient-${this.deviceId.slice(0, 8)}`,
    })
    await this.syncClient.waitUntilConnected()
  }

  /**
   * Wait for the pairing_approved event to fire on this client.
   * Must be called BEFORE approveDevice() on the Host, or immediately after,
   * since the event fires shortly after sendPairingApproved.
   */
  waitForPairingApproved(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for pairing_approved')), timeoutMs)
      this.syncClient.onPairingApproved(() => { clearTimeout(timer); resolve() })
    })
  }

  /** Login over the WS — returns { status, token, userId, role }. */
  async loginRemote(name, pin) {
    const result = await this.syncClient.loginRemote({ name, pin })
    if (result.status === 'ok') {
      this.token = result.token
      return result
    }
    throw new Error(`loginRemote failed: ${JSON.stringify(result)}`)
  }

  /** Write an op through the sync client. */
  write(op) { return this.syncClient.write(op) }

  /** Flush the durable pending-write queue. */
  flushQueue() { return this.syncClient.flushQueue() }

  /** Ask the Host to restore a deleted record (or queue the request). */
  requestRestore(args) { return this.syncClient.requestRestore(args) }

  /** Ask the Host to delete a record a schedule uses. Never queued — see
   *  docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md. */
  requestDelete(args) { return this.syncClient.requestDelete(args) }

  /** Restore requests recorded on this device but not yet delivered. */
  getPendingRestores() { return listPendingRestores(this.db) }

  /** Read all operations from the client DB, ordered by seq. */
  getOps() {
    return this.db.prepare('SELECT * FROM operations ORDER BY seq').all()
  }

  /** Read all unresolved conflicts from the client DB. */
  getConflicts() {
    return this.db.prepare('SELECT * FROM conflicts WHERE resolved_at IS NULL').all()
  }

  /** T7 fix: reads device_identity.first_sync_completed_at directly (see Host's own copy above). */
  hasCompletedInitialSync() {
    const row = this.db.prepare('SELECT first_sync_completed_at FROM device_identity LIMIT 1').get()
    return !!(row && row.first_sync_completed_at)
  }

  /**
   * Close the WS connection without destroying the syncClient or the DB.
   * Writes made after disconnect() are queued in pending_writes.
   */
  disconnect() {
    if (this.syncClient) {
      const ws = this.syncClient.__getWs()
      if (ws) {
        try { ws.close() } catch { /* ignore */ }
      }
    }
  }

  /**
   * Reconnect: close the current syncClient and open a new one with the
   * stored token.  Loads any pending_writes from the DB so flushQueue() will
   * pick them up.
   */
  async reconnect() {
    if (this.syncClient) { this.syncClient.close(); this.syncClient = null }
    await this.connect(this.serverUrl)
  }

  /**
   * Simulate a process restart: close the DB + syncClient, then reopen and
   * reconnect.  pending_writes survive because they live in the DB file.
   */
  async restart() {
    if (this.syncClient) { this.syncClient.close(); this.syncClient = null }
    if (this.db) { try { this.db.close() } catch { /* ignore */ } this.db = null }
    this.open()
    await this.connect(this.serverUrl)
  }

  /**
   * Inject a pending write directly into the pending_writes table without
   * going through syncClient.write().  Useful for simulating a write that was
   * queued before a crash without depending on WS-close timing.
   */
  injectPendingWrite({ entity, entity_id, field, value, parent_op_id = null }) {
    const pendingId = randomUUID()
    const client_write_id = randomUUID()
    insertPendingWrite(this.db, { pendingId, client_write_id, entity, entity_id, field, value, parent_op_id })
    return { pendingId, client_write_id }
  }

  /** Close the DB (simulate process exit without reconnect). */
  closeDb() {
    if (this.syncClient) { this.syncClient.close(); this.syncClient = null }
    if (this.db) { try { this.db.close() } catch { /* ignore */ } this.db = null }
  }

  /**
   * Ensure that a devices row exists in this client's local DB for the given
   * device.  Needed when ops authored by that device will be received via
   * sendMissedOps: the operations table has a FK on device_id and FK
   * enforcement is ON, so a received op whose device_id is not in the local
   * devices table will fail to insert.  In production the full_sync path
   * would need to ship devices as well; for the harness we register them
   * manually.
   */
  registerDevice(deviceId, name = 'Remote') {
    this.db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(deviceId, name)
  }

  /**
   * Send a raw JSON object over the underlying WS connection. Test-only.
   * Use this to inject malformed or out-of-protocol messages for negative tests.
   */
  sendRawMessage(payload) {
    const ws = this.syncClient.__getWs()
    if (!ws) throw new Error('No WS connection')
    ws.send(JSON.stringify(payload))
  }

  /** Full teardown. */
  close() { this.closeDb() }
}

// ---------------------------------------------------------------------------
// Pairing helper
// ---------------------------------------------------------------------------

/**
 * Full pair-and-login flow for a freshly constructed Client that has not yet
 * been connected.  The caller must have already called client.open().
 *
 * Sequence:
 *   1. client.connect(host.serverUrl)     → sends pairing_request
 *   2. host.waitForPairingRequest()
 *   3. host.approveDevice(deviceId)       → sends pairing_approved
 *   4. client waits for pairing_approved  → stores device_secret_identifier
 *   5. client.loginRemote(name, pin)      → authenticates
 *
 * Returns the loginRemote result { status, token, userId, role }.
 */
export async function pairAndLogin(host, client, name = 'admin', pin = '1234') {
  // 1. Start connect (sends pairing_request on WS open)
  const connectPromise = client.connect(host.serverUrl)
  // 2. Wait for the pairing_request to arrive at the host
  const { deviceId } = await host.waitForPairingRequest()
  // 3. Register the approved-listener BEFORE sendPairingApproved fires the event
  const approvedPromise = client.waitForPairingApproved()
  // 4. Approve — sends pairing_approved over the WS
  host.approveDevice(deviceId)
  await approvedPromise
  await connectPromise
  // 5. Login
  const loginResult = await client.loginRemote(name, pin)

  // loginRemote() sends `authenticate` on the wire and returns immediately
  // (the server sends no explicit ack for authenticate per the syncClient
  // comments).  Give the server's event loop a moment to process the
  // `authenticate` message and set ws.deviceId so subsequent broadcasts
  // from other clients reach this WS.  Without this, a write by another
  // client immediately after pairAndLogin completes may be broadcast before
  // the server has processed this client's authenticate, causing the
  // broadcast to be skipped (the server only broadcasts to WSes with
  // deviceId set).
  await new Promise(r => setTimeout(r, 100))

  return loginResult
}
