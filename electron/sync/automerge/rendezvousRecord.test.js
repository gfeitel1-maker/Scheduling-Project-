// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import {
  DOMAIN_PREFIX,
  VERSION,
  CLOCK_SKEW_MS,
  buildSignedBytes,
  signRecord,
  verify,
} from './rendezvousRecord.js'

let keyA
let peerIdA
let keyB
let peerIdB

beforeAll(async () => {
  keyA = await generateKeyPair('Ed25519')
  peerIdA = peerIdFromPrivateKey(keyA).toString()
  keyB = await generateKeyPair('Ed25519')
  peerIdB = peerIdFromPrivateKey(keyB).toString()
})

function baseRecord(overrides = {}) {
  const now = Date.parse('2026-09-18T12:00:00Z')
  return {
    namespace: 'a'.repeat(64),
    peerId: peerIdA,
    epoch: 1,
    seq: 1,
    issuedAt: now,
    expiresAt: now + 2 * 60 * 60 * 1000,
    addresses: ['/ip4/1.2.3.4/tcp/4001', '/ip4/5.6.7.8/tcp/4001'],
    ...overrides,
  }
}

describe('round trip against real Ed25519 keys', () => {
  it('signs and verifies successfully with matching signature/freshness/monotonicity', () => {
    const record = baseRecord()
    const wire = signRecord(record, keyA)
    const verdict = verify(wire, { now: record.issuedAt + 1000, lastEpoch: 0, lastSeq: 0 })
    expect(verdict.ok).toBe(true)
    expect(verdict.signatureValid).toBe(true)
    expect(verdict.fresh).toBe(true)
    expect(verdict.monotonic).toBe(true)
    expect(verdict.record.namespace).toBe(record.namespace)
    expect(verdict.record.peerId).toBe(peerIdA)
    expect(verdict.record.addresses.slice().sort()).toEqual(record.addresses.slice().sort())
  })
})

describe('address-order independence', () => {
  it('produces byte-identical signed material regardless of input address order', () => {
    const record = baseRecord({ addresses: ['/ip4/9.9.9.9/tcp/1', '/ip4/1.1.1.1/tcp/2', '/ip4/5.5.5.5/tcp/3'] })
    const shuffled = { ...record, addresses: [...record.addresses].reverse() }
    expect(buildSignedBytes(record).equals(buildSignedBytes(shuffled))).toBe(true)
  })
})

describe('tamper each field', () => {
  const record = baseRecord()
  let wire
  let sig

  beforeAll(() => {
    wire = signRecord(record, keyA)
    sig = wire.subarray(wire.length - 64)
  })

  const tamperedValues = {
    namespace: 'b'.repeat(64),
    peerId: peerIdB,
    epoch: 999,
    seq: 999,
    issuedAt: record.issuedAt + 1,
    expiresAt: record.expiresAt + 1,
    addresses: ['/ip4/255.255.255.255/tcp/9999'],
  }

  for (const field of Object.keys(tamperedValues)) {
    it(`fails verification when '${field}' is tampered`, () => {
      const tampered = { ...record, [field]: tamperedValues[field] }
      const tamperedSignedBytes = buildSignedBytes(tampered)
      const tamperedWire = Buffer.concat([tamperedSignedBytes, sig])
      const verdict = verify(tamperedWire, { now: record.issuedAt + 1000 })
      expect(verdict.signatureValid).toBe(false)
    })
  }
})

describe('peerId/key mismatch', () => {
  it('a record signed by key A but claiming peerId B fails verification', () => {
    const record = baseRecord({ peerId: peerIdB })
    const wire = signRecord(record, keyA)
    const verdict = verify(wire, { now: record.issuedAt + 1000 })
    expect(verdict.signatureValid).toBe(false)
  })
})

describe('domain separation', () => {
  it('bytes signed under a different domain prefix do not verify as a rendezvous record', () => {
    const record = baseRecord()
    const normalSigned = buildSignedBytes(record)
    const otherPrefix = Buffer.from('OTHERV1\0', 'ascii')
    const foreignSigned = Buffer.concat([otherPrefix, normalSigned.subarray(DOMAIN_PREFIX.length)])
    const signature = keyA.sign(foreignSigned)
    const wire = Buffer.concat([foreignSigned, Buffer.from(signature)])
    const verdict = verify(wire, { now: record.issuedAt + 1000 })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('malformed')
  })
})

describe('unknown version byte', () => {
  it('is rejected outright, without attempting to decode the rest', () => {
    const record = baseRecord()
    const signed = buildSignedBytes(record)
    // Flip only the version byte; leave everything else — including a byte layout that would
    // throw if parsed as fixed-width fields (e.g. we do NOT pad it out to a valid length) — so a
    // clean rejection (not a thrown decode error) proves the version gate runs first.
    const tampered = Buffer.from(signed)
    tampered[DOMAIN_PREFIX.length] = VERSION + 1
    const truncated = tampered.subarray(0, DOMAIN_PREFIX.length + 2) // nowhere near enough to parse further fields
    expect(() => verify(truncated)).not.toThrow()
    const verdict = verify(truncated)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('unsupported_version')
  })
})

describe('malformed / truncated / over-long input', () => {
  const record = baseRecord()
  let wire

  beforeAll(() => {
    wire = signRecord(record, keyA)
  })

  it('rejects a zero-length input', () => {
    const verdict = verify(Buffer.alloc(0))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('malformed')
  })

  it('rejects a truncated record (signature cut short)', () => {
    const verdict = verify(wire.subarray(0, wire.length - 10))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('malformed')
  })

  it('rejects an over-long record (trailing garbage after a valid signature)', () => {
    const verdict = verify(Buffer.concat([wire, Buffer.from([1, 2, 3])]))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('malformed')
  })

  it('rejects a length prefix claiming more bytes than remain in the buffer', () => {
    // Domain prefix + version + 32-byte namespace, then a peerId length prefix (varint) claiming
    // 200 bytes while supplying none.
    const header = Buffer.concat([DOMAIN_PREFIX, Buffer.from([VERSION]), Buffer.alloc(32, 1), Buffer.from([200])])
    const verdict = verify(header)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('malformed')
  })

  it('does not throw on any of the above', () => {
    expect(() => verify(Buffer.alloc(0))).not.toThrow()
    expect(() => verify(Buffer.from([0, 1, 2]))).not.toThrow()
    expect(() => verify(Buffer.concat([wire, Buffer.alloc(500, 9)]))).not.toThrow()
  })
})

describe('clock skew boundaries (injectable clock)', () => {
  const record = baseRecord()
  let wire

  beforeAll(() => {
    wire = signRecord(record, keyA)
  })

  it('accepts exactly at the early boundary (issuedAt - skew)', () => {
    const verdict = verify(wire, { now: record.issuedAt - CLOCK_SKEW_MS })
    expect(verdict.fresh).toBe(true)
  })

  it('rejects just outside the early boundary', () => {
    const verdict = verify(wire, { now: record.issuedAt - CLOCK_SKEW_MS - 1 })
    expect(verdict.fresh).toBe(false)
  })

  it('accepts exactly at the late boundary (expiresAt + skew)', () => {
    const verdict = verify(wire, { now: record.expiresAt + CLOCK_SKEW_MS })
    expect(verdict.fresh).toBe(true)
  })

  it('rejects just outside the late boundary', () => {
    const verdict = verify(wire, { now: record.expiresAt + CLOCK_SKEW_MS + 1 })
    expect(verdict.fresh).toBe(false)
  })
})

describe('monotonicity (epoch-major watermark)', () => {
  const record = baseRecord({ epoch: 5, seq: 10 })
  let wire

  beforeAll(() => {
    wire = signRecord(record, keyA)
  })

  it('rejects an equal (epoch, seq)', () => {
    const verdict = verify(wire, { now: record.issuedAt, lastEpoch: 5, lastSeq: 10 })
    expect(verdict.monotonic).toBe(false)
  })

  it('accepts a higher seq at the same epoch', () => {
    const verdict = verify(wire, { now: record.issuedAt, lastEpoch: 5, lastSeq: 9 })
    expect(verdict.monotonic).toBe(true)
  })

  it('accepts a higher epoch even with a lower seq', () => {
    const verdict = verify(wire, { now: record.issuedAt, lastEpoch: 4, lastSeq: 999 })
    expect(verdict.monotonic).toBe(true)
  })

  it('rejects a lower epoch even with a higher seq', () => {
    const verdict = verify(wire, { now: record.issuedAt, lastEpoch: 6, lastSeq: 0 })
    expect(verdict.monotonic).toBe(false)
  })
})
