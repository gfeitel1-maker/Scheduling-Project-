// @vitest-environment node
// S3 / Rung 2 (docs/adr/2026-10-08-relayless-cross-network-reconnect.md): the signed,
// camp-encrypted reflexive-address entry each device publishes into the camp document.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as A from '@automerge/automerge'
import { recordKey } from '../../automerge/campDocument.js'
import { readRendezvousAddressKey } from './rendezvousAddressKey.js'
import { makeDevice, registerAll, revokeOn, freshCampDoc, cleanupDevices, CAMP_ID } from '../../../test/punchRung2Support.js'
import {
  publishReflexive, readReflexive, sealGossipEntry, deviceRegistryFromDb, GOSSIP_TTL_MS, MAX_CANDIDATES, GOSSIP_FIELD_PREFIX,
} from './punchGossip.js'

let a, b, mallory, doc
const NOW = 1_800_000_000_000
const CANDS = ['/ip4/203.0.113.7/udp/40001', '/ip4/192.168.1.20/udp/40001']

beforeEach(async () => {
  a = await makeDevice('device-a')
  b = await makeDevice('device-b')
  mallory = await makeDevice('device-m')
  registerAll([a, b, mallory])
  doc = freshCampDoc()
})
afterEach(() => cleanupDevices([a, b, mallory]))

function publish(dev, candidates = CANDS, ts = NOW, into = doc, extra = {}) {
  return publishReflexive(into, dev.db, { campId: CAMP_ID, deviceId: dev.deviceId, peerId: dev.peerId, candidates, now: () => ts, ...extra })
}
function read(reader = a, d = doc, now = NOW + 1000) {
  return readReflexive(d, { campId: CAMP_ID, registry: deviceRegistryFromDb(reader.db), now: () => now })
}

describe('punchGossip', () => {
  it('a published entry is read back verified, keyed by deviceId', () => {
    doc = publish(b)
    expect(read().get('device-b')).toMatchObject({ deviceId: 'device-b', peerId: b.peerId, candidates: CANDS, ts: NOW })
  })

  it('the entry is camp-encrypted: no candidate appears in the document in the clear', () => {
    doc = publish(b)
    expect(JSON.stringify(A.toJS(doc))).not.toContain('203.0.113.7')
  })

  it('REJECTS a forged entry: mallory claims device-b with her own peerId and key', () => {
    doc = publish(a)
    const forged = publish({ ...mallory, deviceId: 'device-b' }, ['/ip4/198.51.100.9/udp/1'])
    expect(read(a, forged).has('device-b')).toBe(false)
  })

  it('REJECTS a forged entry that claims the real peerId but is signed by another key', () => {
    doc = publish(a)
    const forged = publish({ ...mallory, deviceId: 'device-b', peerId: b.peerId }, ['/ip4/198.51.100.9/udp/1'])
    expect(read(a, forged).has('device-b')).toBe(false)
  })

  it('REJECTS an unsigned entry', () => {
    doc = publish(a)
    const forged = publish(b, CANDS, NOW, doc, { signMessage: () => '' })
    expect(read(a, forged).has('device-b')).toBe(false)
  })

  it('REJECTS a garbage value stored under a gossip field, and still reads the good ones', () => {
    doc = publish(a)
    const bad = A.change(doc, (d) => { d.camps[recordKey(CAMP_ID, `${GOSSIP_FIELD_PREFIX}device-b`)] = 'not-an-entry' })
    const entries = read(a, bad)
    expect(entries.has('device-b')).toBe(false)
    expect(entries.has('device-a')).toBe(true)
  })

  it('IGNORES a revoked device (devices.revoked_at)', () => {
    doc = publish(b)
    revokeOn(a.db, 'device-b')
    expect(read().has('device-b')).toBe(false)
  })

  it('IGNORES a device the authority log revoked (authority_cache)', () => {
    doc = publish(b)
    a.db.prepare("INSERT INTO authority_cache (device_id, status, updated_at) VALUES ('device-b', 'revoked', ?)").run(new Date().toISOString())
    expect(read().has('device-b')).toBe(false)
  })

  it('IGNORES a device that is not in the registry at all', () => {
    doc = publish(a)
    doc = publish({ ...mallory, deviceId: 'device-unknown' })
    expect(read().has('device-unknown')).toBe(false)
  })

  it('drops a stale entry past the TTL, keeps it just inside', () => {
    doc = publish(b)
    expect(read(a, doc, NOW + GOSSIP_TTL_MS - 1).has('device-b')).toBe(true)
    expect(read(a, doc, NOW + GOSSIP_TTL_MS + 1).has('device-b')).toBe(false)
  })

  it('drops an entry dated implausibly far in the future', () => {
    doc = publish(b, CANDS, NOW + 60 * 60 * 1000)
    expect(read().has('device-b')).toBe(false)
  })

  it('publish refuses too many, non-udp and oversize candidates', () => {
    const many = Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => `/ip4/203.0.113.${i + 1}/udp/4000`)
    expect(() => publish(b, many)).toThrow(/candidates/)
    expect(() => publish(b, ['/ip4/1.2.3.4/tcp/80'])).toThrow(/candidate/)
    expect(() => publish(b, [`/ip4/1.2.3.4/udp/80/${'x'.repeat(300)}`])).toThrow(/candidate/)
  })

  it('READ drops a correctly-signed entry over the candidate bound (a hostile but valid peer)', () => {
    doc = publish(a)
    const many = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => `/ip4/203.0.113.${i + 1}/udp/4000`)
    const value = sealGossipEntry(b.db, { addressKey: readRendezvousAddressKey(doc, CAMP_ID), deviceId: 'device-b', peerId: b.peerId, candidates: many, ts: NOW })
    const hostile = A.change(doc, (d) => { d.camps[recordKey(CAMP_ID, `${GOSSIP_FIELD_PREFIX}device-b`)] = value })
    expect(read(a, hostile).has('device-b')).toBe(false)
  })

  it('READ drops an oversize value without trusting it', () => {
    doc = publish(a)
    const huge = A.change(doc, (d) => { d.camps[recordKey(CAMP_ID, `${GOSSIP_FIELD_PREFIX}device-b`)] = 'A'.repeat(100_000) })
    expect(read(a, huge).has('device-b')).toBe(false)
  })

  it('a later publish by the same device replaces its entry (one entry per device)', () => {
    doc = publish(b, CANDS, NOW)
    doc = publish(b, ['/ip4/203.0.113.99/udp/5'], NOW + 5000)
    expect(read(a, doc, NOW + 6000).get('device-b').candidates).toEqual(['/ip4/203.0.113.99/udp/5'])
  })

  it('two devices publishing concurrently both survive a merge (no field clash)', () => {
    const base = publish(a)
    const left = publish(a, ['/ip4/203.0.113.1/udp/1'], NOW + 10, A.clone(base))
    const right = publish(b, ['/ip4/203.0.113.2/udp/2'], NOW + 10, A.clone(base))
    const merged = A.merge(left, right)
    const entries = read(a, merged, NOW + 1000)
    expect(entries.get('device-a').candidates).toEqual(['/ip4/203.0.113.1/udp/1'])
    expect(entries.get('device-b').candidates).toEqual(['/ip4/203.0.113.2/udp/2'])
  })
})
