/**
 * Integration test harness for Shoresh's Automerge/libp2p sync engine
 * (Stage 6a, docs/work/plans/2026-09-07-stage6-cutover-plan.md).
 *
 * Mirrors harness.js's Host/Client shape (start/bootstrap/pairAndLogin/write/
 * disconnect/reconnect/close) so scenario bodies can stay close to their
 * WS-transport originals, but the transport underneath is real libp2p
 * in-process nodes (startSyncNode) and real Automerge documents — no mocks.
 *
 * IDENTITY IS REAL HERE. An earlier revision of this file asserted as an
 * "ARCHITECTURAL FACT" that `camps` and `users` are never modeled in the
 * Automerge document, and retired several scenarios on that basis. #325 made
 * that false for `users` (they now replicate through the document), and the
 * Stage 6 join flow made it false a second way: a joining device gets its
 * `camps` row from the authenticated `login_ok` reply
 * (docs/adr/2026-09-08-libp2p-join-flow.md §3.1), because
 * `PROJECTIONS.camps.ensureExists` only ever matches or refuses, never creates.
 *
 * The practical consequence is the point of this rewrite: there is no
 * `seedCampIdentity` any more. A Client here joins the way a real second device
 * does — types the code the Host is showing, gets approved by the "director",
 * signs in with a PIN, and receives its identity and the camp's data over
 * libp2p. Nothing about its starting state is faked, so a scenario that passes
 * here is evidence about the product rather than about the harness.
 *
 * `devices` remains genuinely device-local infrastructure and is never a
 * document field (electron/automerge/hostOnlyExclusion.test.js).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes, scryptSync } from 'node:crypto'

import { openLocalDb, getOrCreateDeviceId } from '../../electron/db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../electron/automerge/campDocument.js'
import { startSyncNode } from '../../electron/sync/automerge/syncNode.js'
import { startJoinSession } from '../../electron/sync/automerge/joinSession.js'
import { joinCode } from '../../electron/sync/joinCode.js'
import { seedAllFromSqlite } from '../../electron/automerge/seed.js'
import { signAuthFields } from '../../electron/auth/authSignature.js'
import { ensureHostSigningKey, issueDeviceToken } from '../../electron/auth/localAuth.js'
import { saveDoc, loadDoc } from '../../electron/sync/automerge/docStore.js'
import { setUserDataDirGetter, setLocalWriteBroadcaster } from '../../electron/sync/automerge/liveDoc.js'

// Stage 6c: these three lived in harness.js, which was the op-log/WebSocket
// harness and went with that transport. They are transport-agnostic — a temp
// directory and a polling helper — so they move here rather than being lost.

/** A fresh temp directory for one scenario's device databases. */
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
 * Poll predicate() (sync or async) until it returns truthy or timeout expires.
 * Resolves on first truthy result, rejects on timeout.
 *
 * Wait on the FIELD a scenario later asserts on, not a sibling field of the
 * same record: fields arrive across several merges, so waiting on one and then
 * reading another is a race that fails looking like a product bug. That mistake
 * cost three debugging rounds during the port.
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

/** Insert a user row directly (bypassing localAuth.createUser's op-log write
 * callback, which requires 'users' to be a document entity — it is
 * deliberately NOT, see this file's header comment). Hashing mirrors
 * createUser's own so attemptLogin/evaluateLogin verify it identically. */
function insertUser(db, { camp_id, name, pin, role }) {
  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const pin_hash = scryptSync(pin, salt, 64).toString('hex')
  const _hasKey = db.prepare('SELECT 1 FROM host_signing_key WHERE id = 1').get()
  const auth_sig = _hasKey ? signAuthFields(db, { id, role, pin_hash, pin_salt: salt, cred_version: 1 }) : ''
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role, auth_sig, cred_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
  ).run(id, camp_id, name, pin_hash, salt, role, auth_sig)
  return { id, name, role }
}

/**
 * Wraps a startSyncNode + SQLite DB pair acting as the Host: holds the
 * signing key and the `users`/`camps` rows (device-local infrastructure,
 * never replicated — see header comment).
 */
/**
 * Wire the Automerge dual-write, which is what makes DOMAIN operations
 * (deleteRecord, restoreEntity, mergeLocation, ingest, …) reach the document at
 * all. Those go through `appendOp`, and `appendOp` mirrors into the document
 * only via `liveDoc.recordLocalWrite` — which is INERT until a userDataDir is
 * configured, warning once and returning.
 *
 * Production wires this in main.js at startup. A test that forgets it sees
 * every domain operation apply locally and replicate NOTHING, with one easily
 * missed warning line — which is exactly what happened when scenario 20 was
 * first written.
 *
 * The getter is process-global and takes no db, so both nodes in a scenario
 * share one directory. That is fine here and worth knowing why: `startSyncNode`
 * seeds the in-memory registry for each db, so `getDoc` always hits its cache
 * and never reads from disk; the only disk contact is the debounced save, whose
 * file is named by campId. Two nodes in one camp therefore write the same file,
 * which no scenario reads back. Do not build a persistence assertion on it.
 */
export function configureDualWrite(dir) {
  setUserDataDirGetter(() => dir)
}

export class AmHost {
  /**
   * `startSyncNode` lets a caller substitute what builds this device's libp2p
   * node — e.g. one imported from a different installed version of this
   * codebase, for a cross-version compatibility check (a camp's devices do
   * not upgrade together). It must match syncNode.js's `startSyncNode` shape.
   * Left undefined, defaults to this checkout's own — identical to every
   * scenario's behaviour before this seam existed.
   */
  constructor(dbPath, { startSyncNode: startSyncNodeOverride } = {}) {
    this.dbPath = dbPath
    this.db = null
    this.node = null
    this.deviceId = null
    this.campId = null
    this.adminUserId = null
    this.adminToken = null
    this.addingDevices = false
    this._startSyncNode = startSyncNodeOverride || startSyncNode
  }

  async start() {
    this.db = openLocalDb(this.dbPath)
    this.deviceId = getOrCreateDeviceId(this.db)
    this.db.prepare('INSERT OR IGNORE INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, ?)').run(
      this.deviceId, 'Host', new Date().toISOString(), 'authorized'
    )
    // A RESTARTING Host must not start from an empty document. Production seeds
    // from its own SQLite at startup (main.js's ensureAutomergeDocSeeded) before
    // the sync node is handed a doc; starting empty here meant a Host that came
    // back after a crash had forgotten everything it knew, and the only thing
    // standing between that and a wiped camp was projectAll's
    // assertDocIsSupersetOrEmpty guard. A first-run Host has nothing to seed and
    // gets the bare genesis, exactly as before.
    const alreadyBootstrapped = this.db.prepare('SELECT id FROM camps LIMIT 1').get()
    const startingDoc = alreadyBootstrapped
      ? seedAllFromSqlite(this.db, createEmptyDoc())
      : createEmptyDoc()

    this.node = await this._startSyncNode({
      deviceId: this.deviceId,
      db: this.db,
      doc: startingDoc,
      // The director's Add-a-device window (join-flow ADR §2). A Host with it
      // shut turns first-join requests away without troubling the director;
      // bootstrap() opens it, because every scenario models a director who is
      // standing at the machine.
      isJoinWindowOpen: () => this.addingDevices,
      onPairingRequest: (deviceId, deviceName) => {
        const waiter = this._pairingWaiters?.shift()
        if (waiter) waiter({ deviceId, deviceName })
        else (this._pairingQueue ??= []).push({ deviceId, deviceName })
      },
    })
    // Wire the per-device local-write broadcaster exactly as main.js does once
    // its node has started. Without this an appendOp-path write (deleteRecord,
    // ingest, restore) updates this device's document but never PUSHES it, so
    // it reaches a peer only if some other exchange happens to run — which made
    // scenario 30 pass alone and fail after other scenarios. Production wires
    // this; the harness did not, which is the same class of gap as the
    // dual-write one.
    setLocalWriteBroadcaster(this.db, this.node.broadcastLocalDoc)
    this._pairingQueue = []
    this._pairingWaiters = []

    // A Host that is RESTARTING already has its camp — bootstrap() must not run
    // again — but it still needs its own admission token, or it cannot
    // authenticate outward to a returning device and sync stays one-way.
    // Production does exactly this in startAutomergeSyncNodeIfEnabled; the
    // harness did not, and the symptom was a reconnect that timed out with
    // everything else looking healthy.
    const existingCamp = this.db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (existingCamp) {
      this.campId = existingCamp.id
      try {
        this.adminToken = issueDeviceToken(this.db, this.deviceId)
        this.node.setAuthToken(this.adminToken)
      } catch {
        // No host_signing_key yet — a first-run Host, whose bootstrap() will
        // mint one in a moment.
      }
    }
  }

  /** Mirrors Host.bootstrap in harness.js, minus the op-log write path
   * (createUser can't be reused — 'users' is not a document entity). */
  async bootstrap({ campName = 'TestCamp', adminName = 'admin', adminPin = '1234' } = {}) {
    const campId = randomUUID()
    this.db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, campName)
    const hostKey = ensureHostSigningKey(this.db)
    this.db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)

    const user = insertUser(this.db, { camp_id: campId, name: adminName, pin: adminPin, role: 'admin' })

    this.db.prepare(
      "UPDATE devices SET authorized_by_user_id = ? WHERE id = ?"
    ).run(user.id, this.deviceId)

    this.campId = campId
    this.adminUserId = user.id
    this.adminToken = issueDeviceToken(this.db, this.deviceId)
    this.node.setAuthToken(this.adminToken)

    // The camp must be in the DOCUMENT, not only in SQLite — the document is
    // what a joining device receives. main.js's ensureAutomergeDocSeeded does
    // exactly this on a real Host at startup; skipping it would make every
    // join scenario pass against an empty camp.
    await this.node.applyLocal(seedAllFromSqlite(this.db, this.node.getDoc()))

    this.addingDevices = true
    return { campId, userId: user.id, token: this.adminToken, joinCode: joinCode(campId) }
  }

  waitForPairingRequest(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      if (this._pairingQueue.length > 0) { resolve(this._pairingQueue.shift()); return }
      const timer = setTimeout(() => {
        const idx = this._pairingWaiters.indexOf(handler)
        if (idx !== -1) this._pairingWaiters.splice(idx, 1)
        reject(new Error('timeout waiting for pairing_request'))
      }, timeoutMs)
      const handler = (data) => { clearTimeout(timer); resolve(data) }
      this._pairingWaiters.push(handler)
    })
  }

  /** The director approves. Mirrors main.js's approveDevice, which is TWO
   * steps, not one: stamp the row, then DELIVER the decision on a fresh
   * stream. Stamping alone leaves the joining device waiting forever — it has
   * no way to observe the Host's database. */
  async approveDevice(deviceId) {
    const secret = randomBytes(32).toString('hex')
    this.db.prepare(
      "UPDATE devices SET authorized_at = ?, authorized_by_user_id = ?, pairing_status = 'authorized', device_secret_identifier = ?, revoked_at = NULL WHERE id = ?"
    ).run(new Date().toISOString(), this.adminUserId, secret, deviceId)
    await this.node.sendPairingApproved(deviceId, secret)
    return secret
  }

  /** Read a domain row projected from the CRDT doc — the equivalent of
   * harness.js's Host.getOps()/dbExec reads, but against the actual
   * projection tables (activities, groups, ...) rather than `operations`. */
  /** The director revokes a device. Mirrors main.js's revokeDevice: the row is
   * stamped, and every later admission decision re-reads it — there is no
   * cached trust to invalidate. */
  revokeDevice(deviceId, reason = 'test revocation') {
    this.db.prepare(
      "UPDATE devices SET revoked_at = ?, revocation_reason = ?, pairing_status = 'revoked' WHERE id = ?"
    ).run(new Date().toISOString(), reason, deviceId)
    // Evicting a still-connected peer is part of revoking, not a separate
    // step — see main.js's revokeDevice and transport.js's revokePeer.
    const peerId = this.db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get(deviceId)?.libp2p_peer_id
    if (peerId) this.node.revokePeer(peerId)
  }

  /** Whether this Host currently admits `peerId` to exchange documents. The
   * libp2p equivalent of "is the socket still open" — admission is the gate
   * that matters, not the connection. */
  admits(peerId) {
    return this.node.isPeerAuthenticated(String(peerId))
  }

  domainRow(table, id) {
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
  }

  getDoc() { return this.node.getDoc() }

  /** Apply a local domain write and broadcast it (mirrors Client.write below). */
  async write(args) {
    const newDoc = applyWrite(this.getDoc(), args)
    await this.node.applyLocal(newDoc)
    return { status: 'applied' }
  }

  async stop() { try { await this.node?.stop() } catch { /* ignore */ } try { this.db?.close() } catch { /* ignore */ } }
  close() { return this.stop() }
}

/**
 * Wraps a startSyncNode + SQLite DB pair acting as a joining Client.
 */
export class AmClient {
  /** See AmHost's constructor comment — same seam, same default. */
  constructor(dbPath, { startSyncNode: startSyncNodeOverride } = {}) {
    this.dbPath = dbPath
    this.db = null
    this.node = null
    this.deviceId = null
    this.token = null
    this.hostPeerId = null
    this._mutual = null
    this._startSyncNode = startSyncNodeOverride || startSyncNode
  }

  open() {
    this.db = openLocalDb(this.dbPath)
    this.deviceId = getOrCreateDeviceId(this.db)
    this.db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(
      this.deviceId, `Client-${this.deviceId.slice(0, 8)}`
    )
  }

  async start() {
    this.node = await this._startSyncNode({ deviceId: this.deviceId, db: this.db, doc: createEmptyDoc() })
    // Wire the per-device local-write broadcaster exactly as main.js does once
    // its node has started. Without this an appendOp-path write (deleteRecord,
    // ingest, restore) updates this device's document but never PUSHES it, so
    // it reaches a peer only if some other exchange happens to run — which made
    // scenario 30 pass alone and fail after other scenarios. Production wires
    // this; the harness did not, which is the same class of gap as the
    // dual-write one.
    setLocalWriteBroadcaster(this.db, this.node.broadcastLocalDoc)
  }

  /**
   * Simulate a process restart: persist the current doc to `docDir` (a
   * userDataDir stand-in — see docStore.js, the production save path this
   * mirrors), stop the node, then start a fresh one seeded from the saved
   * bytes. The DB file is untouched (same as harness.js's Client.restart —
   * pending, non-doc state lives in SQLite and survives on its own).
   */
  async restart(docDir, campId) {
    saveDoc(docDir, campId, this.node.getDoc())
    try { await this.node.stop() } catch { /* ignore */ }
    const doc = loadDoc(docDir, campId) ?? createEmptyDoc()
    this.node = await this._startSyncNode({ deviceId: this.deviceId, db: this.db, doc })
    // Wire the per-device local-write broadcaster exactly as main.js does once
    // its node has started. Without this an appendOp-path write (deleteRecord,
    // ingest, restore) updates this device's document but never PUSHES it, so
    // it reaches a peer only if some other exchange happens to run — which made
    // scenario 30 pass alone and fail after other scenarios. Production wires
    // this; the harness did not, which is the same class of gap as the
    // dual-write one.
    setLocalWriteBroadcaster(this.db, this.node.broadcastLocalDoc)
  }

  /** Dial the Host and wait until the transport admits the peer. */
  async dial(host) {
    this.hostPeerId = host.node.peerId
    await this.node.dial(host.node.getMultiaddrs()[0])
    await waitForCond(() => this.node.getPeers().includes(this.hostPeerId))
  }

  /**
   * Join a camp exactly as a real second device does, from a genuinely
   * camp-less database: type the code the Host is showing, get approved by the
   * director, sign in with a PIN, receive the camp over libp2p.
   *
   * This is what replaced `seedCampIdentity`. That scaffolding existed because
   * there WAS no join flow; there is one now
   * (docs/adr/2026-09-08-libp2p-join-flow.md), and a scenario that starts from
   * a device with nothing tests the product instead of the harness.
   */
  async join(host, { name = 'admin', pin = '1234', code = joinCode(host.campId) } = {}) {
    // A join starts its OWN node (pre-identity, unscoped discovery), so a
    // scenario that called start() first would leak the one it made. Joining
    // is the first thing a new device does; start() is for a returning one.
    if (this.node) {
      await this.node.stop().catch(() => {})
      this.node = null
    }
    const started = await startJoinSession({
      db: this.db,
      deviceId: this.deviceId,
      deviceName: `TestClient-${this.deviceId.slice(0, 8)}`,
      code,
      knownHost: host.node.getMultiaddrs()[0],
      startNode: this._startSyncNode,
    })
    if (started.status !== 'started') throw new Error(`join refused before it began: ${started.status}`)


    const session = started.session
    this.joinSession = session
    this.node = session.node
    this.hostPeerId = host.node.peerId

    if (!(await session.findHost())) throw new Error('join: no host answered the code')

    const pairing = await session.requestPairing()
    let secret = pairing.deviceSecretIdentifier
    if (pairing.status === 'pending') {
      // The director approves — the same two steps main.js's approveDevice
      // takes: stamp the row, then deliver the decision on a fresh stream.
      const decision = session.waitForPairingDecision()
      await host.approveDevice(this.deviceId)
      const settled = await decision
      if (settled.status !== 'approved') throw new Error('join: the director denied this device')
      secret = settled.deviceSecretIdentifier
    } else if (pairing.status !== 'approved') {
      throw new Error(`join: pairing returned ${pairing.status}`)
    }

    const login = await session.login({ name, pin, deviceSecretIdentifier: secret })
    if (login.status !== 'ok') throw new Error(`join: login failed (${JSON.stringify(login)})`)
    this.token = login.token

    const camp = await session.waitForCamp()
    if (!camp) throw new Error('join: signed in, but the camp never arrived')
    this.campId = camp.id
    return { status: 'ok', token: login.token, userId: login.userId, role: login.role, camp }
  }

  /** Kept as the name scenarios already use. A first join IS pair-and-login
   * now: there is no separate step, because there is no seeded identity to
   * start from. */
  async pairAndLogin(host, name = 'admin', pin = '1234') {
    return this.join(host, { name, pin })
  }

  /**
   * Re-establish sync after a restart — the RETURNING-device path, a different
   * thing from joining and not to be conflated with it. This device already has
   * its camp, its `signing_public_key` and a token, so both sides authenticate
   * by the ordinary route. Both directions are required (Stage 5 finding 4: a
   * node only sends to peers that authenticated to IT).
   */
  async reconnect(host) {
    this.hostPeerId = host.node.peerId
    if (!this.node.getPeers().includes(this.hostPeerId)) {
      await this.node.dial(host.node.getMultiaddrs()[0])
      await waitForCond(() => this.node.getPeers().includes(this.hostPeerId))
    }
    this.node.setAuthToken(this.token)
    await this.node.authenticateWith(this.hostPeerId, {
      type: 'authenticate', token: this.token, device_id: this.deviceId,
    })
    await host.node.authenticateWith(this.node.peerId, {
      type: 'authenticate', token: host.adminToken, device_id: host.deviceId,
    })
    await waitForCond(() => host.node.isPeerAuthenticated(this.node.peerId))
    await waitForCond(() => this.node.isPeerAuthenticated(this.hostPeerId))
  }

  domainRow(table, id) {
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
  }

  getDoc() { return this.node.getDoc() }

  async write(args) {
    const newDoc = applyWrite(this.getDoc(), args)
    await this.node.applyLocal(newDoc)
    return { status: 'applied' }
  }

  async stop() { try { await this.node?.stop() } catch { /* ignore */ } try { this.db?.close() } catch { /* ignore */ } }
  close() { return this.stop() }
}

function waitForCond(predicate, timeoutMs = 6000, pollMs = 40) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    function tick() {
      if (predicate()) { resolve(); return }
      if (Date.now() >= deadline) { reject(new Error(`waitFor timeout after ${timeoutMs}ms`)); return }
      setTimeout(tick, pollMs)
    }
    tick()
  })
}

/**
 * Bootstrap a Host and two Clients that both join for real — the setup every
 * "two devices, about to diverge" scenario needs before it does anything
 * scenario-specific. Extracted from scenario 31 (T194, ADR D4), which was the
 * first to need it; kept here rather than in the scenario so the next such
 * scenario reuses it instead of re-deriving the join sequence.
 *
 * PARAMETERIZING THE NODE. Pass `hostNode`/`clientANode`/`clientBNode` to
 * substitute what builds each device's libp2p node — e.g. a `startSyncNode`
 * imported from a *different* installed version of this codebase. That is
 * the seam a cross-version compatibility check needs (a camp's devices do not
 * upgrade together): build device A from one checkout's `startSyncNode` and
 * device B from another's, and this function does not care which. Each must
 * match electron/sync/automerge/syncNode.js's `startSyncNode` shape. Left
 * undefined, all three default to this checkout's `startSyncNode` — identical
 * to what scenario 31 used before this extraction, so its behaviour and
 * coverage are unchanged.
 *
 * WHAT WILL NOT WORK ACROSS TWO OS PROCESSES AS WRITTEN, for a caller who
 * wants clientA and clientB each running in their own process (which is what
 * running two differently-versioned checkouts against each other actually
 * requires — two `node_modules` trees cannot both be `require`d into one
 * process):
 *   - `host.node.getMultiaddrs()` / `.peerId`, read directly off the
 *     in-process object `startSyncNode` returns, are never serialized. A
 *     second process needs these handed to it over some channel (stdout, a
 *     file, a socket) before it can dial in — this function does not do that.
 *   - `configureDualWrite` (`setUserDataDirGetter`) and
 *     `setLocalWriteBroadcaster` set process-global state; each process must
 *     call these for itself, not inherit them from whichever process created
 *     the Host.
 *   - This function, `AmHost` and `AmClient` all instantiate their node
 *     in-process and return live JS objects (not IDs, not handles) — nothing
 *     here starts a child process, passes a port, or otherwise wires two OS
 *     processes together. A caller doing that owns the process boundary and
 *     whatever IPC carries peer info across it; this only supplies the node
 *     construction seam on each side.
 *   - `AmClient.restart`'s `docDir` persistence (`saveDoc`/`loadDoc`,
 *     electron/sync/automerge/docStore.js) genuinely is a file on disk, so it
 *     DOES cross a process boundary — but only if both processes are pointed
 *     at the same path, which is on the caller to arrange.
 */
export async function setupTwoJoinedDevices({
  campName, adminName, adminPin,
  hostNode, clientANode, clientBNode,
} = {}) {
  const tmpDir = makeTmpDir()

  const host = new AmHost(`${tmpDir}/host.db`, { startSyncNode: hostNode })
  await host.start()
  const { campId } = await host.bootstrap({ campName, adminName, adminPin })

  const clientA = new AmClient(`${tmpDir}/clientA.db`, { startSyncNode: clientANode })
  clientA.open()
  await clientA.join(host)

  const clientB = new AmClient(`${tmpDir}/clientB.db`, { startSyncNode: clientBNode })
  clientB.open()
  await clientB.join(host)

  return { tmpDir, host, clientA, clientB, campId }
}

/**
 * Partition clientA and clientB onto fresh, undialed nodes (AmClient.restart)
 * so that writes made after this call genuinely cannot reach the other device
 * or the Host until `healPartition` reconnects them. Each restarts into its
 * own subdirectory of `tmpDir`.
 */
export async function partitionClients({ tmpDir, clientA, clientB, campId }) {
  const dirA = `${tmpDir}/clientA-userdata`
  const dirB = `${tmpDir}/clientB-userdata`
  await clientA.restart(dirA, campId)
  await clientB.restart(dirB, campId)
  return { dirA, dirB }
}

/**
 * Heal a partition created by `partitionClients`: reconnect both clients to
 * the Host (AmClient.reconnect), mirroring what a real device does when its
 * network comes back. Does not wait for any particular write to have been
 * seen — callers assert convergence themselves via `waitFor`.
 */
export async function healPartition({ host, clientA, clientB }) {
  await clientA.reconnect(host)
  await clientB.reconnect(host)
}
