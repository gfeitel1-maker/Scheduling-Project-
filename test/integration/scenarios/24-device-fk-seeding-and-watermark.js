/**
 * Scenario 24: T85 — device FK seeding, delivery-watermark truth, and
 * Host-local broadcast.
 * docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md
 *
 * Verifies, over the REAL wire protocol, with NO harness.registerDevice()
 * workaround anywhere in this file:
 *
 *   a. Live broadcast: Client B writes an op, Client C (a real,
 *      independently paired peer) receives it via op_applied, applies it
 *      durably, and stub-seeds a `devices` row for B — direct proof the
 *      FK-drop defect (Failure 1) is closed at its root, not papered over
 *      by a test-only device-row injection.
 *   b. Reconnect catch-up with a mid-batch apply failure: Client C goes
 *      offline, the Host writes a batch of ops, one op in the middle of the
 *      batch is engineered to fail applyRemoteOp's own op-log INSERT on C —
 *      the Host's watermark stops BEFORE that op's seq, and on the NEXT
 *      reconnect (failure removed) that op and everything after it in the
 *      original batch is re-delivered.
 *   c. Host-local broadcast: the Host writes via its own no-serverUrl
 *      client constructed with `wss` (main.js's real shape) and a
 *      live-connected Client receives it — Failure 3's regression test.
 *   d. Negative security: every wire message sent during this scenario is
 *      captured by patching WebSocket.prototype.send, which covers BOTH
 *      directions on BOTH the Host and every Client (the `ws` library uses
 *      the same class for server-side connections and client sockets).
 *      None of them ever carries the Host's real signing secrets or a
 *      device's real device_secret_identifier outside the one legitimate
 *      pairing_approved channel, and every op_applied_ack message carries
 *      nothing beyond {type, op_id} — proving no devices row is ever
 *      transmitted, stub or real.
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'
import { createSyncClient } from '../../../electron/sync/syncClient.js'

export async function run() {
  const dirs = []
  let host, clientB, clientC
  const capturedMessages = []
  const originalSend = WebSocket.prototype.send

  // Captures every message sent by EVERY WebSocket instance for the
  // duration of this scenario — both the Host's per-connection sockets
  // (members of wss.clients) and every Client's own socket are instances of
  // the same `ws` WebSocket class, so this one patch sees traffic in both
  // directions across every participant.
  WebSocket.prototype.send = function (data, ...args) {
    try {
      capturedMessages.push(typeof data === 'string' ? data : data.toString())
    } catch { /* never let capture break the real send */ }
    return originalSend.call(this, data, ...args)
  }

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const port = await getFreePort()

    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)
    await host.bootstrap()

    // --- pair two REAL clients through the ACTUAL pairing flow ------------
    clientB = new Client(`${tmpDir}/clientB.db`)
    clientB.open()
    await pairAndLogin(host, clientB)

    clientC = new Client(`${tmpDir}/clientC.db`)
    clientC.open()
    await pairAndLogin(host, clientC)

    // --- a. live broadcast: B writes, C receives, C stub-seeds B's row ----
    if (clientC.db.prepare('SELECT 1 FROM devices WHERE id = ?').get(clientB.deviceId)) {
      throw new Error('Setup invariant broken: Client C already knows Client B\'s device_id before any op crossed the wire')
    }

    const op0EntityId = randomUUID()
    const writeResult = await clientB.write({ entity: 'activities', entity_id: op0EntityId, field: 'name', value: 'Archery' })
    if (writeResult.status !== 'applied') throw new Error(`Client B write: ${writeResult.status}`)

    await waitFor(
      () => clientC.db.prepare('SELECT 1 FROM operations WHERE entity_id = ? AND device_id = ?').get(op0EntityId, clientB.deviceId),
      8000
    )

    const stubRow = clientC.db.prepare('SELECT * FROM devices WHERE id = ?').get(clientB.deviceId)
    if (!stubRow) throw new Error('Client C never stub-seeded a devices row for Client B\'s device_id — the FK-drop defect is not closed')
    if (stubRow.pairing_status !== 'unknown') {
      throw new Error(`Expected stub pairing_status 'unknown', got ${JSON.stringify(stubRow.pairing_status)}`)
    }
    if (stubRow.name !== `Device ${clientB.deviceId.slice(0, 8)}`) {
      throw new Error(`Unexpected stub name: ${JSON.stringify(stubRow.name)}`)
    }
    if (stubRow.device_secret_identifier !== null) throw new Error('Stub row must never carry a secret')
    if (stubRow.authorized_at !== null) throw new Error('Stub row must never appear pre-authorized')
    if (stubRow.revoked_at !== null) throw new Error('Stub row must never appear pre-revoked')

    // --- b. reconnect catch-up with a mid-batch apply failure --------------
    clientC.disconnect()
    await new Promise((r) => setTimeout(r, 150))

    const localWriter = createSyncClient(host.db, { device_id: host.deviceId, author_user_id: host.adminUserId })
    const batchIds = []
    for (let i = 0; i < 5; i++) {
      const id = randomUUID()
      batchIds.push(id)
      const r = await localWriter.write({ entity: 'activities', entity_id: id, field: 'name', value: `Batch-${i}` })
      if (r.status !== 'applied') throw new Error(`Host local write ${i}: ${r.status}`)
    }

    // Engineer the THIRD op in the batch to fail applyRemoteOp's own op-log
    // INSERT on Client C — a genuine local DB failure, deliberately distinct
    // from Part 1's FK class (already closed above in step a), so this
    // proves the watermark gate (Part 2) independently.
    const failingEntityId = batchIds[2]
    const realPrepare = clientC.db.prepare.bind(clientC.db)
    clientC.db.prepare = (sql) => {
      if (sql.startsWith('INSERT INTO operations')) {
        return {
          run: (...args) => {
            if (args[2] === failingEntityId) throw new Error('simulated local DB failure for the engineered op')
            return realPrepare(sql).run(...args)
          },
        }
      }
      return realPrepare(sql)
    }

    await clientC.reconnect()

    // The two ops BEFORE the failure must land.
    await waitFor(() => clientC.db.prepare('SELECT 1 FROM operations WHERE entity_id = ?').get(batchIds[1]), 8000)

    // The Host's watermark for Client C must land EXACTLY at the last op
    // that genuinely acked (batchIds[1]'s seq) — not merely "below the
    // failed op's seq", which would be trivially true even before this
    // catch-up pass runs at all (the pre-existing watermark already sits
    // below it). This only becomes true once sendMissedOps's loop has
    // actually reached and given up on the failed op — production's
    // waitForApplyAck default (8s) governs how long that takes, so this
    // wait is intentionally generous rather than a guessed sleep.
    const lastGoodSeq = host.db.prepare('SELECT seq FROM operations WHERE entity_id = ?').get(batchIds[1]).seq
    await waitFor(() => {
      const row = host.db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(clientC.deviceId)
      return row && row.last_synced_seq === lastGoodSeq
    }, 12000)

    clientC.db.prepare = realPrepare

    // Ops AFTER the failed one in the same batch must never have landed on
    // this pass — the loop must stop, not skip past the failure.
    if (clientC.db.prepare('SELECT 1 FROM operations WHERE entity_id = ?').get(batchIds[3])) {
      throw new Error('An op after the engineered failure was delivered before the failed op itself — ordering violated')
    }
    if (clientC.db.prepare('SELECT 1 FROM operations WHERE entity_id = ?').get(batchIds[4])) {
      throw new Error('An op after the engineered failure was delivered before the failed op itself — ordering violated')
    }
    if (clientC.db.prepare('SELECT 1 FROM operations WHERE entity_id = ?').get(failingEntityId)) {
      throw new Error('The engineered failure was not actually engineered — the op landed anyway')
    }

    // Reconnect AGAIN with the engineered failure removed — the failed op
    // and everything after it in the ORIGINAL batch must be re-delivered,
    // proving it was never permanently lost, just correctly not-yet-acked.
    await clientC.reconnect()
    await waitFor(
      () => batchIds.slice(2).every((id) => clientC.db.prepare('SELECT 1 FROM operations WHERE entity_id = ?').get(id)),
      12000
    )

    // --- c. Host-local broadcast reaches a live client ----------------------
    const wssLocalWriter = createSyncClient(host.db, {
      device_id: host.deviceId,
      author_user_id: host.adminUserId,
      wss: host.server.wss,
    })
    const hostLocalEntityId = randomUUID()
    const hostLocalResult = await wssLocalWriter.write({ entity: 'activities', entity_id: hostLocalEntityId, field: 'name', value: 'HostLocal' })
    if (hostLocalResult.status !== 'applied') throw new Error(`Host-local write: ${hostLocalResult.status}`)

    await waitFor(() => clientC.db.prepare('SELECT 1 FROM operations WHERE entity_id = ?').get(hostLocalEntityId), 8000)

    // --- d. negative security: no secret ever crossed the wire -------------
    // NOTE: camps.signing_secret is deliberately NOT checked here — it is a
    // pre-existing, documented, LEGITIMATE full_sync payload field (every
    // device needs it locally to verify 'local' HMAC tokens; see
    // isValidFullSyncCamp/sendFullSyncIfFirstPairing). The two values this
    // ADR's Security section actually claims never cross the wire are
    // device_secret_identifier (outside its two pre-existing, documented
    // channels below) and host_signing_key.private_key (the Ed25519 PRIVATE
    // half — only signing_public_key is ever sent, never this).
    const keyRow = host.db.prepare('SELECT private_key FROM host_signing_key LIMIT 1').get()
    const deviceSecrets = host.db
      .prepare('SELECT device_secret_identifier FROM devices WHERE device_secret_identifier IS NOT NULL')
      .all()
      .map((r) => r.device_secret_identifier)

    if (!keyRow?.private_key) throw new Error('Setup invariant broken: no host_signing_key.private_key to test against')
    if (deviceSecrets.length < 2) throw new Error('Setup invariant broken: expected at least 2 paired devices with secrets')

    for (const raw of capturedMessages) {
      if (raw.includes(keyRow.private_key)) {
        throw new Error('host_signing_key.private_key appeared in a wire message')
      }
      // device_secret_identifier legitimately crosses the wire on two
      // pre-existing, documented channels, neither introduced by T85:
      // Host -> Client in pairing_approved (the Host hands over the secret
      // once), and Client -> Host in login (the Client proves it holds the
      // secret it was given). Any OTHER message (op_applied, op_applied_ack,
      // full_sync, etc.) must never carry a real device secret.
      let parsed
      try { parsed = JSON.parse(raw) } catch { parsed = null }
      if (parsed && (parsed.type === 'pairing_approved' || parsed.type === 'login')) continue
      for (const secret of deviceSecrets) {
        if (raw.includes(secret)) {
          throw new Error(`A device_secret_identifier value appeared outside pairing_approved/login, in a message of type ${parsed?.type}`)
        }
      }
    }

    // op_applied_ack must exist in the capture (Part 2 firing for real, over
    // the real wire) AND carry nothing beyond {type, op_id} — proving no
    // devices row (stub or real) is ever transmitted, not just that no
    // secret happens to be present within one.
    const ackMessages = capturedMessages
      .map((raw) => { try { return JSON.parse(raw) } catch { return null } })
      .filter((m) => m && m.type === 'op_applied_ack')
    if (ackMessages.length === 0) {
      throw new Error('No op_applied_ack message was ever sent — Part 2 never exercised over the real wire')
    }
    for (const ack of ackMessages) {
      const keys = Object.keys(ack).sort()
      if (keys.join(',') !== 'op_id,type') {
        throw new Error(`op_applied_ack carried unexpected keys: ${JSON.stringify(keys)}`)
      }
    }

    // No message anywhere carries the stub marker itself (pairing_status:
    // 'unknown') — the stub row lives ONLY in the receiver's own local db,
    // never on the wire, in either direction.
    for (const raw of capturedMessages) {
      if (raw.includes('"pairing_status":"unknown"')) {
        throw new Error('A stub devices row (pairing_status: "unknown") was transmitted over the wire — it must stay local-only')
      }
    }

    return 'PASS'
  } finally {
    WebSocket.prototype.send = originalSend
    try { clientB?.close() } catch { /* ignore */ }
    try { clientC?.close() } catch { /* ignore */ }
    try { host?.close() } catch { /* ignore */ }
    cleanupDirs(dirs)
  }
}
