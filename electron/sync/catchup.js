import { sendWithAck, SEND_ACK_TIMEOUT_MS } from './opDelivery.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES, DOMAIN_PARENT_SCOPED_ENTITIES } from '../ops/campScopedEntities.js'

// T7 fix: how long the Host waits for the Client's application-level
// `full_sync_applied` ack (see waitForFullSyncAck below) after the transport
// send itself is confirmed. Generous vs. SEND_ACK_TIMEOUT_MS's 8s: this is a
// larger, one-time batch commit on the Client (every camp-scoped domain
// table), not a single op.
const FULL_SYNC_ACK_TIMEOUT_MS = 15000

// Resolves once this connection's Client sends `full_sync_applied`, or after
// timeoutMs elapses with no ack (resolves false either way on timeout — the
// Host must not latch last_synced_at on a transport-confirmed-but-never-
// -acked send). Only one full_sync is ever in flight per connection, since
// sendFullSyncIfFirstPairing's own last_synced_at guard prevents re-entry
// until the latch is actually set.
function waitForFullSyncAck(ws, timeoutMs = FULL_SYNC_ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const settle = (result) => {
      if (settled) return
      settled = true
      // Clear the timer on whichever path settles first, exactly as
      // sendWithAck does above. Without this, an acked full-sync still left a
      // live 15s timer holding this socket: harmless-looking in production,
      // but it keeps the event loop busy and made the test suite's 5s-timeout
      // cases fail nondeterministically under load.
      if (timer) clearTimeout(timer)
      ws.pendingFullSyncAckResolve = null
      resolve(result)
    }
    ws.pendingFullSyncAckResolve = settle
    timer = setTimeout(() => settle(false), timeoutMs)
  })
}

// C4 (docs/adr/2026-08-17-sync-auth-layer-deepening.md): full_sync_applied
// carries no wire correlator (`{ type: 'full_sync_applied' }`), so unlike
// apply-ack below, there is nothing to key a Map by — a Map here would only
// add indirection over the same single-slot clobber hazard. This wraps the
// existing single-resolver-on-`ws` field behind a function interface so its
// existence becomes an internal detail of this module, invisible to
// syncServer.js. It does not, and cannot without a protocol change, make
// concurrent full-sync-acks on one socket safe — isReauthenticate is what
// prevents that, unchanged by this slice.
export function resolveFullSyncAck(ws, result) {
  if (ws.pendingFullSyncAckResolve) ws.pendingFullSyncAckResolve(result)
}

// asOfSeq is not read by this function's own body — it is accepted purely so
// the caller (handleAuthenticate) can pass the SAME single, synchronously-
// computed value into both this function and sendMissedOps, per the design
// doc §2.5: the two must agree on the exact same instant, and passing it
// through here keeps that invariant true by construction rather than true
// only because nothing currently awaits between two independently-read values.
// eslint-disable-next-line no-unused-vars
export async function sendFullSyncIfFirstPairing(db, ws, asOfSeq) {
  const device = db.prepare('SELECT last_synced_at FROM devices WHERE id = ?').get(ws.deviceId)
  if (!device || device.last_synced_at) return

  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  const campId = camp?.id ?? null

  const users = db.prepare('SELECT id, camp_id, name, pin_hash, pin_salt, role FROM users').all()
  // signing_public_key travels the same way signing_secret always has — see
  // docs/adr/2026-07-25-device-trust-revocation.md: every device needs it to
  // verify a 'camp' token fully offline. host_signing_key (the PRIVATE half)
  // is a separate table, never selected here or anywhere else in this file.
  const camps = db.prepare('SELECT id, name, signing_secret, signing_public_key FROM camps').all()

  // Extend the same full_sync message with every camp-scoped domain table
  // (design doc §2.1) — reusing the exact registry/scoping logic main.js's
  // `list()` IPC handler uses, so "camp-scoped" can never mean two different
  // things between the renderer's read path and this snapshot. If there is
  // no camp row yet (should not be reachable via a real pairing flow, but
  // defensive), every domain table ships as an empty array rather than the
  // message being skipped, so the Client's applyFullSync still runs and the
  // rest of the handshake still completes.
  const domainTables = {}
  for (const entity of DIRECT_CAMP_ENTITIES) {
    domainTables[entity] = campId
      ? db.prepare(`SELECT * FROM ${entity} WHERE camp_id = ?`).all(campId)
      : []
  }
  for (const entity of DOMAIN_PARENT_SCOPED_ENTITIES) {
    const { table, parentTable, parentKey } = PARENT_SCOPED_ENTITIES[entity]
    domainTables[entity] = campId
      ? db.prepare(`SELECT t.* FROM ${table} t JOIN ${parentTable} p ON p.id = t.${parentKey} WHERE p.camp_id = ?`).all(campId)
      : []
  }

  const delivered = await sendWithAck(ws, { type: 'full_sync', users, camps, ...domainTables })
  if (!delivered) return // transport failure — no point waiting for an app-level ack that can't arrive

  // Corrected mechanism (design doc §2.4): a transport-confirmed send is NOT
  // proof the Client's applyFullSync transaction actually committed. Wait
  // for the Client's own `full_sync_applied` reply — sent only after that
  // transaction commits (syncClient.js) — before latching last_synced_at.
  const applied = await waitForFullSyncAck(ws)
  if (applied) {
    try {
      db.prepare('UPDATE devices SET last_synced_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        ws.deviceId
      )
    } catch {
      // The ack timeout can resolve up to FULL_SYNC_ACK_TIMEOUT_MS after this
      // function started — long enough that the Host's own db/process may
      // already be shutting down by the time this fires (e.g. test teardown,
      // or a genuine host restart). A closed-db error here must not become
      // an unhandled rejection; harmless either way, since a still-unset
      // last_synced_at simply means the next reconnect retries the snapshot.
    }
  }
  // applied === false: transport delivered, but no application ack arrived
  // within the timeout (Client's apply failed, or the ack itself was lost).
  // last_synced_at stays NULL either way — next reconnect retries the whole
  // snapshot from scratch, safe by construction since every insert on the
  // Client side is INSERT OR REPLACE.
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
export function currentMaxOpSeq(db) {
  const row = db.prepare('SELECT MAX(seq) as maxSeq FROM operations').get()
  return row && Number.isInteger(row.maxSeq) ? row.maxSeq : 0
}

// T85 Part 2 (docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md):
// a transport-confirmed send (sendWithAck) proves the OS handed the frame to
// the kernel — nothing more. It has no idea whether the receiving Client's
// applyRemoteOp actually ran, so a dropped op (e.g. Failure 1's FK throw, now
// fixed by Part 1, or any other cause) used to be marked "delivered" and was
// never retried. This waits for the Client's own op_applied_ack — sent only
// after applyRemoteOp durably logs the op (syncClient.js's op_applied
// handler) — before sendMissedOps is allowed to advance the watermark past
// it. Modeled exactly on waitForFullSyncAck above and on syncClient.js's own
// withResolverTimeout/withKeyedResolverTimeout idiom: a resolver registered
// on the connection, a bounded timeout fallback, first-to-fire wins.
// C4: unlike full-sync-ack above, op_applied_ack's wire message already
// carries a real correlator (`{ type: 'op_applied_ack', op_id }`), so this
// is genuinely keyed — a per-connection Map, not a single field. This fixes
// the clobber ONLY for two DIFFERENT op_ids waited on concurrently on the
// same `ws`. It does NOT fix the same-op_id case: two overlapping
// sendMissedOps runs both read the same end-of-run watermark
// (last_synced_seq is written once at the end of a run, never per-op), so
// both start from the identical first op_id and both register a waiter at
// that same Map key — the second registration still overwrites the first's
// resolver, exactly like the old single-slot field. isReauthenticate is the
// sole thing preventing overlapping sendMissedOps runs (and therefore this
// same-op_id collision) from ever occurring; this slice does not touch or
// retire that guard. Mirrors syncClient.js's own keyedResolverMaps pattern
// (restoreResolvers/deleteResolvers/mergeResolvers, keyed by request_id),
// with the same same-key caveat.
function pendingApplyAcks(ws) {
  if (!ws.pendingApplyAcks) ws.pendingApplyAcks = new Map()
  return ws.pendingApplyAcks
}

// Exported so syncServer.test.js can register concurrent waiters directly
// (the C4 same-op_id known-limitation test) rather than reconstructing this
// registration logic in the test file.
export function waitForApplyAck(ws, opId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      pendingApplyAcks(ws).delete(opId)
      resolve(result)
    }
    pendingApplyAcks(ws).set(opId, (matchedOpId) => { if (matchedOpId === opId) finish(true) })
    setTimeout(() => finish(false), timeoutMs)
  })
}

export function resolveApplyAck(ws, opId) {
  const resolve = ws.pendingApplyAcks?.get(opId)
  if (resolve) resolve(opId)
}

// Exported for direct unit testing (Task 10 round-5 Fix 4): a real,
// deterministic mid-replay socket failure is impractical to force reliably
// over an actual network socket in a test, so the partial-send-failure path
// is tested by calling this directly against a real SQLite db with a
// controlled fake `ws` object whose send() throws on a specific op.
// asOfSeq (design doc §2.5): the caller (handleAuthenticate) computes
// currentMaxOpSeq(db) synchronously ONCE and passes the SAME value into both
// this function and sendFullSyncIfFirstPairing, so a write landing between
// two separately-computed baselines can never end up claimed as "already
// seen" by the watermark while also missing the domain snapshot (or vice
// versa). This is a signature change to an exported, directly-unit-tested
// function — every existing direct call site must pass asOfSeq explicitly.
export async function sendMissedOps(db, ws, asOfSeq, ackTimeoutMs = SEND_ACK_TIMEOUT_MS) {
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
      asOfSeq,
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
  // T85 Part 2: a second, sequential gate after the transport check above —
  // sendWithAck confirms the frame left the Host; waitForApplyAck confirms
  // the Client's applyRemoteOp actually ran. The loop is strictly sequential
  // and breaks on the first `false` from EITHER check, so within one
  // catch-up pass a gap below the watermark cannot occur by construction: op
  // N+1's catch-up message is never sent until op N's apply-ack has been
  // received. sendWithAck is kept as a fast-fail pre-check (an obviously-dead
  // socket fails in well under ackTimeoutMs, not the full apply-ack wait) —
  // not required for correctness once the apply-ack gate exists, but free to
  // leave in place.
  let lastSuccessSeq = since
  for (const op of rows) {
    const sent = await sendWithAck(ws, { type: 'op_applied', op }, ackTimeoutMs)
    if (!sent) break
    const applied = await waitForApplyAck(ws, op.id, ackTimeoutMs)
    if (!applied) break
    if (op.seq > lastSuccessSeq) lastSuccessSeq = op.seq
  }
  if (lastSuccessSeq !== since) {
    try {
      db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(lastSuccessSeq, ws.deviceId)
    } catch {
      // T85 Part 2 follow-up: waitForApplyAck's timeout can resolve up to
      // ackTimeoutMs after this function started (same reasoning as
      // waitForFullSyncAck's own try/catch above, which this now mirrors) —
      // long enough that the Host's own db/process may already be shutting
      // down by the time the loop above finishes (test teardown, or a
      // genuine host restart). A closed-db error here must not become an
      // unhandled rejection; harmless either way, since the next reconnect's
      // sendMissedOps simply re-reads whatever last_synced_seq is still on
      // disk and retries from there.
    }
  }
}
