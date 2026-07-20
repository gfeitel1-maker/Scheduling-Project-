import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { appendOp, recordConflict } from '../ops/operations.js'
import { PROJECTIONS, applyProjection } from '../ops/projections.js'

const DEFAULT_RESOLVER_TIMEOUT_MS = 10000

export function createSyncClient(
  db,
  { device_id, author_user_id, serverUrl, token, lockTimeoutMs = DEFAULT_RESOLVER_TIMEOUT_MS, submitTimeoutMs = DEFAULT_RESOLVER_TIMEOUT_MS }
) {
  const opAppliedListeners = []
  const opConflictListeners = []
  const queue = []

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
  let connectedResolve
  let connectedPromise = new Promise((resolve) => {
    connectedResolve = resolve
  })
  const lockResolvers = []
  const submitResolvers = []

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
          `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        )
        .run(op.id, op.entity, op.entity_id, op.field, op.value, op.author_user_id ?? null, op.device_id, op.timestamp, op.parent_op_id ?? null)
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
      ws.send(JSON.stringify({ type: 'authenticate', token, device_id }))
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
    }

    ws.on('close', () => {
      connected = false
      connectedPromise = new Promise((resolve) => {
        connectedResolve = resolve
      })
      settlePendingOnDisconnect()
    })
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

  async function performWrite({ entity, entity_id, field, value, parent_op_id = null }) {
    const lockResult = await acquireLockRemote(entity, entity_id, field)
    if (lockResult.status === 'disconnected' || lockResult.status === 'timeout') {
      return { status: lockResult.status }
    }
    if (!lockResult.granted) {
      return { status: 'conflict' }
    }

    const op = { entity, entity_id, field, value, author_user_id, parent_op_id }
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
      if (!connected) {
        const pendingId = randomUUID()
        queue.push({ pendingId, ...request })
        return { status: 'queued' }
      }
      return performWrite(request)
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
      if (!connected) {
        if (!ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING)) {
          connect()
        }
        await waitForReconnect()
      }
      if (!connected) return

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
          continue
        }

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
