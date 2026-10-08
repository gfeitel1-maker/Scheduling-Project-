// @vitest-environment node
// S3 / Rung 2 end to end (docs/adr/2026-10-08-relayless-cross-network-reconnect.md): A and B have
// NO direct libp2p link and share only an admitted camp peer C. A learns B's address from the
// camp-document gossip, signals the punch THROUGH C, and the real node-datachannel punch completes
// over loopback with Noise + the libp2p upgrader running unchanged on top.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'
import { signMessageWithDeviceKey } from '../../automerge/authorityLogSignature.js'
import { makeDevice, registerAll, revokeOn, makeGatedNode, authenticateTo, freshCampDoc, cleanupDevices, CAMP_ID } from './punchRung2TestSupport.js'
import { createPunchSignaling } from './punchSignaling.js'
import { publishReflexive, readReflexive, deviceRegistryFromDb } from './punchGossip.js'
import { attemptRung2 } from './punchRung2.js'
import { punchTransport } from './punchTransport.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const LISTEN = ['/ip4/127.0.0.1/tcp/0', '/ip4/127.0.0.1/udp/0']
const CANDIDATE = '/ip4/127.0.0.1/udp/9'

let devices = []
let nodes = []
let sigs = []

afterEach(async () => {
  for (const s of sigs) await s.stop().catch(() => {})
  for (const n of nodes) await n.node.stop().catch(() => {})
  nodes = []
  sigs = []
  cleanupDevices(devices)
})

function lazyChannel() {
  const handlers = new Set()
  let real = null
  return {
    bind(channel) {
      real = channel
      for (const h of handlers) real.onSignal(h)
    },
    sendSignal: (msg) => real.sendSignal(msg),
    onSignal(cb) {
      handlers.add(cb)
      const unsub = real?.onSignal(cb)
      return () => { handlers.delete(cb); unsub?.() }
    },
  }
}

async function buildCamp() {
  const [a, b, c] = await Promise.all(['device-a', 'device-b', 'device-c'].map(makeDevice))
  devices = [a, b, c]
  registerAll(devices)
  const chanToB = lazyChannel()
  const chanToA = lazyChannel()
  const na = await makeGatedNode(a, { listen: LISTEN, extraTransports: [punchTransport({ signaling: chanToB, role: 'offerer' })] })
  const nb = await makeGatedNode(b, { listen: LISTEN, extraTransports: [punchTransport({ signaling: chanToA, role: 'answerer' })] })
  const nc = await makeGatedNode(c)
  nodes = [na, nb, nc]
  nc.allowed.add(a.peerId); nc.allowed.add(b.peerId)
  na.allowed.add(c.peerId); nb.allowed.add(c.peerId)
  await authenticateTo(na, nc); await authenticateTo(nc, na)
  await authenticateTo(nb, nc); await authenticateTo(nc, nb)
  const mk = async (n) => {
    const s = createPunchSignaling({
      node: n.node,
      selfDeviceId: n.device.deviceId,
      isAdmitted: (p) => n.admitted.has(p),
      registry: deviceRegistryFromDb(n.device.db),
      sign: (m) => signMessageWithDeviceKey(n.device.db, m),
    })
    await s.start()
    sigs.push(s)
    return s
  }
  const [sa, sb] = [await mk(na), await mk(nb)]
  await mk(nc)
  chanToB.bind(sa.channelTo('device-b'))
  chanToA.bind(sb.channelTo('device-a'))
  return { a, b, c, na, nb, nc, sa, sb }
}

const entriesFor = (dev, doc) => () => readReflexive(doc, { campId: CAMP_ID, registry: deviceRegistryFromDb(dev.db) })

describe('attemptRung2', () => {
  it('A and B, sharing only an admitted C, complete a real punch over loopback', async () => {
    const { a, b, na, nb, sa } = await buildCamp()
    expect(na.node.getPeers().map(String)).not.toContain(b.peerId)
    const doc = publishReflexive(freshCampDoc(), b.db, { campId: CAMP_ID, deviceId: 'device-b', peerId: b.peerId, candidates: [CANDIDATE] })

    const result = await attemptRung2({
      peerDeviceId: 'device-b',
      readEntries: entriesFor(a, doc),
      signaling: sa,
      dial: (addr) => na.node.dial(multiaddr(addr)),
    })

    expect(result).toEqual({ ok: true, candidate: CANDIDATE })
    const conns = na.node.getConnections(peerIdFromString(b.peerId))
    expect(conns.length).toBeGreaterThan(0)
    expect(conns[0].remoteAddr.toString()).toContain('/udp/')
    const start = Date.now()
    while (nb.node.getConnections(peerIdFromString(a.peerId)).length === 0) {
      if (Date.now() - start > 10000) throw new Error('B never saw the punched connection')
      await new Promise((r) => setTimeout(r, 20))
    }
  }, 60000)

  it('with no verified gossip entry for the peer: { ok: false, reason: no-gossip-entry }', async () => {
    const { a, sa } = await buildCamp()
    const doc = freshCampDoc()
    const r = await attemptRung2({ peerDeviceId: 'device-b', readEntries: entriesFor(a, doc), signaling: sa, dial: async () => { throw new Error('must not dial') } })
    expect(r).toEqual({ ok: false, reason: 'no-gossip-entry' })
  }, 30000)

  it('a revoked device\'s gossip is ignored: no dial is attempted', async () => {
    const { a, b, sa } = await buildCamp()
    const doc = publishReflexive(freshCampDoc(), b.db, { campId: CAMP_ID, deviceId: 'device-b', peerId: b.peerId, candidates: [CANDIDATE] })
    revokeOn(a.db, 'device-b')
    let dialed = 0
    const r = await attemptRung2({ peerDeviceId: 'device-b', readEntries: entriesFor(a, doc), signaling: sa, dial: async () => { dialed++ } })
    expect(r).toEqual({ ok: false, reason: 'no-gossip-entry' })
    expect(dialed).toBe(0)
  }, 30000)

  it('with gossip but no signalling route: { ok: false, reason: no-signal-route }', async () => {
    const { a, b, na, sa } = await buildCamp()
    const doc = publishReflexive(freshCampDoc(), b.db, { campId: CAMP_ID, deviceId: 'device-b', peerId: b.peerId, candidates: [CANDIDATE] })
    for (const p of na.node.getPeers()) await na.node.hangUp(p)
    let dialed = 0
    const r = await attemptRung2({ peerDeviceId: 'device-b', readEntries: entriesFor(a, doc), signaling: sa, dial: async () => { dialed++ } })
    expect(r).toEqual({ ok: false, reason: 'no-signal-route' })
    expect(dialed).toBe(0)
  }, 30000)

  it('when every candidate fails to dial: { ok: false, reason: dial-failed }', async () => {
    const { a, b, sa } = await buildCamp()
    const doc = publishReflexive(freshCampDoc(), b.db, { campId: CAMP_ID, deviceId: 'device-b', peerId: b.peerId, candidates: [CANDIDATE, '/ip4/127.0.0.1/udp/10'] })
    const tried = []
    const r = await attemptRung2({ peerDeviceId: 'device-b', readEntries: entriesFor(a, doc), signaling: sa, dial: async (addr) => { tried.push(addr); throw new Error('unreachable') } })
    expect(r).toEqual({ ok: false, reason: 'dial-failed' })
    expect(tried).toHaveLength(2)
  }, 30000)
})

describe('rung 2 never contacts rung 3', () => {
  it('none of the rung-2 modules reference the rendezvous client', () => {
    for (const f of ['punchGossip.js', 'punchSignaling.js', 'punchRung2.js']) {
      expect(fs.readFileSync(path.join(here, f), 'utf8')).not.toMatch(/rendezvousClient/)
    }
  })
})
