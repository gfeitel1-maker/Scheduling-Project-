// @vitest-environment node
// S3 / Rung 2 signaling (docs/adr/2026-10-08-relayless-cross-network-reconnect.md): SDP/candidate
// exchange over /shoresh/punch-signal/1, direct or forwarded by one admitted camp peer, with the
// envelope signed by the origin device and verified at the destination.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { peerIdFromString } from '@libp2p/peer-id'
import { signMessageWithDeviceKey } from '../../automerge/authorityLogSignature.js'
import { decode } from 'it-length-prefixed'
import { sendFramed } from './wireProtocol.js'
import { makeDevice, registerAll, revokeOn, makeGatedNode, authenticateTo, cleanupDevices } from '../../../test/punchRung2Support.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encode } from 'it-length-prefixed'
import { EVENTS } from './connectivityEvents.js'
import { createPunchSignaling, createReplayStore, MAX_SKEW_MS, canonicalEnvelope, PUNCH_SIGNAL_PROTO, MAX_FRAME_BYTES } from './punchSignaling.js'
import { deviceRegistryFromDb } from './punchGossip.js'

const SID = 'a'.repeat(32)
const OFFER = { type: 'offer', sid: SID, sdp: 'v=0 original-sdp' }
const enc = (o) => new TextEncoder().encode(JSON.stringify(o))

let devices, nodes, sigs
async function setup(ids, nodeOpts = {}) {
  devices = await Promise.all(ids.map((id) => makeDevice(id)))
  registerAll(devices)
  nodes = {}
  for (const d of devices) nodes[d.deviceId] = await makeGatedNode(d, nodeOpts[d.deviceId])
  sigs = {}
}
async function startSignaling(id, limits) {
  const n = nodes[id]
  const s = createPunchSignaling({
    node: n.node,
    selfDeviceId: id,
    isAdmitted: (peerId) => n.admitted.has(peerId),
    registry: deviceRegistryFromDb(n.device.db),
    sign: (m) => signMessageWithDeviceKey(n.device.db, m),
    limits,
  })
  await s.start()
  sigs[id] = s
  return s
}
function listen(id, from) {
  const got = []
  sigs[id].channelTo(from).onSignal((m) => got.push(m))
  return got
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred, ms = 5000) {
  const t = Date.now()
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const dev = (id) => devices.find((d) => d.deviceId === id)
async function rawFrame(fromId, toId, frame) {
  const stream = await nodes[fromId].node.dialProtocol(peerIdFromString(dev(toId).peerId), PUNCH_SIGNAL_PROTO, { runOnLimitedConnection: true })
  await sendFramed(stream, typeof frame === 'string' ? new TextEncoder().encode(frame) : frame instanceof Uint8Array ? frame : enc(frame))
  await stream.close().catch(() => {})
}
function signedEnv(fromId, toId, msg, over = {}) {
  const env = { id: Math.random().toString(16).slice(2).padEnd(32, '0'), from: fromId, to: toId, ts: Date.now(), payload: JSON.stringify(msg), ...over }
  env.sig = signMessageWithDeviceKey(dev(fromId).db, canonicalEnvelope(env))
  return env
}

afterEach(async () => {
  for (const s of Object.values(sigs ?? {})) await s.stop().catch(() => {})
  for (const n of Object.values(nodes ?? {})) await n.node.stop().catch(() => {})
  cleanupDevices(devices ?? [])
})

describe('punchSignaling: direct', () => {
  beforeEach(async () => {
    await setup(['device-a', 'device-b'], { 'device-a': { allow: [] }, 'device-b': { allow: [] } })
  })

  it('delivers a signed signal between mutually admitted peers', async () => {
    nodes['device-b'].allowed.add(dev('device-a').peerId)
    nodes['device-a'].allowed.add(dev('device-b').peerId)
    await authenticateTo(nodes['device-a'], nodes['device-b'])
    await authenticateTo(nodes['device-b'], nodes['device-a'])
    await startSignaling('device-a')
    await startSignaling('device-b')
    const got = listen('device-b', 'device-a')
    await sigs['device-a'].channelTo('device-b').sendSignal(OFFER)
    await waitFor(() => got.length === 1)
    expect(got[0]).toEqual(OFFER)
  }, 30000)

  it('a NON-admitted peer cannot open the signal protocol: nothing is delivered', async () => {
    nodes['device-a'].allowed.add(dev('device-b').peerId)
    await authenticateTo(nodes['device-b'], nodes['device-a'])
    await nodes['device-a'].node.dial(nodes['device-b'].node.getMultiaddrs()[0])
    await startSignaling('device-a')
    await startSignaling('device-b')
    const got = listen('device-b', 'device-a')
    expect(nodes['device-b'].admitted.has(dev('device-a').peerId)).toBe(false)
    await sigs['device-a'].channelTo('device-b').sendSignal(OFFER).catch(() => {})
    await rawFrame('device-a', 'device-b', { v: 1, relayed: false, env: signedEnv('device-a', 'device-b', OFFER) }).catch(() => {})
    await settle()
    expect(got).toEqual([])
  }, 30000)

  it('an admitted peer whose device is REVOKED in the local registry is refused', async () => {
    nodes['device-b'].allowed.add(dev('device-a').peerId)
    nodes['device-a'].allowed.add(dev('device-b').peerId)
    await authenticateTo(nodes['device-a'], nodes['device-b'])
    await authenticateTo(nodes['device-b'], nodes['device-a'])
    await startSignaling('device-a')
    await startSignaling('device-b')
    const got = listen('device-b', 'device-a')
    revokeOn(dev('device-b').db, 'device-a')
    await sigs['device-a'].channelTo('device-b').sendSignal(OFFER).catch(() => {})
    await settle()
    expect(got).toEqual([])
  }, 30000)

  it('rejects an envelope whose signature does not match the claimed origin, and a replay of a good one', async () => {
    nodes['device-b'].allowed.add(dev('device-a').peerId)
    nodes['device-a'].allowed.add(dev('device-b').peerId)
    await authenticateTo(nodes['device-a'], nodes['device-b'])
    await authenticateTo(nodes['device-b'], nodes['device-a'])
    await startSignaling('device-a')
    await startSignaling('device-b')
    const got = listen('device-b', 'device-a')

    const forged = signedEnv('device-a', 'device-b', OFFER)
    forged.sig = signMessageWithDeviceKey(dev('device-b').db, canonicalEnvelope(forged))
    await rawFrame('device-a', 'device-b', { v: 1, relayed: false, env: forged })

    const stale = signedEnv('device-a', 'device-b', OFFER, { ts: Date.now() - 10 * 60 * 1000 })
    await rawFrame('device-a', 'device-b', { v: 1, relayed: false, env: stale })
    await settle()
    expect(got).toEqual([])

    const good = signedEnv('device-a', 'device-b', OFFER)
    await rawFrame('device-a', 'device-b', { v: 1, relayed: false, env: good })
    await rawFrame('device-a', 'device-b', { v: 1, relayed: false, env: good })
    await waitFor(() => got.length >= 1)
    await settle()
    expect(got.length).toBe(1)
  }, 30000)

  it('bounds oversize frames and floods, and keeps serving afterwards', async () => {
    nodes['device-b'].allowed.add(dev('device-a').peerId)
    nodes['device-a'].allowed.add(dev('device-b').peerId)
    await authenticateTo(nodes['device-a'], nodes['device-b'])
    await authenticateTo(nodes['device-b'], nodes['device-a'])
    await startSignaling('device-a')
    await startSignaling('device-b', { rateMax: 5, rateWindowMs: 60_000 })
    const got = listen('device-b', 'device-a')

    await rawFrame('device-a', 'device-b', new Uint8Array(MAX_FRAME_BYTES * 4).fill(65)).catch(() => {})
    await rawFrame('device-a', 'device-b', { v: 1, relayed: false, env: signedEnv('device-a', 'device-b', { type: 'offer', sid: SID, sdp: 'x'.repeat(40_000) }) }).catch(() => {})
    await rawFrame('device-a', 'device-b', { v: 1, relayed: false, pad: 'x'.repeat(MAX_FRAME_BYTES * 3), env: signedEnv('device-a', 'device-b', OFFER) }).catch(() => {})
    await settle()
    expect(got).toEqual([])

    await sigs['device-a'].channelTo('device-b').sendSignal(OFFER)
    for (let i = 0; i < 30; i++) await sigs['device-a'].channelTo('device-b').sendSignal({ type: 'candidate', sid: SID, candidate: `c${i}`, mid: '0' }).catch(() => {})
    await settle(600)
    expect(got.length).toBeGreaterThan(0)
    expect(got.length).toBeLessThanOrEqual(5)
  }, 30000)

  it('sendSignal refuses to send a payload over the size cap', async () => {
    nodes['device-a'].allowed.add(dev('device-b').peerId)
    await startSignaling('device-a')
    await expect(sigs['device-a'].channelTo('device-b').sendSignal({ type: 'offer', sid: SID, sdp: 'x'.repeat(60_000) })).rejects.toThrow(/size/)
  }, 30000)

  it('rejects sending when there is no route to the destination', async () => {
    await startSignaling('device-a')
    await expect(sigs['device-a'].channelTo('device-b').sendSignal(OFFER)).rejects.toThrow(/no route/)
  }, 30000)
})

describe('punchSignaling: forwarded by a shared admitted peer C', () => {
  beforeEach(async () => {
    await setup(['device-a', 'device-b', 'device-c'])
    const [a, b, c] = ['device-a', 'device-b', 'device-c'].map((id) => nodes[id])
    c.allowed.add(dev('device-a').peerId); c.allowed.add(dev('device-b').peerId)
    a.allowed.add(dev('device-c').peerId); b.allowed.add(dev('device-c').peerId)
    await authenticateTo(a, c); await authenticateTo(c, a)
    await authenticateTo(b, c); await authenticateTo(c, b)
  })

  it('A reaches B with no A-B link, via C, and B accepts it as A\'s signed signal', async () => {
    for (const id of ['device-a', 'device-b', 'device-c']) await startSignaling(id)
    expect(nodes['device-a'].node.getPeers().map(String)).not.toContain(dev('device-b').peerId)
    const got = listen('device-b', 'device-a')
    await sigs['device-a'].channelTo('device-b').sendSignal(OFFER)
    await waitFor(() => got.length === 1)
    expect(got[0]).toEqual(OFFER)
  }, 30000)

  it('C cannot alter a forwarded SDP: the origin signature fails at B', async () => {
    await startSignaling('device-a')
    await startSignaling('device-b')
    const cNode = nodes['device-c'].node
    let forwardedSeen = 0
    await cNode.handle(PUNCH_SIGNAL_PROTO, (stream) => {
      ;(async () => {
        for await (const chunk of decode(stream, { maxDataLength: 1 << 20 })) {
          const frame = JSON.parse(new TextDecoder().decode(chunk.subarray()))
          if (frame.probe) {
            await sendFramed(stream, enc({ v: 1, routable: true }))
            continue
          }
          forwardedSeen++
          frame.env.payload = frame.env.payload.replace('original-sdp', 'EVIL-sdp')
          frame.relayed = true
          await rawFrame('device-c', 'device-b', frame)
        }
      })().catch(() => {})
    }, { runOnLimitedConnection: true })
    const got = listen('device-b', 'device-a')
    await sigs['device-a'].channelTo('device-b').sendSignal(OFFER)
    await waitFor(() => forwardedSeen >= 1)
    await settle()
    expect(got).toEqual([])
  }, 30000)

  it('control: an unmodified relay of the same frame IS delivered', async () => {
    await startSignaling('device-a')
    await startSignaling('device-b')
    const got = listen('device-b', 'device-a')
    await rawFrame('device-c', 'device-b', { v: 1, relayed: true, env: signedEnv('device-a', 'device-b', OFFER) })
    await waitFor(() => got.length === 1)
    expect(got[0]).toEqual(OFFER)
  }, 30000)

  it('C forwards only for a non-revoked origin', async () => {
    for (const id of ['device-a', 'device-b', 'device-c']) await startSignaling(id)
    revokeOn(dev('device-c').db, 'device-a')
    const got = listen('device-b', 'device-a')
    await sigs['device-a'].channelTo('device-b').sendSignal(OFFER).catch(() => {})
    await settle()
    expect(got).toEqual([])
  }, 30000)

  it('hop limit 1: a frame already relayed is never forwarded again', async () => {
    for (const id of ['device-a', 'device-b', 'device-c']) await startSignaling(id)
    const got = listen('device-b', 'device-a')
    await rawFrame('device-a', 'device-c', { v: 1, relayed: true, env: signedEnv('device-a', 'device-b', OFFER) })
    await settle()
    expect(got).toEqual([])
  }, 30000)

  it('C does not forward a frame whose origin is not the peer that handed it over', async () => {
    for (const id of ['device-a', 'device-b', 'device-c']) await startSignaling(id)
    const got = listen('device-b', 'device-a')
    await rawFrame('device-b', 'device-c', { v: 1, relayed: false, env: signedEnv('device-a', 'device-b', OFFER) })
    await settle()
    expect(got).toEqual([])
  }, 30000)
})

describe('punchSignaling: route confirmation', () => {
  it('a relay admitted with the origin but NOT connected to the destination is no route, and nothing is sent through it', async () => {
    await setup(['device-a', 'device-b', 'device-c'])
    const [a, b, c] = ['device-a', 'device-b', 'device-c'].map((id) => nodes[id])
    c.allowed.add(dev('device-a').peerId); a.allowed.add(dev('device-c').peerId)
    await authenticateTo(a, c); await authenticateTo(c, a)
    for (const id of ['device-a', 'device-b', 'device-c']) await startSignaling(id)
    expect(c.node.getPeers().map(String)).not.toContain(dev('device-b').peerId)
    expect(await sigs['device-a'].hasRoute('device-b')).toBe(false)
    const got = listen('device-b', 'device-a')
    await expect(sigs['device-a'].channelTo('device-b').sendSignal(OFFER)).rejects.toThrow(/no route/)
    await settle()
    expect(got).toEqual([])
    expect(b.admitted.size).toBe(0)
  }, 30000)

  it('a relay that is connected to the destination but has not admitted it is no route', async () => {
    await setup(['device-a', 'device-b', 'device-c'])
    const [a, b, c] = ['device-a', 'device-b', 'device-c'].map((id) => nodes[id])
    c.allowed.add(dev('device-a').peerId); a.allowed.add(dev('device-c').peerId)
    await authenticateTo(a, c); await authenticateTo(c, a)
    await b.node.dial(c.node.getMultiaddrs()[0])
    await waitFor(() => c.node.getPeers().map(String).includes(dev('device-b').peerId))
    for (const id of ['device-a', 'device-b', 'device-c']) await startSignaling(id)
    expect(await sigs['device-a'].hasRoute('device-b')).toBe(false)
  }, 30000)
})

describe('punchSignaling: bounds and replay', () => {
  beforeEach(async () => {
    await setup(['device-a', 'device-b', 'device-c'], { 'device-a': { allow: [] }, 'device-b': { allow: [] }, 'device-c': { allow: [] } })
    for (const [x, y] of [['device-a', 'device-b'], ['device-c', 'device-b']]) {
      nodes[y].allowed.add(dev(x).peerId); nodes[x].allowed.add(dev(y).peerId)
      await authenticateTo(nodes[x], nodes[y]); await authenticateTo(nodes[y], nodes[x])
    }
  })

  it('rate-limits per ORIGIN, independently of the per-peer limit', async () => {
    await startSignaling('device-a')
    await startSignaling('device-b', { rateMax: 1000, originRateMax: 3, rateWindowMs: 60_000 })
    const got = listen('device-b', 'device-a')
    for (let i = 0; i < 10; i++) await rawFrame('device-a', 'device-b', { v: 1, relayed: false, env: signedEnv('device-a', 'device-b', { type: 'candidate', sid: SID, candidate: `c${i}`, mid: '0' }) })
    await settle(600)
    expect(got.length).toBe(3)
  }, 30000)

  it('replay is keyed on (from, id): the same id from a different origin is not blocked', async () => {
    await startSignaling('device-b')
    const fromA = listen('device-b', 'device-a')
    const fromC = listen('device-b', 'device-c')
    await rawFrame('device-a', 'device-b', { v: 1, relayed: false, env: signedEnv('device-a', 'device-b', OFFER, { id: 'shared-id' }) })
    await rawFrame('device-c', 'device-b', { v: 1, relayed: false, env: signedEnv('device-c', 'device-b', OFFER, { id: 'shared-id' }) })
    await waitFor(() => fromA.length === 1 && fromC.length === 1)
  }, 30000)

  it('a replay is still refused after the signaling instance is restarted (persisted store)', async () => {
    const file = path.join(os.tmpdir(), `punchreplay-${Date.now()}-${Math.random()}.json`)
    try {
      await startSignaling('device-b')
      await sigs['device-b'].stop()
      const node = nodes['device-b']
      const mk = async () => {
        const sig = createPunchSignaling({
          node: node.node, selfDeviceId: 'device-b', isAdmitted: (p) => node.admitted.has(p),
          registry: deviceRegistryFromDb(node.device.db), sign: (m) => signMessageWithDeviceKey(node.device.db, m),
          replayStore: createReplayStore({ filePath: file }),
        })
        await sig.start()
        sigs['device-b'] = sig
        return listen('device-b', 'device-a')
      }
      const frame = { v: 1, relayed: false, env: signedEnv('device-a', 'device-b', OFFER) }
      const first = await mk()
      await rawFrame('device-a', 'device-b', frame)
      await waitFor(() => first.length === 1)
      await sigs['device-b'].stop()
      const second = await mk()
      await rawFrame('device-a', 'device-b', frame)
      await settle()
      expect(second).toEqual([])
    } finally {
      fs.rmSync(file, { force: true })
    }
  }, 30000)

  it('a verified stale signal is refused AND surfaced as a CLOCK_SKEW event', async () => {
    const events = []
    const n = nodes['device-b']
    const sig = createPunchSignaling({
      node: n.node, selfDeviceId: 'device-b', isAdmitted: (p) => n.admitted.has(p),
      registry: deviceRegistryFromDb(n.device.db), sign: (m) => signMessageWithDeviceKey(n.device.db, m),
      emit: (name, f) => events.push([name, f]),
    })
    await sig.start()
    sigs['device-b'] = sig
    const got = listen('device-b', 'device-a')
    await rawFrame('device-a', 'device-b', { v: 1, relayed: false, env: signedEnv('device-a', 'device-b', OFFER, { ts: Date.now() - 10 * 60 * 1000 }) })
    await waitFor(() => events.length === 1)
    expect(events[0][0]).toBe(EVENTS.CLOCK_SKEW)
    expect(events[0][1].skewMs).toBeGreaterThan(MAX_SKEW_MS)
    expect(got).toEqual([])
  }, 30000)
})

describe('createReplayStore', () => {
  it('keeps an id only for the freshness window, and stays bounded', () => {
    let t = 1_000_000
    const store = createReplayStore({ max: 3, now: () => t })
    expect(store.remember('a', 'x', t)).toBe(true)
    expect(store.remember('a', 'x', t)).toBe(false)
    expect(store.remember('b', 'x', t)).toBe(true)
    t += MAX_SKEW_MS + 1
    expect(store.size()).toBe(0)
    for (let i = 0; i < 10; i++) store.remember('a', `id${i}`, t)
    expect(store.size()).toBe(3)
  })

  it('starts empty from a corrupt file', () => {
    const file = path.join(os.tmpdir(), `punchreplay-bad-${Date.now()}.json`)
    fs.writeFileSync(file, '{not json')
    try {
      expect(createReplayStore({ filePath: file }).remember('a', 'x', Date.now())).toBe(true)
    } finally {
      fs.rmSync(file, { force: true })
    }
  })
})

describe('punchSignaling: relay forward timeout', () => {
  it('aborts a forward whose onward dial never completes', async () => {
    devices = await Promise.all(['device-a', 'device-b', 'device-c'].map((id) => makeDevice(id)))
    registerAll(devices)
    nodes = {}
    sigs = {}
    const [a, b, c] = devices
    let handler
    let dialSignal
    const fakeNode = {
      getPeers: () => [{ toString: () => a.peerId }, { toString: () => b.peerId }],
      handle: async (_p, fn) => { handler = fn },
      unhandle: async () => {},
      dialProtocol: (_peer, _proto, opts) => { dialSignal = opts.signal; return new Promise(() => {}) },
    }
    const sig = createPunchSignaling({
      node: fakeNode, selfDeviceId: 'device-c', isAdmitted: () => true,
      registry: deviceRegistryFromDb(c.db), sign: (m) => signMessageWithDeviceKey(c.db, m),
      limits: { forwardTimeoutMs: 100 },
    })
    await sig.start()
    const env = signedEnv('device-a', 'device-b', OFFER)
    const bytes = encode.single(enc({ v: 1, relayed: false, env })).subarray()
    const stream = { async *[Symbol.asyncIterator]() { yield bytes }, abort() {} }
    handler(stream, { remotePeer: { toString: () => a.peerId } })
    await waitFor(() => dialSignal !== undefined)
    expect(dialSignal.aborted).toBe(false)
    await waitFor(() => dialSignal.aborted, 2000)
  }, 15000)
})
