// @vitest-environment node
//
// S1 of the relay-less reconnect ladder (docs/adr/2026-10-08-relayless-cross-network-reconnect.md,
// "Integration ruling"): the ICE data channel is a libp2p TRANSPORT, so Noise + authGate/T331
// mutualAuth + isPeerRevoked + Yamux + Automerge run UNCHANGED over it. These tests drive the real
// startSyncNode (real evaluateAuthenticate, real SQLite) with the punch transport as the ONLY path
// between the two nodes — the dial address is /udp/, which the tcp transport cannot match.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { multiaddr } from '@multiformats/multiaddr'
import { openLocalDb, CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { ensureHostSigningKey, issueCampToken } from '../../auth/localAuth.js'
import { startSyncNode } from './syncNode.js'
import { punchTransport } from './punchTransport.js'
import { makeSignalingPair } from './punchTestSupport.js'
import { signAuthorityEntry } from '../../automerge/authorityLogSignature.js'

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `punchsync-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  return db
}

function setupAuthorizedDevicePair(dbA, dbB) {
  const hostKey = ensureHostSigningKey(dbA)
  for (const db of [dbA, dbB]) {
    db.prepare('UPDATE camps SET signing_public_key = ?').run(hostKey.public_key)
    db.prepare("INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')").run('device-a', 'Device A', new Date().toISOString())
    db.prepare("INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')").run('device-b', 'Device B', new Date().toISOString())
  }
  return {
    tokenA: issueCampToken(dbA, 'user-a', 'device-a'),
    tokenB: issueCampToken(dbA, 'user-b', 'device-b'),
  }
}

async function authenticateBothWays(a, b, tokenA, tokenB) {
  await a.authenticateWith(b.peerId, { type: 'authenticate', token: tokenA, device_id: 'device-a', schemaVersion: CURRENT_SCHEMA_VERSION })
  await b.authenticateWith(a.peerId, { type: 'authenticate', token: tokenB, device_id: 'device-b', schemaVersion: CURRENT_SCHEMA_VERSION })
}

let dbA, dbB
let nodes = []
beforeEach(() => {
  dbA = freshDb('a')
  dbB = freshDb('b')
})
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop()))
  nodes = []
  for (const db of [dbA, dbB]) {
    try { db.close() } catch { /* already closed */ }
  }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

async function waitFor(predicate, { timeout = 15000, interval = 20 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

function activityRow(db, id) {
  return db.prepare('SELECT id, name FROM activities WHERE id = ?').get(id)
}

// a is the offerer (dials), b the answerer (listens) — one in-memory signaling pair between them.
async function startPunchedPair() {
  const [sigA, sigB] = makeSignalingPair()
  const genesis = createEmptyDoc()
  const listen = ['/ip4/127.0.0.1/tcp/0', '/ip4/127.0.0.1/udp/0']
  const dials = { a: 0 }
  const factoryA = punchTransport({ signaling: sigA, role: 'offerer' })
  const a = await startSyncNode({
    deviceId: 'device-a', db: dbA, doc: A.clone(genesis), listen,
    punchTransportFactory: (components) => {
      const t = factoryA(components)
      const dial = t.dial.bind(t)
      t.dial = (...args) => { dials.a++; return dial(...args) }
      return t
    },
  })
  const b = await startSyncNode({
    deviceId: 'device-b', db: dbB, doc: A.clone(genesis), listen,
    punchTransportFactory: punchTransport({ signaling: sigB, role: 'answerer' }),
  })
  nodes.push(a, b)
  await a.dial(multiaddr(`/ip4/127.0.0.1/udp/9/p2p/${b.peerId}`))
  await waitFor(() => a.getPeers().length > 0 && b.getPeers().length > 0)
  return { a, b, genesis, dials }
}

describe('punchTransport — libp2p transport over a node-datachannel pipe', () => {
  it('a camp peer is admitted over the punch transport and Automerge sync completes', async () => {
    const { a, b, dials } = await startPunchedPair()
    expect(dials.a).toBe(1)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)
    expect(b.isPeerAuthenticated(a.peerId)).toBe(true)

    await a.applyLocal(applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'archery', field: 'name', value: 'Archery' }))
    await waitFor(() => activityRow(dbB, 'archery')?.name === 'Archery')
    await b.applyLocal(applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'swim', field: 'name', value: 'Swim' }))
    await waitFor(() => activityRow(dbA, 'swim')?.name === 'Swim')
  }, 30000)

  it('a non-camp peer with a VALID DTLS channel is refused by authGate: not admitted, no sync', async () => {
    const { a, b, genesis } = await startPunchedPair()

    const bHeadsBefore = A.getHeads(b.getDoc())
    const bad = applyWrite(A.clone(genesis), { entity: 'activities', entity_id: 'ghost', field: 'name', value: 'Ghost' })
    await a.sendDocTo(b.peerId, A.save(bad)).catch(() => {})
    await new Promise((r) => setTimeout(r, 300))

    expect(b.isPeerAuthenticated(a.peerId)).toBe(false)
    expect(A.getHeads(b.getDoc())).toEqual(bHeadsBefore)
    expect(activityRow(dbB, 'ghost')).toBeUndefined()
  }, 30000)

  it('a peer revoked mid-connection is cut off over the punch transport (isPeerRevoked path)', async () => {
    const { a, b } = await startPunchedPair()
    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    await b.applyLocal(applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'before', field: 'name', value: 'Before' }))
    await waitFor(() => activityRow(dbA, 'before')?.name === 'Before')

    dbA.prepare('INSERT INTO authority_cache (device_id, status, updated_at) VALUES (?, ?, ?)').run('device-b', 'revoked', new Date().toISOString())

    // Event-driven, not a fixed sleep. A refusal line for B may already exist for an unrelated message
    // (an ack for the earlier write), so a bare "any refusal seen" wait can pass before the revoked
    // write was ever offered. The wait is therefore tied to the writes themselves: count the refusals
    // before them, send the revoked write and then a second marker write, and wait until the count has
    // grown by at least two - one message per write - before asserting that neither landed.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refusals = () => errors.mock.calls.filter((c) => String(c[0]).includes(`refused a sync message from ${b.peerId}`) && String(c[0]).includes('revoked')).length
    try {
      const before = refusals()
      await b.applyLocal(applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'revoked-write', field: 'name', value: 'Should Not Land' }))
      await waitFor(() => refusals() >= before + 1)
      await b.applyLocal(applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'revoked-marker', field: 'name', value: 'Also Should Not Land' }))
      await waitFor(() => refusals() >= before + 2)
    } finally {
      errors.mockRestore()
    }
    expect(activityRow(dbA, 'revoked-write')).toBeUndefined()
    expect(activityRow(dbA, 'revoked-marker')).toBeUndefined()

    await a.applyLocal(applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'ok-write', field: 'name', value: 'Fine' }))
    await waitFor(() => activityRow(dbB, 'ok-write')?.name === 'Fine')
  }, 30000)

  // Q2 of docs/work/security/2026-10-09-wan-ladder-assessment.md: the T331 gate C live teardown
  // (syncNode.test.js's LAN case) must also cut off an ESTABLISHED punch connection when a real
  // signed revocation is projected, not only refuse messages tagged revoked.
  it('a peer revoked by a signed authority entry mid-session over a punch connection is de-admitted (gate C teardown)', async () => {
    const { a, b, dials } = await startPunchedPair()
    expect(dials.a).toBeGreaterThan(0)
    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)
    await waitFor(() => a.isPeerAuthenticated(b.peerId.toString()))

    function pushEntry(doc, fields, signed) {
      const id = `entry-${Math.random()}`
      let d = doc
      for (const [field, value] of Object.entries(fields)) d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field, value })
      if (signed) {
        const signature = signAuthorityEntry(dbA, { id, kind: fields.kind, target_device_id: fields.target_device_id, signer_device_id: fields.signer_device_id })
        d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signature', value: signature })
      }
      return d
    }
    await a.applyLocal(pushEntry(a.getDoc(), { kind: 'genesis', target_device_id: 'device-a', target_peer_id: a.peerId.toString() }, false))
    await a.applyLocal(pushEntry(a.getDoc(), { kind: 'grant', target_device_id: 'device-b', target_peer_id: b.peerId.toString(), signer_device_id: 'device-a' }, true))
    expect(a.isPeerAuthenticated(b.peerId.toString())).toBe(true)

    await a.applyLocal(pushEntry(a.getDoc(), { kind: 'revoke', target_device_id: 'device-b', signer_device_id: 'device-a' }, true))
    await waitFor(() => !a.isPeerAuthenticated(b.peerId.toString()))

    await a.applyLocal(applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'after-revoke', field: 'name', value: 'Not For B' }))
    await new Promise((r) => setTimeout(r, 500))
    expect(activityRow(dbB, 'after-revoke')).toBeUndefined()
  }, 30000)
})
