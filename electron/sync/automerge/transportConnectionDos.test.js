// @vitest-environment node
//
// T340 precondition 1 (docs/adr/2026-10-08-max-connections-dos-mitigation.md): connection-manager
// DoS hardening, exercised against REAL libp2p nodes (no mock of the connection manager). Scale
// numbers (maxConnections, reservedFloor, deadline, pending cap) are passed through startTransport's
// options for speed; production defaults are the ADR numbers.
//
// HONEST GUARANTEE these tests pin, and no more:
// An ESTABLISHED admitted connection is never evicted by an un-admitted flood (hard guarantee — the
// floor). A RECONNECTING camp device regains a slot LIKELY within an authGate-deadline turnover cycle,
// but this is NOT guaranteed under a sustained distributed flood — it competes for the recycling
// un-admitted slots.
import net from 'node:net'
import { describe, it, expect, afterEach } from 'vitest'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { startTransport } from './transport.js'
import { AUTH_PROTO } from './wireProtocol.js'
import { peerIdFromString } from '@libp2p/peer-id'

let cleanups = []
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c().catch(() => {})))
  cleanups = []
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(predicate, { timeout = 4000, interval = 20 } = {}) {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await sleep(interval)
  }
}

const alwaysAdmit = () => ({ ok: true })

// Deadline for tests that must COMPLETE a handshake (auth or pairing_request) before it fires. A
// 300-400ms deadline raced the dial+Noise+yamux+auth round trip under CPU load: the (correct)
// deadline aborted the connection mid-handshake, a different test each run. The deadline is
// behaviour under test, so it is not mocked; it is just set well above a loaded handshake.
// Negative observations ("still open after the deadline") still need a real wait past it.
const HANDSHAKE_SAFE_DEADLINE_MS = 1500

async function startTarget(opts = {}) {
  const t = await startTransport({ deviceId: 'target', onAuthenticate: alwaysAdmit, inboundConnectionThreshold: 1000, ...opts })
  cleanups.push(() => t.stop())
  return t
}

async function startCamp(id) {
  const t = await startTransport({ deviceId: id, onAuthenticate: alwaysAdmit })
  cleanups.push(() => t.stop())
  return t
}

async function startAttacker() {
  const node = await createLibp2p({
    addresses: { listen: [] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  })
  cleanups.push(() => node.stop())
  return node
}

// Observed on the TARGET side: the DoS guarantee is that the target frees the slot. Under CPU load the
// attacker/joiner side was measured learning of the target's abort >3s late (instrumented: the deadline
// timer had fired on time), so attacker-side connection status is not the property under test.
const liveConns = (t, peerId) => t.libp2pNode.getConnections(peerIdFromString(peerId.toString())).filter((c) => c.status === 'open')
const openAttackerConns = (target, attackers) => attackers.filter((a) => liveConns(target, a.peerId).length > 0).length

async function flood(target, n) {
  const attackers = []
  for (let i = 0; i < n; i++) {
    const a = await startAttacker()
    attackers.push(a)
    await a.dial(target.getMultiaddrs()[0]).catch(() => {})
  }
  return attackers
}

async function authenticate(client, target) {
  const reply = await client.authenticateWith(target.peerId, { type: 'authenticate', token: 't', device_id: 'x' })
  return reply?.type === 'auth_ok'
}

describe('T340 connection-manager DoS hardening', () => {
  it('1: an un-admitted flood never evicts an established admitted connection and is capped to maxConnections - reservedFloor', async () => {
    const target = await startTarget({ maxConnections: 8, reservedFloor: 3, unadmittedDeadlineMs: HANDSHAKE_SAFE_DEADLINE_MS })
    const camp = await startCamp('camp')
    await camp.dial(target.getMultiaddrs()[0])
    expect(await authenticate(camp, target)).toBe(true)

    // non-vacuity: with capacity free the admitted connection is simply untouched
    expect(target.getPeers()).toContain(camp.peerId)

    const attackers = await flood(target, 12)
    // the attacker side can see 'open' before the target's cap abort propagates; wait for it
    await waitFor(() => openAttackerConns(target, attackers) <= 5, { timeout: HANDSHAKE_SAFE_DEADLINE_MS / 2 }) // bounded below the deadline, so a deadline-reaped uncapped flood cannot satisfy it
    expect(target.getPeers()).toContain(camp.peerId)

    await sleep(HANDSHAKE_SAFE_DEADLINE_MS + 500) // past the deadline: the admitted conn must survive it
    expect(target.getPeers()).toContain(camp.peerId)
    expect(target.isPeerAuthenticated(camp.peerId)).toBe(true)
  })

  it('2: an un-upgraded backlog is bounded by maxIncomingPendingConnections', async () => {
    const target = await startTarget({ maxIncomingPendingConnections: 3 })
    const port = Number(/\/tcp\/(\d+)/.exec(target.getMultiaddrs()[0].toString())[1])
    const sockets = []
    let closed = 0
    for (let i = 0; i < 10; i++) {
      const s = net.connect(port, '127.0.0.1')
      s.on('error', () => {})
      s.on('close', () => { closed++ })
      sockets.push(s)
    }
    cleanups.push(async () => sockets.forEach((s) => s.destroy()))
    await waitFor(() => closed >= 7)
    await sleep(200) // and no further sockets close: the pending cap admits exactly 3
    expect(closed).toBe(7)
  })

  it('3: the admitted tag is present after admit and absent after revoke and after disconnect', async () => {
    const target = await startTarget()
    const campA = await startCamp('a')
    const campB = await startCamp('b')
    await campA.dial(target.getMultiaddrs()[0])
    await campB.dial(target.getMultiaddrs()[0])
    expect(await target.isAdmittedTagged(campA.peerId)).toBe(false)
    expect(await authenticate(campA, target)).toBe(true)
    expect(await authenticate(campB, target)).toBe(true)
    await waitFor(() => target.isAdmittedTagged(campA.peerId))
    expect(await target.isAdmittedTagged(campB.peerId)).toBe(true)

    target.revokePeer(campA.peerId)
    await waitFor(async () => !(await target.isAdmittedTagged(campA.peerId)))

    await campB.stop()
    await waitFor(async () => !(await target.isAdmittedTagged(campB.peerId)))
  })

  it('3b: admitPeer (first-join bootstrap) also tags', async () => {
    const target = await startTarget()
    const camp = await startCamp('c')
    target.admitPeer(camp.peerId)
    await waitFor(() => target.isAdmittedTagged(camp.peerId))
  })

  it('4: at exactly maxConnections an admitted reconnect is refused without the floor, and likely lands via authGate-deadline turnover with it (likely, not guaranteed under a sustained flood)', async () => {
    const target = await startTarget({ maxConnections: 6, reservedFloor: 2, unadmittedDeadlineMs: 300 })
    const camp = await startCamp('camp')
    await flood(target, 6)

    const start = Date.now()
    let admitted = false
    // turnover is probabilistic by design (see header); the budget is a safety net for a loaded machine
    while (!admitted && Date.now() - start < 10_000) {
      try {
        await camp.dial(target.getMultiaddrs()[0])
        admitted = await authenticate(camp, target)
      } catch { /* refused / aborted — turnover is not instant under an active flood */ }
      if (!admitted) await sleep(100)
    }
    expect(admitted).toBe(true)
    expect(target.isPeerAuthenticated(camp.peerId)).toBe(true)
  })

  it('5: a held-open authGate stream is aborted at the deadline', async () => {
    const target = await startTarget({ unadmittedDeadlineMs: HANDSHAKE_SAFE_DEADLINE_MS })
    const attacker = await startAttacker()
    const conn = await attacker.dial(target.getMultiaddrs()[0])
    const stream = await attacker.dialProtocol(target.getMultiaddrs()[0], AUTH_PROTO)
    expect(stream).toBeTruthy()

    expect(conn.status).toBe('open')
    expect(liveConns(target, attacker.peerId).length).toBe(1)
    await waitFor(() => liveConns(target, attacker.peerId).length === 0, { timeout: HANDSHAKE_SAFE_DEADLINE_MS + 3000 })
  })

  it('6: the un-admitted bucket cap aborts the newest connection, not an older one', async () => {
    const target = await startTarget({ maxConnections: 10, reservedFloor: 7, unadmittedDeadlineMs: 5000 })
    let inboundOpens = 0 // registered after transport's own listener, so the cap decision has run when this fires
    target.libp2pNode.addEventListener('connection:open', (evt) => { if (evt.detail.direction === 'inbound') inboundOpens++ })
    const first = await flood(target, 3)
    await waitFor(() => inboundOpens === 3)
    expect(openAttackerConns(target, first)).toBe(3)
    const newest = await flood(target, 1)
    await waitFor(() => inboundOpens === 4) // non-vacuity: the target did see the newest connection
    expect(openAttackerConns(target, newest)).toBe(0)
    expect(openAttackerConns(target, first)).toBe(3)
  })

  it('7: with production defaults an immediately-authenticating pair syncs exactly as before', async () => {
    const received = []
    const a = await startTransport({ deviceId: 'a', onAuthenticate: alwaysAdmit, onDocReceived: (b) => received.push(b) })
    const b = await startTransport({ deviceId: 'b', onAuthenticate: alwaysAdmit })
    cleanups.push(() => a.stop(), () => b.stop())
    await b.dial(a.getMultiaddrs()[0])
    expect(await authenticate(b, a)).toBe(true)
    expect(await authenticate(a, b)).toBe(true)
    await b.broadcastDoc(new Uint8Array([1, 2, 3]))
    await waitFor(() => received.length === 1)
  })

  it('8: a pending pairing is not aborted by the deadline, so the director decision still lands after it', async () => {
    const decisions = []
    const director = await startTransport({ deviceId: 'director', onAuthenticate: alwaysAdmit, onPairingRequest: () => ({ ok: true }), unadmittedDeadlineMs: HANDSHAKE_SAFE_DEADLINE_MS })
    const joiner = await startTransport({ deviceId: 'joiner', listen: [], onAuthenticate: alwaysAdmit, onPairingDecision: (d) => decisions.push(d) })
    cleanups.push(() => director.stop(), () => joiner.stop())
    await joiner.dial(director.getMultiaddrs()[0])
    const reply = await joiner.authenticateWith(director.peerId, { type: 'pairing_request', device_id: 'joiner-dev', device_name: 'J' })
    expect(reply?.type).toBe('pairing_pending')

    await sleep(HANDSHAKE_SAFE_DEADLINE_MS + 500) // past the deadline
    expect(await director.sendPairingApproved('joiner-dev', 'secret')).toBe(true)
    await waitFor(() => decisions.length === 1)
  })

  it('9: the exemption is keyed to the pairing connection and clears when it closes', async () => {
    const key = await generateKeyPair('Ed25519')
    const director = await startTransport({ deviceId: 'director', onAuthenticate: alwaysAdmit, onPairingRequest: () => ({ ok: true }), unadmittedDeadlineMs: HANDSHAKE_SAFE_DEADLINE_MS })
    const joiner = await startTransport({ deviceId: 'joiner', listen: [], onAuthenticate: alwaysAdmit, privateKey: key })
    const joiner2 = await startTransport({ deviceId: 'joiner2', listen: [], onAuthenticate: alwaysAdmit, privateKey: key })
    cleanups.push(() => director.stop(), () => joiner.stop(), () => joiner2.stop())
    const conn = await joiner.dial(director.getMultiaddrs()[0])
    const reply = await joiner.authenticateWith(director.peerId, { type: 'pairing_request', device_id: 'joiner-dev', device_name: 'J' })
    expect(reply?.type).toBe('pairing_pending')
    await sleep(HANDSHAKE_SAFE_DEADLINE_MS + 500) // past the deadline: the pairing conn is exempt
    expect(conn.status).toBe('open')
    conn.abort(new Error('joiner left'))
    // a REMOTE abort is observed late under CPU load (measured >4s); generous safety-net timeout
    await waitFor(() => director.getPeers().length === 0, { timeout: 10_000 })
    await joiner2.dial(director.getMultiaddrs()[0])
    await waitFor(() => liveConns(director, joiner2.peerId).length === 1)
    await waitFor(() => liveConns(director, joiner2.peerId).length === 0, { timeout: HANDSHAKE_SAFE_DEADLINE_MS + 3000 })
    expect(await director.sendPairingApproved('joiner-dev', 'secret')).toBe(false)
  })

  it('10: a SECOND connection from the same pending peer id is not exempt and is aborted at the deadline', async () => {
    const key = await generateKeyPair('Ed25519')
    const director = await startTransport({ deviceId: 'director', onAuthenticate: alwaysAdmit, onPairingRequest: () => ({ ok: true }), unadmittedDeadlineMs: HANDSHAKE_SAFE_DEADLINE_MS })
    const joiner1 = await startTransport({ deviceId: 'j1', listen: [], onAuthenticate: alwaysAdmit, privateKey: key })
    const joiner2 = await startTransport({ deviceId: 'j2', listen: [], onAuthenticate: alwaysAdmit, privateKey: key })
    cleanups.push(() => director.stop(), () => joiner1.stop(), () => joiner2.stop())
    expect(joiner1.peerId).toBe(joiner2.peerId)
    const c1 = await joiner1.dial(director.getMultiaddrs()[0])
    await joiner1.authenticateWith(director.peerId, { type: 'pairing_request', device_id: 'joiner-dev', device_name: 'J' })
    await joiner2.dial(director.getMultiaddrs()[0])
    await waitFor(() => liveConns(director, joiner1.peerId).length === 2)
    // c2 is aborted at the deadline; the one survivor on the director is the pairing connection c1
    await waitFor(() => liveConns(director, joiner1.peerId).length === 1, { timeout: HANDSHAKE_SAFE_DEADLINE_MS + 3000 })
    await sleep(300)
    expect(liveConns(director, joiner1.peerId).length).toBe(1)
    expect(c1.status).toBe('open')
  })
})
