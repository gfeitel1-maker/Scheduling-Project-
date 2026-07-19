import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { appendOp } from '../ops/operations.js'

export function createSyncClient(db, { device_id, author_user_id, serverUrl, token }) {
  const opAppliedListeners = []
  const queue = []

  function notifyOpApplied(op) {
    for (const listener of opAppliedListeners) listener(op)
  }

  if (!serverUrl) {
    return {
      async write({ entity, entity_id, field, value }) {
        const op = appendOp(db, {
          entity,
          entity_id,
          field,
          value,
          author_user_id,
          device_id,
          parent_op_id: null,
        })
        notifyOpApplied(op)
        return { status: 'applied', op }
      },
      onOpApplied(callback) {
        opAppliedListeners.push(callback)
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

  function applyRemoteOp(op) {
    db.prepare(
      `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).run(op.id, op.entity, op.entity_id, op.field, op.value, op.author_user_id ?? null, op.device_id, op.timestamp, op.parent_op_id ?? null)
  }

  function connect() {
    ws = new WebSocket(serverUrl)

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'authenticate', token, device_id }))
      connected = true
      connectedResolve()
    })

    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }

      if (msg.type === 'lock_result') {
        const resolve = lockResolvers.shift()
        if (resolve) resolve(msg)
        return
      }

      if (msg.type === 'op_applied') {
        applyRemoteOp(msg.op)
        notifyOpApplied(msg.op)
        if (msg.op.device_id === device_id) {
          const resolve = submitResolvers.shift()
          if (resolve) resolve(msg)
        }
        return
      }

      if (msg.type === 'op_conflict') {
        const resolve = submitResolvers.shift()
        if (resolve) resolve(msg)
      }
    })

    ws.on('error', () => {
      // connection failures surface via 'close'; swallow here to avoid an unhandled error event
    })

    ws.on('close', () => {
      connected = false
      connectedPromise = new Promise((resolve) => {
        connectedResolve = resolve
      })
    })
  }

  connect()

  function acquireLockRemote(entity, entity_id, field) {
    return new Promise((resolve) => {
      lockResolvers.push(resolve)
      ws.send(JSON.stringify({ type: 'acquire_lock', entity, entity_id, field }))
    })
  }

  function submitOpRemote(op) {
    return new Promise((resolve) => {
      submitResolvers.push(resolve)
      ws.send(JSON.stringify({ type: 'submit_op', op }))
    })
  }

  async function performWrite({ entity, entity_id, field, value }) {
    const lockResult = await acquireLockRemote(entity, entity_id, field)
    if (!lockResult.granted) {
      return { status: 'conflict' }
    }

    const op = { entity, entity_id, field, value, author_user_id, parent_op_id: null }
    const submitResult = await submitOpRemote(op)
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

      const items = queue.slice()
      for (const item of items) {
        await performWrite(item)
        const index = queue.findIndex((q) => q.pendingId === item.pendingId)
        if (index !== -1) queue.splice(index, 1)
      }
    },
    async waitUntilConnected() {
      await connectedPromise
    },
    close() {
      if (ws) ws.close()
    },
  }
}
