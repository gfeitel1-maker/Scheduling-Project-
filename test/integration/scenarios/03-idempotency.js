/**
 * Scenario 3: Host applies op exactly once even when client retries with the
 *             same client_write_id.
 *
 * This tests the idempotency path in handleSubmitOp (findOpByClientWriteId).
 * The retry scenario that arises in practice:
 *   - Client submits op with client_write_id X.
 *   - Host applies it (appendOp) but the op_applied reply never reaches the
 *     client (network cut, timeout, host restart before broadcast).
 *   - Client retries the same logical write with the same client_write_id X.
 *   - Host must return the ORIGINAL op without creating a second operations row.
 *
 * In-process simulation: we submit the same op twice over a raw WebSocket
 * (bypassing syncClient's resolver queue) and assert only ONE row exists in
 * the operations table for that entity/field.
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'

/** Open a raw WS, authenticate, and return the ws + a send-and-wait helper. */
function openRawWs(serverUrl, token, deviceId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(serverUrl)
    const pending = []
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      // Drain the next pending resolver for any reply-type message.
      if (pending.length > 0 && (
        msg.type === 'op_applied' ||
        msg.type === 'op_conflict' ||
        msg.type === 'lock_result' ||
        msg.type === 'error'
      )) {
        pending.shift()(msg)
      }
    })
    ws.on('error', reject)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
      // Give authenticate a moment to process.
      setTimeout(() => resolve({ ws, pending }), 80)
    })
  })
}

function sendAndWait({ ws, pending }, msg, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sendAndWait timeout')), timeoutMs)
    pending.push((reply) => { clearTimeout(timer); resolve(reply) })
    ws.send(JSON.stringify(msg))
  })
}

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const port = await getFreePort()

    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)
    await host.bootstrap()

    client = new Client(`${tmpDir}/client.db`)
    client.open()
    const { token } = await pairAndLogin(host, client)

    // We need a lock first to submit an op.  Use a raw WS so we have direct
    // control over the client_write_id without syncClient's abstractions.
    const raw = await openRawWs(host.serverUrl, token, client.deviceId)
    const entityId = randomUUID()
    const clientWriteId = randomUUID()

    // First submission — expect op_applied.
    const lock1 = await sendAndWait(raw, {
      type: 'acquire_lock',
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
    })
    if (!lock1.granted) throw new Error('Lock not granted for first submission')

    const reply1 = await sendAndWait(raw, {
      type: 'submit_op',
      op: {
        entity: 'activities',
        entity_id: entityId,
        field: 'name',
        value: 'Swimming',
        parent_op_id: null,
        client_write_id: clientWriteId,
      },
    })
    if (reply1.type !== 'op_applied') throw new Error(`Expected op_applied, got ${reply1.type}`)
    const originalOpId = reply1.op.id

    // Verify exactly 1 row exists for this entity/field.
    await waitFor(() => host.countOps('activities', entityId, 'name') === 1)

    // Second submission — SAME client_write_id, simulating a retry.
    // Acquire lock again (the first lock was released when the op was applied).
    const lock2 = await sendAndWait(raw, {
      type: 'acquire_lock',
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
    })
    if (!lock2.granted) throw new Error('Lock not granted for retry submission')

    const reply2 = await sendAndWait(raw, {
      type: 'submit_op',
      op: {
        entity: 'activities',
        entity_id: entityId,
        field: 'name',
        value: 'Swimming',   // same value
        parent_op_id: null,
        client_write_id: clientWriteId,  // same idempotency key
      },
    })
    if (reply2.type !== 'op_applied') throw new Error(`Expected op_applied on retry, got ${reply2.type}`)
    if (reply2.op.id !== originalOpId) throw new Error(
      `Retry returned different op id (${reply2.op.id}) — a duplicate was created`
    )

    // Crucially: only 1 row in operations for this entity/field, not 2.
    const count = host.countOps('activities', entityId, 'name')
    if (count !== 1) throw new Error(`Expected 1 op, found ${count} — idempotency failed`)

    raw.ws.close()
    return 'PASS'
  } finally {
    host?.close()
    client?.close()
    cleanupDirs(dirs)
  }
}
