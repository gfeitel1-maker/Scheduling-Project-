// Test-only: real SQLite devices with real device identities, each knowing every other device in
// its own `devices` registry (the trust source punchGossip.js / punchSignaling.js read), plus bare
// libp2p nodes running the REAL authGate so "admitted" means what it means in production.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { peerIdFromString } from '@libp2p/peer-id'
import { openLocalDb } from '../electron/db/localDb.js'
import { ensureDeviceIdentity } from '../electron/auth/deviceIdentity.js'
import { createEmptyDoc } from '../electron/automerge/campDocument.js'
import { registerAuthGate } from '../electron/sync/automerge/authGate.js'
import { AUTH_PROTO, sendFramed } from '../electron/sync/automerge/wireProtocol.js'

export const CAMP_ID = 'camp-1'
const files = []

export async function makeDevice(deviceId) {
  const f = path.join(os.tmpdir(), `shoresh-rung2-${deviceId}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'Camp One')
  const identity = await ensureDeviceIdentity(db)
  return { deviceId, db, identity, peerId: identity.peerId }
}

// Every listed device learns every listed device (itself included) as authorized, bound to its
// real peer id.
export function registerAll(devices) {
  for (const me of devices) {
    for (const other of devices) {
      me.db
        .prepare("INSERT INTO devices (id, name, authorized_at, pairing_status, libp2p_peer_id) VALUES (?, ?, ?, 'authorized', ?)")
        .run(other.deviceId, other.deviceId, new Date().toISOString(), other.peerId)
    }
  }
}

export function revokeOn(db, deviceId) {
  db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), deviceId)
}

export function freshCampDoc() {
  return createEmptyDoc()
}

// A bare libp2p node (tcp+noise+yamux) with the real authGate registered. `onAuthenticate` admits
// any peer whose id is in `allow`, so a test controls who the gate would admit.
export async function makeGatedNode(device, { allow = [], extraTransports = [], listen = ['/ip4/127.0.0.1/tcp/0'] } = {}) {
  const node = await createLibp2p({
    privateKey: device.identity.privateKey,
    addresses: { listen },
    transports: [tcp(), ...extraTransports],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: { inboundConnectionThreshold: 100 },
  })
  const allowed = new Set(allow)
  const { authenticatedPeers: admitted } = registerAuthGate(node, {
    onAuthenticate: async (_msg, { fromPeerId }) => (allowed.has(fromPeerId) ? { ok: true } : { ok: false, reason: 'not_allowed' }),
  })
  return { node, admitted, allowed, device }
}

// `from` authenticates to `to` over the real auth protocol; resolves once `to` has admitted it.
export async function authenticateTo(from, to) {
  const target = peerIdFromString(to.node.peerId.toString())
  await from.node.dial(to.node.getMultiaddrs()[0])
  const stream = await from.node.dialProtocol(target, AUTH_PROTO, { runOnLimitedConnection: true })
  await sendFramed(stream, new TextEncoder().encode(JSON.stringify({ type: 'authenticate', token: 'x', device_id: from.device.deviceId })))
  const start = Date.now()
  while (!to.admitted.has(from.node.peerId.toString()) && to.allowed.has(from.node.peerId.toString())) {
    if (Date.now() - start > 5000) throw new Error('authenticateTo: timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

export function cleanupDevices(devices) {
  for (const d of devices) {
    try { d.db.close() } catch { /* already closed */ }
  }
  for (const f of files.splice(0)) if (fs.existsSync(f)) fs.unlinkSync(f)
}
