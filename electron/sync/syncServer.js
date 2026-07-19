import { WebSocketServer } from 'ws'
import { verifySessionToken } from '../auth/localAuth.js'
import { acquireLock, expireLocks } from './lockManager.js'
import { detectConflict, appendOp } from '../ops/operations.js'

function send(ws, message) {
  ws.send(JSON.stringify(message))
}

function handleAuthenticate(ws, msg) {
  const verified = verifySessionToken(msg.token)
  if (!verified || verified.deviceId !== msg.device_id) {
    ws.close()
    return
  }
  ws.deviceId = verified.deviceId
  ws.userId = verified.userId
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
  const { conflict, existingOp } = detectConflict(db, incomingOp)
  if (conflict) {
    send(ws, { type: 'op_conflict', incomingOp, existingOp })
    return
  }
  const op = appendOp(db, incomingOp)
  for (const client of wss.clients) {
    if (client.deviceId) {
      send(client, { type: 'op_applied', op })
    }
  }
}

export function startSyncServer(db, { port }) {
  const wss = new WebSocketServer({ port })

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }

      if (msg.type === 'authenticate') {
        handleAuthenticate(ws, msg)
        return
      }

      if (!ws.deviceId) return

      if (msg.type === 'acquire_lock') {
        handleAcquireLock(db, ws, msg)
      } else if (msg.type === 'submit_op') {
        handleSubmitOp(db, wss, ws, msg)
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
