// @vitest-environment node
//
// T162 (docs/adr/2026-09-14-device-identity-and-token-binding.md §1/§2):
// ensureDeviceIdentity persists a per-device libp2p keypair, generated once
// and stable across calls.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { ensureDeviceIdentity } from './deviceIdentity.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})
function tmpDb(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

describe('ensureDeviceIdentity', () => {
  it('creates a persistent identity on first call and returns a peerId string', async () => {
    const db = tmpDb('identity-fresh')
    const { peerId, privateKey } = await ensureDeviceIdentity(db)
    expect(typeof peerId).toBe('string')
    expect(peerId.length).toBeGreaterThan(0)
    expect(privateKey).toBeDefined()
    const row = db.prepare('SELECT peer_id, private_key FROM device_identity_key WHERE id = 1').get()
    expect(row.peer_id).toBe(peerId)
    expect(typeof row.private_key).toBe('string')
    db.close()
  })

  it('is idempotent: a second call returns the identical peerId, not a fresh one', async () => {
    const db = tmpDb('identity-idempotent')
    const first = await ensureDeviceIdentity(db)
    const second = await ensureDeviceIdentity(db)
    expect(second.peerId).toBe(first.peerId)
    expect(db.prepare('SELECT COUNT(*) c FROM device_identity_key').get().c).toBe(1)
    db.close()
  })

  it('the returned privateKey actually round-trips to the same peerId via peerIdFromPrivateKey', async () => {
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id')
    const db = tmpDb('identity-roundtrip')
    const { peerId, privateKey } = await ensureDeviceIdentity(db)
    expect(peerIdFromPrivateKey(privateKey).toString()).toBe(peerId)
    db.close()
  })
})
