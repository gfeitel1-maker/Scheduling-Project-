import { WebSocketServer } from 'ws'
import { verifySessionToken, attemptLogin } from '../auth/localAuth.js'
import { acquireLock, expireLocks, releaseLocksForDevice } from './lockManager.js'
import { detectConflict, appendOp, recordConflict, findOpByClientWriteId } from '../ops/operations.js'

// Task 10 round-5 Fix 4: report success/failure back to the caller instead
// of unconditionally swallowing it. sendMissedOps needs this to know exactly
// which missed op was the LAST one that genuinely made it out over the wire,
// so it can stop the watermark there instead of blindly advancing past ops
// that never actually sent.
function send(ws, message) {
  try {
    if (ws.readyState !== ws.OPEN) return false
    ws.send(JSON.stringify(message))
    return true
  } catch {
    // ignore send failures to dead/closing sockets — but tell the caller
    return false
  }
}

// Red Hat review follow-up: ws.send()'s completion callback is documented to
// go unfired in some destroy-path edge cases in the underlying `ws` library.
// Without a bound, that would hang this Promise forever. sendMissedOps's
// caller isn't awaited at its own call site, so this can't cascade into a
// connection- or process-wide freeze — but it would silently stall one
// device's catch-up with zero observability. SEND_ACK_TIMEOUT_MS races the
// ack against a bounded timeout and resolves false on expiry, matching the
// existing withResolverTimeout pattern in syncClient.js: settle-once guard,
// clear the timer on whichever path wins.
const SEND_ACK_TIMEOUT_MS = 8000

// Task 10 round-6 follow-up: a synchronous absence-of-exception from
// ws.send() is NOT proof of delivery. On a live-but-broken TCP connection,
// ws.send() commonly returns normally (readyState stays OPEN, nothing
// throws) while the actual write fails asynchronously — that failure only
// surfaces later via ws.send()'s optional completion callback (called with
// an Error on failure, undefined on success) or a subsequent close/error
// event. sendWithAck awaits that genuine confirmation instead of trusting
// the synchronous return, so callers (specifically sendMissedOps) can gate
// watermark advancement on real delivery, not just "didn't throw yet".
export function sendWithAck(ws, message, timeoutMs = SEND_ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (ws.readyState !== ws.OPEN) {
      resolve(false)
      return
    }
    let settled = false
    let timer = null
    const settle = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    timer = setTimeout(() => {
      // The ws.send() callback never fired within the bound. Treat this the
      // same as an explicit ack-failure so sendMissedOps's loop breaks
      // cleanly and the watermark stays honest rather than advancing past
      // an unconfirmed op.
      settle(false)
    }, timeoutMs)
    try {
      ws.send(JSON.stringify(message), (err) => {
        settle(!err)
      })
    } catch {
      // Preserve round-5 behavior: a synchronous throw from ws.send() itself
      // (if the underlying implementation can still do that) is still
      // treated as an immediate failure.
      settle(false)
    }
  })
}

function sendError(ws) {
  if (ws.deviceId) {
    send(ws, { type: 'error', message: 'invalid request' })
  } else {
    try {
      ws.close()
    } catch {
      // ignore
    }
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

function sendFullSyncIfFirstPairing(db, ws) {
  const device = db.prepare('SELECT last_synced_at FROM devices WHERE id = ?').get(ws.deviceId)
  if (!device || device.last_synced_at) return

  const users = db.prepare('SELECT id, camp_id, name, pin_hash, pin_salt, role FROM users').all()
  const camps = db.prepare('SELECT id, name FROM camps').all()
  send(ws, { type: 'full_sync', users, camps })

  db.prepare('UPDATE devices SET last_synced_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    ws.deviceId
  )
}

// Task 10 round-4 Fix 3: reconnect catch-up. sendFullSyncIfFirstPairing only
// ever ships `users`/`camps`, and only once — it says nothing about the
// `operations` log. Without this, a device that recorded a conflict (via
// recordConflict on receiving op_conflict) and then went offline before the
// resolution op was broadcast can never learn the conflict was resolved:
// listPendingConflicts() on that device only clears a conflict once a
// matching parent_op_id op exists in ITS OWN local operations table, and
// that op will never arrive on its own.
//
// Fix: on every authenticate (not just first pairing), send any `operations`
// rows with seq greater than this device's last-seen watermark, as
// `op_applied` messages — the exact same message shape/type the client
// already handles for a live write, so it flows through the existing
// applyRemoteOp path (idempotent INSERT ... ON CONFLICT DO NOTHING) with no
// new client-side code required. That in turn means a previously-missed
// resolution op lands in the device's local operations table, so the next
// listPendingConflicts() call on that device correctly reports the conflict
// as resolved.
//
// Scope: this covers exactly one thing — a reconnecting device catching up
// on missed `operations` rows (which is sufficient to fix stale conflict
// status). It does NOT re-deliver missed op_conflict notifications
// themselves (a conflict that was recorded live already persisted itself
// via recordConflict before this device went offline, so it doesn't need
// resending) and it does NOT solve general catch-up of every other message
// type (e.g. lock state). A device's very first authenticate only
// establishes its watermark baseline (see sendMissedOps below) — it does
// NOT replay the full pre-existing op history, so pre-existing conflicts
// from before a device's first connection are out of scope too.
function currentMaxOpSeq(db) {
  const row = db.prepare('SELECT MAX(seq) as maxSeq FROM operations').get()
  return row && Number.isInteger(row.maxSeq) ? row.maxSeq : 0
}

// Exported for direct unit testing (Task 10 round-5 Fix 4): a real,
// deterministic mid-replay socket failure is impractical to force reliably
// over an actual network socket in a test, so the partial-send-failure path
// is tested by calling this directly against a real SQLite db with a
// controlled fake `ws` object whose send() throws on a specific op.
export async function sendMissedOps(db, ws, ackTimeoutMs = SEND_ACK_TIMEOUT_MS) {
  const device = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(ws.deviceId)

  if (!device || device.last_synced_seq === null || device.last_synced_seq === undefined) {
    // First time this device's watermark is being established: baseline it
    // to "everything that exists right now" WITHOUT sending it. A device
    // connecting for the very first time doesn't need the entire
    // pre-existing op history replayed at it just to learn its own
    // watermark — that's out of scope here (see the Fix 3 comment above).
    // From this point on, only ops created AFTER this moment are missed-op
    // candidates for this device.
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(
      currentMaxOpSeq(db),
      ws.deviceId
    )
    return
  }

  const since = device.last_synced_seq
  const rows = db.prepare('SELECT * FROM operations WHERE seq > ? ORDER BY seq ASC').all(since)
  if (rows.length === 0) return

  // Task 10 round-5 Fix 4: only advance the watermark up to the seq of the
  // LAST successfully-sent op, not blindly to the max seq among ALL
  // candidate rows. Previously, if the connection dropped partway through
  // this replay loop, the watermark still jumped to maxSeq over every row —
  // falsely marking undelivered ops as delivered and silently, permanently
  // losing them from this device's perspective (they'd never be re-sent on
  // the next reconnect, since the watermark already claims they were seen).
  // Stop advancing at the first send failure: ops are sent in seq order, so
  // once one fails there's no guarantee later ones over the same dead/dying
  // socket would succeed either, and even if a later one happened to get
  // through, correctness requires no gaps below the watermark.
  // Task 10 round-6 follow-up: gate advancement on genuine async delivery
  // confirmation (sendWithAck), not just the absence of a synchronous throw.
  // We also re-check readyState via sendWithAck before every op — if the
  // socket closed/errored between one op's callback confirming success and
  // the next op's send being attempted, sendWithAck fails fast without
  // calling ws.send() again on a now-dead socket, and the loop stops there.
  let lastSuccessSeq = since
  for (const op of rows) {
    const ok = await sendWithAck(ws, { type: 'op_applied', op }, ackTimeoutMs)
    if (!ok) break
    if (op.seq > lastSuccessSeq) lastSuccessSeq = op.seq
  }
  if (lastSuccessSeq !== since) {
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(lastSuccessSeq, ws.deviceId)
  }
}

function handleAuthenticate(db, ws, msg) {
  const verified = verifySessionToken(msg.token)
  if (!verified || verified.deviceId !== msg.device_id) {
    ws.close()
    return
  }
  ws.deviceId = verified.deviceId
  ws.userId = verified.userId

  // Self-register this device on the Host if it has never been seen before.
  // Without this, a genuinely new device connecting for the first time has no
  // `devices` row, sendFullSyncIfFirstPairing's lookup returns undefined, and
  // the first-pairing full_sync silently never fires. INSERT OR IGNORE makes
  // this a safe no-op for an already-known device (own-machine registration
  // via ensureDeviceRow in main.js, or a returning peer).
  db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(
    ws.deviceId,
    `Device ${ws.deviceId.slice(0, 8)}`
  )

  sendFullSyncIfFirstPairing(db, ws)
  sendMissedOps(db, ws)
}

function validateLoginMsg(msg) {
  return isNonEmptyString(msg.device_id) && isNonEmptyString(msg.name) && isNonEmptyString(msg.pin)
}

function validateAcquireLockMsg(msg) {
  return isNonEmptyString(msg.entity) && isNonEmptyString(msg.entity_id) && isNonEmptyString(msg.field)
}

function handleLogin(db, ws, msg) {
  if (!validateLoginMsg(msg)) return

  const result = attemptLogin(db, { name: msg.name, pin: msg.pin, deviceId: msg.device_id })

  if (!result) {
    send(ws, { type: 'login_failed' })
    return
  }
  if (result.locked) {
    send(ws, { type: 'login_failed', locked: true, retryAfterMs: result.retryAfterMs })
    return
  }
  send(ws, { type: 'login_ok', token: result.token, userId: result.userId, role: result.role })
}

function validateSubmitOpMsg(msg) {
  const op = msg.op
  if (!op || typeof op !== 'object') return false
  if (!isNonEmptyString(op.entity)) return false
  if (!isNonEmptyString(op.entity_id)) return false
  if (!isNonEmptyString(op.field)) return false
  if (!(op.parent_op_id === null || isNonEmptyString(op.parent_op_id))) return false
  // client_write_id (Task 10 round-5 Fix 3) is optional for backward
  // compatibility with older clients / callers that don't set it, but if
  // present it must be a non-empty string so it's safe to use as a dedup key.
  if (!(op.client_write_id === undefined || op.client_write_id === null || isNonEmptyString(op.client_write_id))) return false
  return true
}

function handleAcquireLock(db, ws, msg) {
  const result = acquireLock(db, {
    entity: msg.entity,
    entity_id: msg.entity_id,
    field: msg.field,
    device_id: ws.deviceId,
  })
  send(ws, { type: 'lock_result', granted: result.granted, ...(result.holder_device_id ? { holder_device_id: result.holder_device_id } : {}) })
}

function handleSubmitOp(db, wss, ws, msg) {
  const incomingOp = { ...msg.op, device_id: ws.deviceId }

  // Task 10 round-5 Fix 3: idempotency-at-the-logical-write-level. If a
  // submit_op carrying this client_write_id was already applied (e.g. the
  // original submission WAS applied server-side but its op_applied reply
  // never reached the client — timeout/disconnect mid-flight — and the
  // client's flushQueue retried the same logical write), return the
  // ORIGINAL op instead of running detectConflict/appendOp again. Running
  // detectConflict on a replay would spuriously report a conflict (the
  // replay's parent_op_id points at the state BEFORE the original op, but
  // the original op is now itself the latest op for this entity/field) and
  // appendOp would mint a second, distinct op id for the same logical write.
  if (incomingOp.client_write_id) {
    const already = findOpByClientWriteId(db, incomingOp.client_write_id)
    if (already) {
      send(ws, { type: 'op_applied', op: already })
      return
    }
  }

  const { conflict, existingOp } = detectConflict(db, incomingOp)
  if (conflict) {
    // Persist so this conflict survives a restart of the host, even if the
    // submitting device never receives/persists the op_conflict message
    // itself (e.g. it disconnects before the reply arrives).
    try {
      recordConflict(db, { incomingOp, existingOp })
    } catch {
      // best-effort: persistence failure must never block the conflict
      // notification the submitting device is waiting on
    }
    send(ws, { type: 'op_conflict', incomingOp, existingOp })
    return
  }
  const op = appendOp(db, incomingOp)
  for (const client of wss.clients) {
    if (client.deviceId) {
      try {
        if (client.readyState === client.OPEN) {
          send(client, { type: 'op_applied', op })
        }
      } catch {
        // never let one dead client stop the broadcast to others
      }
    }
  }
}

export function startSyncServer(db, { port }) {
  const wss = new WebSocketServer({ port })
  wss.on('error', () => {
    // defense-in-depth: swallow bind failures (e.g. EADDRINUSE) so an
    // underlying port collision cannot crash the whole process via Node's
    // default "throw on unhandled EventEmitter error" behavior.
  })

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }

      if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
        return
      }

      try {
        if (msg.type === 'authenticate') {
          handleAuthenticate(db, ws, msg)
          return
        }

        if (msg.type === 'login') {
          handleLogin(db, ws, msg)
          return
        }

        if (!ws.deviceId) return

        if (msg.type === 'acquire_lock') {
          if (!validateAcquireLockMsg(msg)) {
            sendError(ws)
            return
          }
          handleAcquireLock(db, ws, msg)
        } else if (msg.type === 'submit_op') {
          if (!validateSubmitOpMsg(msg)) {
            sendError(ws)
            return
          }
          handleSubmitOp(db, wss, ws, msg)
        }
      } catch {
        sendError(ws)
      }
    })

    ws.on('close', () => {
      if (ws.deviceId) {
        try {
          releaseLocksForDevice(db, ws.deviceId)
        } catch {
          // ignore errors releasing locks on disconnect
        }
      }
    })
  })

  const expiryInterval = setInterval(() => expireLocks(db, 60_000), 30_000)

  return {
    wss,
    close() {
      clearInterval(expiryInterval)
      wss.close()
    },
  }
}
