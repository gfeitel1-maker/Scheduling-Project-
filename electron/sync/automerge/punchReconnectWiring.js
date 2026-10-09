// S4c: the production callers for the reconnect ladder, assembled in one place so syncStarter.js only
// has to call it from inside its strict SHORESH_PUNCH_ENABLED === 'true' block. Nothing imports this
// module otherwise. It builds the persisted stores, the punch-signal protocol on admitted connections,
// the reconnect coordinator, and the publishing of this device's own public reflexive candidates into
// the camp document (rung 2's gossip).
import { join } from 'node:path'
import { signMessageWithDeviceKey } from '../../automerge/authorityLogSignature.js'
import { EVENTS } from './connectivityEvents.js'
import { createReconnectCoordinator } from './reconnectCoordinator.js'
import { attemptRung1 } from './punchRung1.js'
import { attemptRung2 } from './punchRung2.js'
import { createPunchSignaling, createReplayStore } from './punchSignaling.js'
import { createHighWaterStore, deviceRegistryFromDb, publishReflexive, readReflexive } from './punchGossip.js'
import { listTrustedRememberedAddresses } from './peerAddressBook.js'
import { ownReflexiveMultiaddrs } from './punchIdentity.js'
import { publicRecordAddresses } from './rendezvousClient.js'

export const GOSSIP_REPUBLISH_MS = 4 * 60 * 1000
const LAN_WAIT_MS = 4_000

// The punch transport owns ONE signaling channel for its lifetime, but a signal always belongs to one
// remote device. Outbound sends go to the explicitly bound target (rung 2 binds it before dialing);
// every trusted device's inbound signals are delivered to the transport, and the latest sender
// becomes the target so an answerer replies to whoever offered.
export function createRoutedSignalChannel() {
  const subs = new Set()
  const attached = new Map()
  let target = null
  return {
    sendSignal: (msg) => (target ? target.sendSignal(msg) : Promise.reject(new Error('punch: no signal target'))),
    onSignal(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    bind(channel) { target = channel },
    attach(deviceId, channel) {
      if (attached.has(deviceId)) return
      attached.set(deviceId, channel.onSignal((msg) => {
        target = channel
        for (const cb of subs) cb(msg)
      }))
    },
    detachAll() {
      for (const off of attached.values()) off()
      attached.clear()
      subs.clear()
    },
  }
}

export async function wirePunchReconnect({
  db, deviceId, campId, userDataPath, node, channel, getTransport, getUpgrader, rendezvous, emit,
  getDoc, setDoc, republishMs = GOSSIP_REPUBLISH_MS, coordinatorOptions = {},
}) {
  const registry = deviceRegistryFromDb(db)
  const highWater = createHighWaterStore({ filePath: join(userDataPath, 'punch-gossip-highwater.json'), onError: () => emit(EVENTS.PUNCH_STORE_FAILED, { store: 'high-water' }) })
  const replayStore = createReplayStore({ filePath: join(userDataPath, 'punch-signal-replay.json'), onError: () => emit(EVENTS.PUNCH_STORE_FAILED, { store: 'replay' }) })
  const isConnected = (peerId) => node.getPeers().includes(peerId)

  let signaling = null
  if (node.libp2pNode) {
    signaling = createPunchSignaling({
      node: node.libp2pNode,
      selfDeviceId: deviceId,
      isAdmitted: (peerId) => node.isPeerAuthenticated(peerId),
      registry,
      sign: (message) => signMessageWithDeviceKey(db, message),
      replayStore,
      emit,
    })
    await signaling.start()
  }

  const listPeers = () => db.prepare('SELECT id, libp2p_peer_id FROM devices WHERE libp2p_peer_id IS NOT NULL AND id != ?').all(deviceId)
    .filter((row) => registry.peerIdForDevice(row.id) != null)
    .map((row) => ({ peerId: row.libp2p_peer_id, deviceId: row.id }))

  function attachInbound() {
    if (!signaling) return
    for (const peer of listPeers()) channel.attach(peer.deviceId, signaling.channelTo(peer.deviceId))
  }
  attachInbound()

  async function attemptLan(peer) {
    const remembered = listTrustedRememberedAddresses(db).filter((r) => r.peerId === peer.peerId)
    await Promise.allSettled(remembered.map((r) => node.dial(r.multiaddr)))
    await new Promise((resolve) => setTimeout(resolve, remembered.length ? LAN_WAIT_MS : 0).unref?.())
    return isConnected(peer.peerId)
  }

  const coordinator = createReconnectCoordinator({
    listPeers,
    isConnected,
    attemptLan,
    attemptRung1: (peer) => {
      const transport = getTransport()
      const upgrader = getUpgrader()
      if (!transport || !upgrader) throw new Error('punch transport not ready')
      return attemptRung1(peer, { db, transport, upgrader })
    },
    attemptRung2: (peer) => {
      if (!signaling) throw new Error('punch signaling not ready')
      return attemptRung2({
        peerDeviceId: peer.deviceId,
        readEntries: (hw) => readReflexive(getDoc(), { campId, registry, highWater: hw }),
        signaling,
        bindChannel: (ch) => channel.bind(ch),
        dial: (addr) => node.dial(addr),
        highWater,
        emit,
      })
    },
    rendezvous,
    emit,
    ...coordinatorOptions,
  })

  let lastPublished = 0
  function publishOwnReflexive() {
    try {
      const candidates = publicRecordAddresses(ownReflexiveMultiaddrs(db))
      if (candidates.length === 0 || node.getPeers().length === 0) return
      const peerId = node.peerId
      setDoc(publishReflexive(getDoc(), db, { campId, deviceId, peerId, candidates }))
      lastPublished = Date.now()
      node.broadcastLocalDoc?.()
    } catch (err) {
      console.warn(`punch: could not publish this device's reflexive address to the camp (${err?.message ?? err})`)
    }
  }

  node.onPeersChanged?.(() => {
    attachInbound()
    for (const peer of listPeers()) if (isConnected(peer.peerId)) coordinator.peerConnected(peer.peerId)
    if (Date.now() - lastPublished >= republishMs) publishOwnReflexive()
    coordinator.notifyPeersChanged()
  })
  const republishTimer = setInterval(publishOwnReflexive, republishMs)
  republishTimer.unref?.()
  coordinator.start()

  return {
    coordinator,
    publishOwnReflexive,
    async stop() {
      clearInterval(republishTimer)
      coordinator.stop()
      channel.detachAll()
      await signaling?.stop().catch(() => {})
    },
  }
}
