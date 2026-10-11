// @vitest-environment node
//
// T373. libp2p refuses an inbound connection once one remote HOST has opened `inboundConnectionThreshold`
// (default 5) of them inside a second, by destroying the socket, so the dialer sees
// `EncryptionFailedError: read ECONNRESET` out of its Noise handshake. Every test device is 127.0.0.1, so
// the integration harness hit it on Linux CI. syncNode must pass the (test-only) knob through to the
// transport or the harness has no way to lift the limit.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc } from '../../automerge/campDocument.js'
import { startSyncNode } from './syncNode.js'

const cleanups = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c().catch(() => {})))
})

async function target(opts) {
  const f = path.join(os.tmpdir(), `shoresh-t373-${Date.now()}-${Math.random()}.sqlite`)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp')
  const node = await startSyncNode({ deviceId: 'device-t', db, doc: createEmptyDoc(), ...opts })
  cleanups.push(async () => { await node.stop(); try { db.close() } catch { /* closed */ } fs.rmSync(f, { force: true }) })
  return node
}

async function dialFresh(addr) {
  const d = await createLibp2p({ addresses: { listen: [] }, transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()] })
  cleanups.push(() => d.stop())
  return d.dial(addr).then(() => 'ok', (err) => err.message)
}

describe('T373 inboundConnectionThreshold reaches the transport', () => {
  it('a threshold of 2 refuses the third connection from one host within a second', async () => {
    const t = await target({ inboundConnectionThreshold: 2 })
    const addr = t.getMultiaddrs()[0]
    const results = []
    for (let i = 0; i < 4; i++) results.push(await dialFresh(addr))
    expect(results.slice(0, 2)).toEqual(['ok', 'ok'])
    expect(results.slice(2).some((r) => r !== 'ok')).toBe(true)
  })

  it('a high threshold admits a burst far above libp2p\'s default of 5', async () => {
    const t = await target({ inboundConnectionThreshold: 1000 })
    const addr = t.getMultiaddrs()[0]
    const results = []
    for (let i = 0; i < 8; i++) results.push(await dialFresh(addr))
    expect(results).toEqual(Array(8).fill('ok'))
  })
})
