// @vitest-environment node
//
// S1 of the relay-less reconnect ladder (docs/adr/2026-10-08-relayless-cross-network-reconnect.md,
// "Integration ruling"): the ICE data channel is a libp2p TRANSPORT, so Noise + authGate/T331
// mutualAuth + isPeerRevoked + Yamux + Automerge run UNCHANGED over it. These tests drive the real
// startSyncNode (real evaluateAuthenticate, real SQLite) with the punch transport as the ONLY path
// between the two nodes — the dial address is /udp/, which the tcp transport cannot match.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
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

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `pt-${tag}-${Date.now()}-${Math.random()}.sqlite`)
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

    await b.applyLocal(applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'revoked-write', field: 'name', value: 'Should Not Land' }))
    await new Promise((r) => setTimeout(r, 500))
    expect(activityRow(dbA, 'revoked-write')).toBeUndefined()

    await a.applyLocal(applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'ok-write', field: 'name', value: 'Fine' }))
    await waitFor(() => activityRow(dbB, 'ok-write')?.name === 'Fine')
  }, 30000)
})
