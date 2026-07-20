import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { appendOp, recordConflict } from '../ops/operations.js'
import { PROJECTIONS, applyProjection } from '../ops/projections.js'
import { insertPendingWrite, deletePendingWrite, listPendingWrites } from './pendingWrites.js'

const DEFAULT_RESOLVER_TIMEOUT_MS = 10000

export function createSyncClient(
  db,
  { device_id, author_user_id, serverUrl, token: initialToken, lockTimeoutMs = DEFAULT_RESOLVER_TIMEOUT_MS, submitTimeoutMs = DEFAULT_RESOLVER_TIMEOUT_MS }
) {
  const opAppliedListeners = []
  const opConflictListeners = []
  const queue = []
  let token = initialToken

  function notifyOpApplied(op) {
    for (const listener of opAppliedListeners) listener(op)
  }

  function notifyOpConflict(msg) {
    for (const listener of opConflictListeners) listener(msg)
  }

  if (!serverUrl) {
    return {
      async write({ entity, entity_id, field, value, parent_op_id = null }) {
        const op = appendOp(db, {
          entity,
          entity_id,
          field,
          value,
          author_user_id,
          device_id,
          parent_op_id,
        })
        notifyOpApplied(op)
        return { status: 'applied', op }
      },
      onOpApplied(callback) {
        opAppliedListeners.push(callback)
      },
      onOpConflict(callback) {
        opConflictListeners.push(callback)
      },
      getQueuedOps() {
        return []
      },
      async flushQueue() {},
      async waitUntilConnected() {},
      close() {},
    }
  }

  let ws = null
  let connected = false
  // Distinct from `connected`: `connected` only means the WebSocket is open.
  // `authenticated` means we have actually SENT an `authenticate` message on
  // this connection (either because a token existed at connect() time, or
  // because loginRemote() just succeeded and sent one). The server currently
  // sends no ack for `authenticate` (see syncServer.js's handleAuthenticate),
  // so "authenticated" here means "we sent authenticate with what we believe
  // is a valid token" — not "the server confirmed it". That is an accepted,
  // known limitation, not a hidden one; a real ack protocol is out of scope
  // for this fix.
  let authenticated = false
  let connectedResolve
  let connectedPromise = new Promise((resolve) => {
    connectedResolve = resolve
  })
  const lockResolvers = []
  const submitResolvers = []
  const loginResolvers = []

  function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0
  }

  function isValidFullSyncUser(user) {
    if (user === null || typeof user !== 'object' || Array.isArray(user)) return false
    if (!isNonEmptyString(user.id)) return false
    if (!(user.camp_id === null || isNonEmptyString(user.camp_id))) return false
    if (!isNonEmptyString(user.name)) return false
    if (!isNonEmptyString(user.pin_hash)) return false
    if (!isNonEmptyString(user.pin_salt)) return false
    if (user.role !== 'admin' && user.role !== 'staff') return false
    return true
  }

  function isValidFullSyncCamp(camp) {
    if (camp === null || typeof camp !== 'object' || Array.isArray(camp)) return false
    if (!isNonEmptyString(camp.id)) return false
    if (!isNonEmptyString(camp.name)) return false
    return true
  }

  function applyFullSync(msg) {
    const users = Array.isArray(msg.users) ? msg.users : []
    const camps = Array.isArray(msg.camps) ? msg.camps : []

    // Wrap the whole batch in a single transaction: a genuine mid-loop DB
    // failure (e.g. a real constraint violation on some row that passed
    // per-row validation) rolls back the ENTIRE batch instead of leaving
    // camps/users partially populated. Per-row validation still runs the
    // same way beforehand (via `continue`) - this is purely about DB-level
    // atomicity for the writes that do proceed, and it also collapses N
    // auto-committing statements into a single transaction for performance.
    const applyBatch = db.transaction(() => {
      for (const camp of camps) {
        if (!isValidFullSyncCamp(camp)) continue
        db.prepare('INSERT OR REPLACE INTO camps (id, name) VALUES (?, ?)').run(camp.id, camp.name)
      }

      for (const user of users) {
        if (!isValidFullSyncUser(user)) continue
        db.prepare(
          'INSERT OR REPLACE INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(user.id, user.camp_id, user.name, user.pin_hash, user.pin_salt, user.role)
      }
    })
    applyBatch()
  }

  function isValidRemoteOp(op) {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) return false
    if (!isNonEmptyString(op.id)) return false
    if (!isNonEmptyString(op.entity)) return false
    if (!isNonEmptyString(op.entity_id)) return false
    if (!isNonEmptyString(op.field)) return false
    if (!isNonEmptyString(op.device_id)) return false
    if (!isNonEmptyString(op.timestamp)) return false
    if (!('value' in op)) return false
    if (typeof op.value === 'object' && op.value !== null) return false
    if (!(op.parent_op_id === null || isNonEmptyString(op.parent_op_id))) return false
    return true
  }

  function applyRemoteOp(op) {
    // The op-log insert must be durable regardless of projection outcome: the
    // server already accepted and broadcast this op as canonical, so this
    // client's local materialization of it (the projection) hitting a snag
    // must not erase the log entry. Keep the insert in its own transaction.
    // Capture whether the insert actually inserted a NEW row (changes > 0) vs.
    // no-opped on a replayed/duplicate op id (ON CONFLICT DO NOTHING) - only a
    // genuinely new op should be projected, otherwise a replay with a mutated
    // field/value could overwrite the projected table with spoofed values.
    const insert = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id, client_write_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        )
        .run(op.id, op.entity, op.entity_id, op.field, op.value, op.author_user_id ?? null, op.device_id, op.timestamp, op.parent_op_id ?? null, op.client_write_id ?? null)
      return result.changes
    })
    const changes = insert()
    if (changes === 0) {
      // Replay of a previously-seen op id: the original op's projection
      // already ran when it was first received. Skip re-projecting.
      return
    }

    try {
      applyProjection(db, op)
    } catch {
      // Projection failure on an already-logged, already-canonical op is
      // swallowed here: there's no logging/observability infra yet to
      // surface it further. The op-log entry above remains authoritative.
    }
  }

  function connect() {
    ws = new WebSocket(serverUrl)

    ws.on('open', () => {
      if (token) {
        ws.send(JSON.stringify({ type: 'authenticate', token, device_id }))
        authenticated = true
      }
      connected = true
      connectedResolve()
    })

    ws.on('message', (data) => {
      try {
        let msg
        try {
          msg = JSON.parse(data.toString())
        } catch {
          return
        }

        if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
          return
        }

        if (msg.type === 'full_sync') {
          applyFullSync(msg)
          return
        }

        if (msg.type === 'lock_result') {
          const resolve = lockResolvers.shift()
          if (resolve) resolve(msg)
          return
        }

        if (msg.type === 'login_ok' || msg.type === 'login_failed') {
          const resolve = loginResolvers.shift()
          if (resolve) resolve(msg)
          return
        }

        if (msg.type === 'op_applied') {
          if (!isValidRemoteOp(msg.op)) {
            // Belt-and-suspenders: full validation failed, but if we can still
            // trust that device_id points at THIS device (a lightweight,
            // separate check from full op validity), drain this device's
            // pending submitResolvers now with a fast { status: 'error' }
            // instead of silently discarding the message and relying solely
            // on the timeout safety net to eventually unstick the caller.
            const op = msg.op
            if (
              op !== null &&
              typeof op === 'object' &&
              !Array.isArray(op) &&
              typeof op.device_id === 'string' &&
              op.device_id.length > 0 &&
              op.device_id === device_id
            ) {
              const resolve = submitResolvers.shift()
              if (resolve) resolve({ status: 'error' })
            }
            return
          }

          // Structural guarantee: resolver-draining for this device's own op
          // MUST happen no matter what throws inside this block (a bad field,
          // a projection error, a listener exception, anything). The try/finally
          // is the mechanism - there is no code path here that can skip the
          // finally block, unlike the previous version where draining only ran
          // if execution reached a specific line.
          let opError = null
          try {
            applyRemoteOp(msg.op)
            notifyOpApplied(msg.op)
          } catch (err) {
            opError = err
          } finally {
            if (msg.op.device_id === device_id) {
              const resolve = submitResolvers.shift()
              if (resolve) resolve(opError ? { status: 'error', op: msg.op, error: opError } : msg)
            }
          }
          return
        }

        if (msg.type === 'op_conflict') {
          // Persist locally too — this device (not just the host) needs the
          // conflict to survive its own restart, e.g. if the user closes the
          // app before resolving it. Best-effort: never let a persistence
          // failure block delivering the conflict to the caller/listeners.
          try {
            if (msg.incomingOp && msg.existingOp) {
              recordConflict(db, { incomingOp: msg.incomingOp, existingOp: msg.existingOp })
            }
          } catch {
            // ignore — see comment above
          }
          notifyOpConflict(msg)
          const resolve = submitResolvers.shift()
          if (resolve) resolve(msg)
        }
      } catch {
        // defense-in-depth: never let a malformed/unexpected message crash the process
      }
    })

    ws.on('error', () => {
      // connection failures surface via 'close'; swallow here to avoid an unhandled error event
      settlePendingOnDisconnect()
    })

    function settlePendingOnDisconnect() {
      while (lockResolvers.length) {
        const resolve = lockResolvers.shift()
        if (resolve) resolve({ status: 'disconnected' })
      }
      while (submitResolvers.length) {
        const resolve = submitResolvers.shift()
        if (resolve) resolve({ status: 'disconnected' })
      }
      while (loginResolvers.length) {
        const resolve = loginResolvers.shift()
        if (resolve) resolve({ status: 'disconnected' })
      }
    }

    ws.on('close', () => {
      connected = false
      authenticated = false
      connectedPromise = new Promise((resolve) => {
        connectedResolve = resolve
      })
      settlePendingOnDisconnect()
    })
  }

  // Task 10 round-5 Fix 1: reload any writes that were queued (and durably
  // persisted via insertPendingWrite) before this process last exited, so a
  // restart/crash before flushQueue synced them does not lose the write or
  // the resolution choice it represents. Loaded before connect() so a
  // flushQueue triggered by the initial connection picks these up too.
  for (const item of listPendingWrites(db)) {
    queue.push(item)
  }

  connect()

  // Structural safety net: wrap a resolver-array push with a bounded timeout so
  // that ANY current-or-future gap in draining (a missed message type, an early
  // return before a drain point, a server that never replies) degrades to a
  // bounded delay instead of hanging the caller's promise forever. If the
  // timeout fires while our exact resolver is still sitting in the array
  // (nothing else has drained it), we remove it ourselves and resolve with
  // { status: 'timeout' }. If something else drains it first (normal response
  // or an error-path drain), the timeout is cleared and never fires.
  function withResolverTimeout(resolversArray, timeoutMs, sendFn) {
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const wrappedResolve = (result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(result)
      }
      timer = setTimeout(() => {
        const idx = resolversArray.indexOf(wrappedResolve)
        if (idx !== -1) {
          resolversArray.splice(idx, 1)
          wrappedResolve({ status: 'timeout' })
        }
      }, timeoutMs)
      resolversArray.push(wrappedResolve)
      sendFn()
    })
  }

  function acquireLockRemote(entity, entity_id, field) {
    return withResolverTimeout(lockResolvers, lockTimeoutMs, () => {
      ws.send(JSON.stringify({ type: 'acquire_lock', entity, entity_id, field }))
    })
  }

  function submitOpRemote(op) {
    return withResolverTimeout(submitResolvers, submitTimeoutMs, () => {
      ws.send(JSON.stringify({ type: 'submit_op', op }))
    })
  }

  function sendLoginRemote({ name, pin }) {
    return withResolverTimeout(loginResolvers, lockTimeoutMs, () => {
      ws.send(JSON.stringify({ type: 'login', device_id, name, pin }))
    })
  }

  async function performWrite({ entity, entity_id, field, value, parent_op_id = null, client_write_id = null }) {
    const lockResult = await acquireLockRemote(entity, entity_id, field)
    if (lockResult.status === 'disconnected' || lockResult.status === 'timeout') {
      return { status: lockResult.status }
    }
    if (!lockResult.granted) {
      // Task 10 round-5 Fix 2: lock contention (another device currently
      // holds the lock) is distinct from a genuine op-conflict — submitOpRemote
      // never even runs here, so no op_conflict message fires and nothing
      // surfaces this any other way. Previously this returned the same
      // { status: 'conflict' } as a real op-conflict, so flushQueue could not
      // tell the two apart and silently dropped a transiently-contended
      // queued write instead of retrying it. Use a distinctly-named status so
      // callers (flushQueue in particular) can't misclassify it.
      return { status: 'lock_contention', holder_device_id: lockResult.holder_device_id }
    }

    const op = { entity, entity_id, field, value, author_user_id, parent_op_id, client_write_id }
    const submitResult = await submitOpRemote(op)
    if (submitResult.status === 'disconnected' || submitResult.status === 'timeout' || submitResult.status === 'error') {
      return submitResult
    }
    if (submitResult.type === 'op_conflict') {
      return { status: 'conflict', existingOp: submitResult.existingOp }
    }
    return { status: 'applied', op: submitResult.op }
  }

  function waitForReconnect(timeoutMs = 2000) {
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      connectedPromise.then(finish)
      setTimeout(finish, timeoutMs)
    })
  }

  return {
    async write(request) {
      if (!authenticated) {
        // Task 10 round-5 Fix 1: persist BEFORE acknowledging 'queued' to the
        // caller. This is what makes the queue genuinely durable — if the
        // process dies before flushQueue ever runs, the row is still here on
        // next startup to be reloaded (see listPendingWrites above), so the
        // 'queued' status this returns is now honest rather than a false
        // confidence signal.
        const pendingId = randomUUID()
        // Task 10 round-5 Fix 3: generated once, here, and carried unchanged
        // through every future retry of this exact logical write (the same
        // `item` object is reused by flushQueue), so a retry after
        // timeout/disconnected is idempotent server-side.
        const client_write_id = randomUUID()
        const item = { pendingId, client_write_id, ...request }
        insertPendingWrite(db, item)
        queue.push(item)
        return { status: 'queued' }
      }
      return performWrite({ client_write_id: randomUUID(), ...request })
    },
    onOpApplied(callback) {
      opAppliedListeners.push(callback)
    },
    onOpConflict(callback) {
      opConflictListeners.push(callback)
    },
    getQueuedOps() {
      return queue.slice()
    },
    async flushQueue() {
      if (!authenticated) {
        if (!ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING)) {
          connect()
        }
        await waitForReconnect()
      }
      // Gate on `authenticated`, not just `connected`: a socket can be open
      // but not yet authenticated (fresh client before loginRemote resolves,
      // or a reconnect whose `authenticate` send hasn't happened yet).
      // Attempting acquireLockRemote/submitOpRemote against an
      // open-but-unauthenticated connection hits the same silent-ignore /
      // 10s-timeout hang this fix addresses in write(). Leave queued items
      // in place for the next flushQueue() call in that case.
      if (!authenticated) return

      // Task 10 round-4 Fix 2a: previously this discarded performWrite's
      // result entirely and unconditionally removed every queued item, so a
      // 'timeout'/'disconnected'/'error'/re-'conflict' outcome on flush was
      // silently thrown away with no retry and no signal to the caller.
      const items = queue.slice()
      for (const item of items) {
        const result = await performWrite(item)

        if (result.status === 'applied' || result.status === 'conflict') {
          // 'applied': the write genuinely succeeded — done.
          // 'conflict': not a failure to retry — submitOpRemote (inside
          // performWrite) already ran this through the normal op_conflict
          // path, which calls notifyOpConflict and persists it via
          // recordConflict on the message handler above, so it's already
          // surfaced through the existing conflict-notification mechanism.
          // Retrying the same stale write would be wrong; it's done being
          // "queued" and is now a pending conflict instead.
          const index = queue.findIndex((q) => q.pendingId === item.pendingId)
          if (index !== -1) queue.splice(index, 1)
          deletePendingWrite(db, item.pendingId)
          continue
        }

        // Task 10 round-5 Fix 2: lock contention is transient (another
        // device merely held the lock at this instant) and, unlike a genuine
        // 'conflict', was never surfaced through submitOpRemote/op_conflict —
        // submitOpRemote never even ran. Do NOT drop the item: leave it in
        // the queue (and in the durable pending_writes table) so the next
        // flushQueue() pass retries it, exactly like 'timeout'/'disconnected'.
        // It's item-specific (the lock may already be free for the next
        // item), so keep trying the rest of this batch rather than aborting.
        if (result.status === 'lock_contention') continue

        // 'timeout' / 'disconnected' / 'error' (or any future unrecognized
        // status): do NOT silently drop the item. Leave it in the queue so
        // the next flushQueue() call retries it. A connectivity failure
        // ('timeout'/'disconnected') means every remaining item in this
        // batch will fail the same way, so stop this pass early rather than
        // hammering a dead connection with one lock/submit round-trip per
        // item; an 'error' is item-specific, so keep trying the rest.
        if (result.status === 'timeout' || result.status === 'disconnected') break
      }
    },
    async waitUntilConnected() {
      await connectedPromise
    },
    async loginRemote({ name, pin }) {
      if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
        return { status: 'disconnected' }
      }
      const reply = await sendLoginRemote({ name, pin })
      if (reply.status === 'disconnected' || reply.status === 'timeout') return reply
      if (reply.type === 'login_ok') {
        token = reply.token
        ws.send(JSON.stringify({ type: 'authenticate', token, device_id }))
        authenticated = true
        return { status: 'ok', token: reply.token, userId: reply.userId, role: reply.role }
      }
      // login_failed
      return reply.locked
        ? { status: 'failed', locked: true, retryAfterMs: reply.retryAfterMs }
        : { status: 'failed' }
    },
    close() {
      if (ws) ws.close()
    },
    // test-only accessor: exposes the underlying ws connection so tests can
    // simulate malformed/malicious server messages or abrupt disconnects.
    __getWs() {
      return ws
    },
  }
}
