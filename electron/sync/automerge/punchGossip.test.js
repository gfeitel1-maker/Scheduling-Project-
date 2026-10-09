// @vitest-environment node
// S3 / Rung 2 (docs/adr/2026-10-08-relayless-cross-network-reconnect.md): the signed,
// camp-encrypted reflexive-address entry each device publishes into the camp document.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { recordKey } from '../../automerge/campDocument.js'
import { readRendezvousAddressKey } from './rendezvousAddressKey.js'
import { tmpHighWater, makeDevice, registerAll, revokeOn, freshCampDoc, cleanupDevices, CAMP_ID } from '../../../test/punchRung2Support.js'
import {
  publishReflexive, readReflexive, sealGossipEntry, deviceRegistryFromDb, GOSSIP_TTL_MS, MAX_CANDIDATES, GOSSIP_FIELD_PREFIX, createHighWaterStore, isPublicAddress,
} from './punchGossip.js'

let a, b, mallory, doc
const NOW = 1_800_000_000_000
const CANDS = ['/ip4/34.120.1.7/udp/40001', '/ip4/52.20.30.20/udp/40001']

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
function read(reader = a, d = doc, now = NOW + 1000, extra = {}) {
  return readReflexive(d, { campId: CAMP_ID, registry: deviceRegistryFromDb(reader.db), now: () => now, highWater: tmpHighWater(), ...extra })
}

describe('punchGossip', () => {
  it('a published entry is read back verified, keyed by deviceId', () => {
    doc = publish(b)
    expect(read().get('device-b')).toMatchObject({ deviceId: 'device-b', peerId: b.peerId, candidates: CANDS, ts: NOW })
  })

  it('the entry is camp-encrypted: no candidate appears in the document in the clear', () => {
    doc = publish(b)
    expect(JSON.stringify(A.toJS(doc))).not.toContain('34.120.1.7')
  })

  it('REJECTS a forged entry: mallory claims device-b with her own peerId and key', () => {
    doc = publish(a)
    const forged = publish({ ...mallory, deviceId: 'device-b' }, ['/ip4/52.20.30.9/udp/1'])
    expect(read(a, forged).has('device-b')).toBe(false)
  })

  it('REJECTS a forged entry that claims the real peerId but is signed by another key', () => {
    doc = publish(a)
    const forged = publish({ ...mallory, deviceId: 'device-b', peerId: b.peerId }, ['/ip4/52.20.30.9/udp/1'])
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
    const many = Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => `/ip4/34.120.1.${i + 1}/udp/4000`)
    expect(() => publish(b, many)).toThrow(/candidates/)
    expect(() => publish(b, ['/ip4/1.2.3.4/tcp/80'])).toThrow(/candidate/)
    expect(() => publish(b, [`/ip4/1.2.3.4/udp/80/${'x'.repeat(300)}`])).toThrow(/candidate/)
  })

  it('READ drops a correctly-signed entry over the candidate bound (a hostile but valid peer)', () => {
    doc = publish(a)
    const many = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => `/ip4/34.120.1.${i + 1}/udp/4000`)
    const value = sealGossipEntry(b.db, { addressKey: readRendezvousAddressKey(doc, CAMP_ID), deviceId: 'device-b', peerId: b.peerId, candidates: many, ts: NOW })
    const hostile = A.change(doc, (d) => { d.camps[recordKey(CAMP_ID, `${GOSSIP_FIELD_PREFIX}device-b`)] = value })
    expect(read(a, hostile).has('device-b')).toBe(false)
  })

  it('READ drops an oversize value without trusting it', () => {
    doc = publish(a)
    const huge = A.change(doc, (d) => { d.camps[recordKey(CAMP_ID, `${GOSSIP_FIELD_PREFIX}device-b`)] = 'A'.repeat(100_000) })
    expect(read(a, huge).has('device-b')).toBe(false)
  })

  const NON_PUBLIC = [
    '/ip4/10.1.2.3/udp/4000', '/ip4/172.20.0.5/udp/4000', '/ip4/192.168.1.20/udp/4000', '/ip4/127.0.0.1/udp/4000',
    '/ip4/169.254.9.9/udp/4000', '/ip4/100.64.0.9/udp/4000', '/ip4/224.0.0.251/udp/4000', '/ip4/0.0.0.0/udp/4000',
    '/ip6/::1/udp/4000', '/ip6/::/udp/4000', '/ip6/fe80::1/udp/4000', '/ip6/fd00::1/udp/4000', '/ip6/ff02::1/udp/4000',
    '/ip6/64:ff9b::808:808/udp/4000', '/ip6/64:ff9b:1::1/udp/4000', '/ip6/2002:808:808::1/udp/4000', '/ip6/2002:c0a8:101::1/udp/4000',
    '/ip4/192.0.2.5/udp/4000', '/ip4/198.51.100.5/udp/4000', '/ip4/203.0.113.5/udp/4000', '/ip4/198.18.0.1/udp/4000', '/ip4/198.19.255.254/udp/4000',
    '/ip6/::ffff:c0a8:101/udp/4000', '/ip6/0:0:0:0:0:ffff:c0a8:101/udp/4000', '/ip6/0:0:0:0:0:0:0:1/udp/4000',
    '/ip6/::ffff:192.168.1.1/udp/4000', '/ip4/34.120.1.7/udp/0',
    '/ip6/2001:0:4136:e378:8000:63bf:3fff:fdd2/udp/4000', '/ip6/2001:db8::7/udp/4000', '/ip6/fec0::1/udp/4000', '/ip6/100::1/udp/4000',
    '/ip6/3fff::1/udp/4000', '/ip6/3fff:fff:ffff::1/udp/4000', '/ip6/2001:10::1/udp/4000', '/ip6/2001:1f::1/udp/4000', '/ip6/2001:20::1/udp/4000', '/ip6/2001:2f::1/udp/4000',
    '/ip4/192.0.0.9/udp/4000', '/ip4/192.88.99.1/udp/4000',
  ]

  it.each(NON_PUBLIC)('READ drops a correctly-signed entry carrying non-public candidate %s', (candidate) => {
    doc = publish(a)
    const value = sealGossipEntry(b.db, { addressKey: readRendezvousAddressKey(doc, CAMP_ID), deviceId: 'device-b', peerId: b.peerId, candidates: [CANDS[0], candidate], ts: NOW })
    const hostile = A.change(doc, (d) => { d.camps[recordKey(CAMP_ID, `${GOSSIP_FIELD_PREFIX}device-b`)] = value })
    expect(read(a, hostile).has('device-b')).toBe(false)
  })

  it.each(NON_PUBLIC)('publish refuses non-public candidate %s', (candidate) => {
    expect(() => publish(b, [candidate])).toThrow(/candidate/)
  })

  it('public IPv6 and IPv4 candidates pass the filter', () => {
    doc = publish(b, ['/ip6/2606:4700::7/udp/4000', '/ip4/8.8.4.4/udp/4000'])
    expect(read().get('device-b').candidates).toHaveLength(2)
  })

  it('a future-dated but correctly signed entry is reported in .skewed, not silently absent', () => {
    doc = publish(b, CANDS, NOW + 60 * 60 * 1000)
    const entries = read()
    expect(entries.has('device-b')).toBe(false)
    expect(entries.skewed.get('device-b')).toBeGreaterThan(30 * 60 * 1000)
  })

  it('a FORGED future-dated entry is not reported as skew', () => {
    doc = publish(a)
    const forged = publish({ ...mallory, deviceId: 'device-b' }, CANDS, NOW + 60 * 60 * 1000)
    expect(read(a, forged).skewed.has('device-b')).toBe(false)
  })

  it('REJECTS a rolled-back entry older than the highest verified ts seen for that device', () => {
    const highWater = tmpHighWater()
    doc = publish(a)
    const newer = publish(b, ['/ip4/34.120.1.50/udp/1'], NOW + 5000, A.clone(doc))
    expect(read(a, newer, NOW + 6000, { highWater }).has('device-b')).toBe(true)
    const rolledBack = publish(b, ['/ip4/34.120.1.51/udp/1'], NOW + 1000, A.clone(doc))
    expect(read(a, rolledBack, NOW + 6000, { highWater }).has('device-b')).toBe(false)
    expect(read(a, newer, NOW + 6000, { highWater }).has('device-b')).toBe(true)
  })

  it('a later publish by the same device replaces its entry (one entry per device)', () => {
    doc = publish(b, CANDS, NOW)
    doc = publish(b, ['/ip4/34.120.1.99/udp/5'], NOW + 5000)
    expect(read(a, doc, NOW + 6000).get('device-b').candidates).toEqual(['/ip4/34.120.1.99/udp/5'])
  })

  it('two devices publishing concurrently both survive a merge (no field clash)', () => {
    const base = publish(a)
    const left = publish(a, ['/ip4/34.120.1.1/udp/1'], NOW + 10, A.clone(base))
    const right = publish(b, ['/ip4/34.120.1.2/udp/2'], NOW + 10, A.clone(base))
    const merged = A.merge(left, right)
    const entries = read(a, merged, NOW + 1000)
    expect(entries.get('device-a').candidates).toEqual(['/ip4/34.120.1.1/udp/1'])
    expect(entries.get('device-b').candidates).toEqual(['/ip4/34.120.1.2/udp/2'])
  })

  it('public neighbours of the blocked ranges still pass', () => {
    for (const ip of ['198.17.255.1', '198.20.0.1', '192.0.3.1', '203.0.114.1', '198.51.101.1']) expect(isPublicAddress('ip4', ip)).toBe(true)
    expect(isPublicAddress('ip6', '2606:4700::1111')).toBe(true)
    expect(isPublicAddress('ip6', '3fff:1000::1')).toBe(true)
    expect(isPublicAddress('ip6', '3ffe::1')).toBe(true)
  })

  it('readReflexive refuses to run without a highWater store', () => {
    doc = publish(b)
    expect(() => readReflexive(doc, { campId: CAMP_ID, registry: deviceRegistryFromDb(a.db), now: () => NOW + 1000 })).toThrow(/highWater/)
  })

  it('a restart does not re-accept a rolled-back entry (highWater persisted)', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'))
    const filePath = path.join(dir, 'hw.json')
    try {
      doc = publish(a)
      const newer = publish(b, ['/ip4/34.120.1.50/udp/1'], NOW + 5000, A.clone(doc))
      const rolledBack = publish(b, ['/ip4/34.120.1.51/udp/1'], NOW + 1000, A.clone(doc))
      expect(read(a, newer, NOW + 6000, { highWater: createHighWaterStore({ filePath }) }).has('device-b')).toBe(true)
      const restarted = createHighWaterStore({ filePath })
      expect(read(a, rolledBack, NOW + 6000, { highWater: restarted }).has('device-b')).toBe(false)
      expect(read(a, newer, NOW + 6000, { highWater: restarted }).has('device-b')).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the highWater store is bounded and persists', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'))
    const filePath = path.join(dir, 'hw.json')
    try {
      const store = createHighWaterStore({ filePath, max: 2 })
      expect(store.failed).toBeNull()
      store.set('x', 1); store.set('y', 2); store.set('z', 3)
      expect(store.get('x')).toBeUndefined()
      expect(createHighWaterStore({ filePath, max: 2 }).get('z')).toBe(3)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a plain Map no longer satisfies the highWater requirement', () => {
    doc = publish(b)
    expect(() => read(a, doc, NOW + 1000, { highWater: new Map() })).toThrow(/highWater/)
  })

  it('createHighWaterStore requires a real filePath', () => {
    expect(() => createHighWaterStore()).toThrow(/filePath/)
    expect(() => createHighWaterStore({ filePath: '' })).toThrow(/filePath/)
  })

  it('a missing store file is a normal first run: no warning, not failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = tmpHighWater()
      expect(store.failed).toBeNull()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('a CORRUPT store is reported and readReflexive FAILS CLOSED instead of starting empty', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'))
    const filePath = path.join(dir, 'hw.json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen = []
    try {
      fs.writeFileSync(filePath, '{not json')
      const store = createHighWaterStore({ filePath, onError: (e) => seen.push(e) })
      expect(store.failed).toBeInstanceOf(Error)
      expect(seen).toHaveLength(1)
      expect(warn).toHaveBeenCalled()
      doc = publish(b)
      const entries = read(a, doc, NOW + 1000, { highWater: store })
      expect(entries.has('device-b')).toBe(false)
      expect(entries.refused).toBeInstanceOf(Error)
    } finally {
      warn.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an UNREADABLE store (a directory at the path) is reported and fails closed', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = createHighWaterStore({ filePath: dir })
      expect(store.failed).toBeInstanceOf(Error)
    } finally {
      warn.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a failed WRITE is surfaced: warned, returned from set(), on lastWriteError, and listed in storeErrors', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen = []
    try {
      const store = createHighWaterStore({ filePath: path.join(dir, 'no-such-dir', 'hw.json'), onError: (e) => seen.push(e) })
      expect(store.failed).toBeNull()
      doc = publish(b)
      const entries = read(a, doc, NOW + 1000, { highWater: store })
      expect(entries.has('device-b')).toBe(true)
      expect(entries.storeErrors).toHaveLength(1)
      expect(store.lastWriteError).toBeInstanceOf(Error)
      expect(seen).toHaveLength(1)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the store write fsyncs the temp file before renaming it into place', async () => {
    const fs = await import('node:fs')
    const order = []
    const realFsync = fs.default.fsyncSync
    const realRename = fs.default.renameSync
    const fsync = vi.spyOn(fs.default, 'fsyncSync').mockImplementation((...a) => { order.push('fsync'); return realFsync(...a) })
    const rename = vi.spyOn(fs.default, 'renameSync').mockImplementation((...a) => { order.push('rename'); return realRename(...a) })
    try {
      tmpHighWater().set('x', 1)
    } finally {
      fsync.mockRestore()
      rename.mockRestore()
    }
    expect(order).toEqual(['fsync', 'rename'])
  })
})
