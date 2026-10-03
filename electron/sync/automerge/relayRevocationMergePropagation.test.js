// @vitest-environment node
//
// T336 build design (docs/work/specs/2026-10-03-t336-holepunch-build-design.md §4, Precondition
// 1): the one step T337's own revoke tests (relayRoleCampOnly.test.js, relayRevokeWhileRunning.test.js,
// syncNode.test.js's "T331 gate C") all skip — they call `revokePeer` directly on the relay node,
// or mint the revoke on the SAME device that enforces it. Here the revoke is minted on a FOURTH,
// separate device (D) and must reach R (the relay) by ordinary Automerge sync — merge-propagation,
// not a direct function call — before R's own merge observer tears B down.
//
// Four real libp2p nodes, no mocks:
//   D (device-d) — mints the real signed revoke entry, via startSyncNode (doc-sync capable).
//   R (device-r) — the relay under test, via startSyncNode + the real circuitRelayServer.
//   B (device-b) — the peer to be revoked, via transport.js's startTransport + circuitRelayTransport,
//                  holds a REAL reservation on R (auto-reserved, same mechanism as
//                  relayEndToEndRevoke.test.js's node C).
//   A — a plain raw libp2p node (no auth protocol), used only to probe R's HOP broker directly,
//       mirroring relayRoleCampOnly.test.js/relayRevokeWhileRunning.test.js's own probe pattern.
//
// Reuses the real-signed-entry fixture shape already established by syncNode.test.js's "T331 gate
// C" test (signAuthorityEntry + applyWrite-per-field, genesis/grant/revoke) rather than hand-
// rolling a second way to produce a real merged revoke.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { circuitRelayServer, circuitRelayTransport, RELAY_V2_HOP_CODEC } from '@libp2p/circuit-relay-v2'
import { pbStream } from '@libp2p/utils'
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'
import { openLocalDb, CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { ensureHostSigningKey, issueCampToken } from '../../auth/localAuth.js'
import { signAuthorityEntry } from '../../automerge/authorityLogSignature.js'
import { startSyncNode } from './syncNode.js'
import { startTransport } from './transport.js'
// Deep-import, same justification as relayRoleCampOnly.test.js: not part of
// @libp2p/circuit-relay-v2's public `exports` map, resolved by relative path (version actually
// installed in this worktree — @libp2p/circuit-relay-v2@4.2.13).
import { HopMessage, Status } from '../../../node_modules/@libp2p/circuit-relay-v2/dist/src/pb/index.js'

let files = []
let handles = []
let rawNodes = []
afterEach(async () => {
  await Promise.all(handles.map((h) => h.stop()))
  await Promise.all(rawNodes.map((n) => n.stop()))
  handles = []
  rawNodes = []
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-t336-p1-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  return db
}

// Generalizes syncNode.test.js's setupAuthorizedDevicePair to N devices sharing one camp/host —
// same shape, same tables, just not hardcoded to exactly two device ids.
function setupAuthority(dbs, deviceIds) {
  const hostKey = ensureHostSigningKey(dbs[0])
  for (const db of dbs) {
    db.prepare('UPDATE camps SET signing_public_key = ?').run(hostKey.public_key)
    for (const id of deviceIds) {
      db.prepare(
        "INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')"
      ).run(id, id, new Date().toISOString())
    }
  }
  const tokens = {}
  for (const id of deviceIds) tokens[id] = issueCampToken(dbs[0], id, id)
  return tokens
}

async function authenticateBothWays(x, y, deviceIdX, tokenX, deviceIdY, tokenY) {
  await x.authenticateWith(y.peerId, { type: 'authenticate', token: tokenX, device_id: deviceIdX, schemaVersion: CURRENT_SCHEMA_VERSION })
  await y.authenticateWith(x.peerId, { type: 'authenticate', token: tokenY, device_id: deviceIdY, schemaVersion: CURRENT_SCHEMA_VERSION })
}

async function waitFor(predicate, { timeout = 10000, interval = 50 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

// Real signed camp_authority_log entries, written as ordinary document writes — the exact shape
// syncNode.test.js's "T331 gate C" test already uses, reused here rather than invented fresh.
function mintEntry(db, doc, fields, signed) {
  const id = `entry-${Math.random()}`
  let d = doc
  for (const [field, value] of Object.entries(fields)) {
    d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field, value })
  }
  if (signed) {
    const signature = signAuthorityEntry(db, { id, kind: fields.kind, target_device_id: fields.target_device_id, signer_device_id: fields.signer_device_id })
    d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signature', value: signature })
  }
  return d
}

async function startRawNode() {
  const node = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  })
  rawNodes.push(node)
  return node
}

async function requestConnect(node, relayPeerId, dstPeerId) {
  const stream = await node.dialProtocol(relayPeerId, RELAY_V2_HOP_CODEC)
  const pbstr = pbStream(stream).pb(HopMessage)
  await pbstr.write({ type: HopMessage.Type.CONNECT, peer: { id: dstPeerId.toMultihash().bytes, addrs: [] } })
  const response = await pbstr.read()
  await stream.close().catch(() => {})
  return response
}

// Builds D (founder, mints), R (relay under test, via startSyncNode) and B (to be revoked, via
// startTransport + circuitRelayTransport, real reservation on R) plus a raw probe node A.
// `connectDR` controls whether D and R are wired bidirectionally for Automerge sync — the RED
// test below sets this false to prove the revoke, with no path to R, never tears B down.
async function buildFourNodes({ connectDR }) {
  const dbD = freshDb('d')
  const dbR = freshDb('r')
  const dbB = freshDb('b')
  const tokens = setupAuthority([dbD, dbR, dbB], ['device-d', 'device-r', 'device-b'])

  const genesis = createEmptyDoc()
  const d = await startSyncNode({ deviceId: 'device-d', db: dbD, doc: A.clone(genesis) })
  const r = await startSyncNode({
    deviceId: 'device-r',
    db: dbR,
    doc: A.clone(genesis),
    relayServerFactory: circuitRelayServer({ reservations: { reservationTtl: 120000, maxReservations: 8 } }),
  })
  const b = await startTransport({
    deviceId: 'device-b',
    listen: ['/ip4/127.0.0.1/tcp/0', '/p2p-circuit'],
    relayTransportFactory: circuitRelayTransport(),
  })
  handles.push(d, r, b)
  const a = await startRawNode()

  if (connectDR) {
    await d.dial(r.getMultiaddrs()[0])
    await waitFor(() => d.getPeers().length > 0)
    await authenticateBothWays(d, r, 'device-d', tokens['device-d'], 'device-r', tokens['device-r'])
  }

  // B dials and authenticates TO R — admits B into R's authenticatedPeers, which is both what
  // RESERVE gating requires AND what records R's peerDeviceIds['device-b'] (the mapping
  // tearDownRevokedConnectedPeers reads).
  await b.dial(r.getMultiaddrs()[0])
  await waitFor(() => b.getPeers().length > 0)
  await b.authenticateWith(r.peerId, { type: 'authenticate', token: tokens['device-b'], device_id: 'device-b', schemaVersion: CURRENT_SCHEMA_VERSION })

  // B's circuitRelayTransport auto-reserves on R once RESERVE succeeds — wait for the real
  // /p2p-circuit listen address, the same signal relayEndToEndRevoke.test.js uses, rather than a
  // fixed sleep.
  await waitFor(() => b.getMultiaddrs().some((ma) => ma.toString().includes('/p2p-circuit')))

  // A dials R directly and is admitted (test-support admitPeer, same as relayEndToEndRevoke.test.js)
  // so A's later CONNECT probe fails for B's reservation state specifically, not for A's own
  // non-admission or absence of a connection.
  const relayPeerId = peerIdFromString(r.peerId)
  await a.dial(multiaddr(r.getMultiaddrs()[0].toString()))
  r.admitPeer(a.peerId.toString())

  return { dbD, dbR, dbB, d, r, b, a, relayPeerId }
}

describe('T336 Precondition 1 — relay-specific every-hop revocation over the REAL merge-propagated revoke chain', () => {
  it('RED: a revoke minted on D that never merge-propagates to R leaves B fully connected and reserved', async () => {
    const { dbD, d, r, b, a, relayPeerId } = await buildFourNodes({ connectDR: false })
    const bPeerIdString = b.peerId.toString()
    const bPeerId = peerIdFromString(bPeerIdString)

    // Mint the real signed chain on D — but D has no path to R, so this can only ever reach D's
    // own doc. This is the exact blind spot T337's tests could not catch (they always called
    // revokePeer directly, or minted+enforced on the same device).
    let doc = d.getDoc()
    doc = mintEntry(dbD, doc, { kind: 'genesis', target_device_id: 'device-d', target_peer_id: d.peerId.toString() }, false)
    await d.applyLocal(doc)
    doc = mintEntry(dbD, d.getDoc(), { kind: 'grant', target_device_id: 'device-b', target_peer_id: bPeerIdString, signer_device_id: 'device-d' }, true)
    await d.applyLocal(doc)
    doc = mintEntry(dbD, d.getDoc(), { kind: 'revoke', target_device_id: 'device-b', signer_device_id: 'device-d' }, true)
    await d.applyLocal(doc)

    await new Promise((resolve) => setTimeout(resolve, 300))

    // B is still admitted on R...
    expect(r.isPeerAuthenticated(bPeerIdString)).toBe(true)
    // ...and R still brokers a CONNECT to B (reservation intact) — proving a revoke that stays
    // local never tears anything down on R. Without this RED baseline, the GREEN test's green
    // could be coincidental rather than caused by the propagation step.
    const response = await requestConnect(a, relayPeerId, bPeerId)
    expect(response.status).toBe(Status.OK)
  })

  it('GREEN: a revoke that merge-propagates from D to R via the ordinary Automerge sync path tears B down on R — admission AND reservation', async () => {
    const { dbD, d, r, b, a, relayPeerId } = await buildFourNodes({ connectDR: true })
    const bPeerIdString = b.peerId.toString()
    const bPeerId = peerIdFromString(bPeerIdString)

    // Sanity: B is genuinely admitted and reserved on R before the revoke lands.
    expect(r.isPeerAuthenticated(bPeerIdString)).toBe(true)
    const beforeRevoke = await requestConnect(a, relayPeerId, bPeerId)
    expect(beforeRevoke.status).not.toBe(Status.NO_RESERVATION)
    expect(beforeRevoke.status).not.toBe(Status.PERMISSION_DENIED)

    // Mint the real signed genesis/grant/revoke chain on D and let EACH write propagate to R via
    // d.applyLocal's real sync-protocol broadcast (stepSync to every authenticated peer) — never
    // a direct call into R's internals.
    let doc = d.getDoc()
    doc = mintEntry(dbD, doc, { kind: 'genesis', target_device_id: 'device-d', target_peer_id: d.peerId.toString() }, false)
    await d.applyLocal(doc)
    doc = mintEntry(dbD, d.getDoc(), { kind: 'grant', target_device_id: 'device-b', target_peer_id: bPeerIdString, signer_device_id: 'device-d' }, true)
    await d.applyLocal(doc)
    doc = mintEntry(dbD, d.getDoc(), { kind: 'revoke', target_device_id: 'device-b', signer_device_id: 'device-d' }, true)
    await d.applyLocal(doc)

    // (a)+(b): R's OWN merge observer (projectAndNotify -> tearDownRevokedConnectedPeers), fired
    // as a RESULT of receiving and merging D's sync message — not by this test calling
    // tearDownRevokedConnectedPeers or revokePeer directly — de-admits B.
    await waitFor(() => !r.isPeerAuthenticated(bPeerIdString))

    // (c): the reservation itself is gone from R's ReservationStore, not merely the admission —
    // proven the same way relayRevokeWhileRunning.test.js's "REVOKED DESTINATION" case proves it:
    // a CONNECT naming B as destination comes back NO_RESERVATION (handleConnect's own
    // `reservation == null` check, fired before the gater is even reached).
    //
    // (d): A reaching B through R after propagation is refused at the relay-broker level.
    const afterRevoke = await requestConnect(a, relayPeerId, bPeerId)
    expect(afterRevoke.status).toBe(Status.NO_RESERVATION)
    expect(afterRevoke.status).not.toBe(Status.OK)
  }, 20000)
})
