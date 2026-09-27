// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import {
  DOMAIN_PREFIX,
  VERSION,
  CLOCK_SKEW_MS,
  ADDRESS_KEY_INFO,
  buildSignedBytes,
  signRecord,
  verify,
  deriveAddressKey,
} from './rendezvousRecord.js'

let keyA
let peerIdA
let keyB
let peerIdB
let addressKey
let otherAddressKey

beforeAll(async () => {
  keyA = await generateKeyPair('Ed25519')
  peerIdA = peerIdFromPrivateKey(keyA).toString()
  keyB = await generateKeyPair('Ed25519')
  peerIdB = peerIdFromPrivateKey(keyB).toString()
  addressKey = Buffer.alloc(32, 7)
  otherAddressKey = Buffer.alloc(32, 9)
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

describe('deriveAddressKey', () => {
  it('derives a 32-byte key via HKDF-SHA256 with the fixed versioned info string', () => {
    const derived = deriveAddressKey(addressKey)
    expect(Buffer.isBuffer(derived)).toBe(true)
    expect(derived.length).toBe(32)
    // Deterministic: same camp key -> same derived key every time.
    expect(deriveAddressKey(addressKey).equals(derived)).toBe(true)
  })

  it('a different camp key derives a different address key', () => {
    expect(deriveAddressKey(addressKey).equals(deriveAddressKey(otherAddressKey))).toBe(false)
  })

  it('is scoped by a fixed, versioned info string', () => {
    expect(ADDRESS_KEY_INFO).toBe('shoresh-rendezvous-addr-v2')
  })
})

describe('round trip against real Ed25519 keys and the camp address key', () => {
  it('signs and verifies successfully, decrypting the address body with the right key', () => {
    const record = baseRecord()
    const wire = signRecord(record, keyA, addressKey)
    const verdict = verify(wire, { now: record.issuedAt + 1000, lastEpoch: 0, lastSeq: 0, addressKey })
    expect(verdict.ok).toBe(true)
    expect(verdict.signatureValid).toBe(true)
    expect(verdict.fresh).toBe(true)
    expect(verdict.monotonic).toBe(true)
    expect(verdict.record.namespace).toBe(record.namespace)
    expect(verdict.record.peerId).toBe(peerIdA)
    expect(verdict.addressBodyDecrypted).toBe(true)
    expect(verdict.record.addresses.slice().sort()).toEqual(record.addresses.slice().sort())
  })
})

describe('key custody: a namespace-holder without the camp key cannot recover addresses', () => {
  it('the record is still authentic (signature/freshness/monotonicity pass) with no addressKey supplied', () => {
    const record = baseRecord()
    const wire = signRecord(record, keyA, addressKey)
    const verdict = verify(wire, { now: record.issuedAt + 1000 })
    expect(verdict.ok).toBe(true)
    expect(verdict.signatureValid).toBe(true)
    expect(verdict.addressBodyDecrypted).toBe(false)
    expect(verdict.record.addresses).toBeUndefined()
    expect(verdict.record.addressBodyError).toBe('no_key')
  })

  it('decryption fails cleanly (not a crash, not malformed) with the WRONG camp key', () => {
    const record = baseRecord()
    const wire = signRecord(record, keyA, addressKey)
    const verdict = verify(wire, { now: record.issuedAt + 1000, addressKey: otherAddressKey })
    expect(verdict.ok).toBe(true) // the record itself is still authentic
    expect(verdict.signatureValid).toBe(true)
    expect(verdict.addressBodyDecrypted).toBe(false)
    expect(verdict.record.addresses).toBeUndefined()
    expect(verdict.record.addressBodyError).toBe('decrypt_failed')
  })
})

describe('the worker/wire sees only ciphertext for the address body', () => {
  it('no plaintext address substring appears anywhere in the signed wire bytes', () => {
    const record = baseRecord({ addresses: ['/ip4/203.0.113.7/tcp/4001', '/ip4/198.51.100.9/tcp/4001'] })
    const wire = signRecord(record, keyA, addressKey)
    const asBase64 = wire.toString('base64')
    for (const addr of record.addresses) {
      expect(wire.includes(Buffer.from(addr, 'utf8'))).toBe(false)
      expect(asBase64.includes(addr)).toBe(false)
    }
  })
})

describe('tamper each field (including the encrypted address body)', () => {
  const record = baseRecord()
  let wire
  let sig

  beforeAll(() => {
    wire = signRecord(record, keyA, addressKey)
    sig = wire.subarray(wire.length - 64)
  })

  const tamperedValues = {
    namespace: 'b'.repeat(64),
    peerId: peerIdB,
    epoch: 999,
    seq: 999,
    issuedAt: record.issuedAt + 1,
    expiresAt: record.expiresAt + 1,
  }

  for (const field of Object.keys(tamperedValues)) {
    it(`fails verification when '${field}' is tampered`, () => {
      const tampered = { ...record, [field]: tamperedValues[field] }
      const tamperedSignedBytes = buildSignedBytes(tampered, addressKey)
      const tamperedWire = Buffer.concat([tamperedSignedBytes, sig])
      const verdict = verify(tamperedWire, { now: record.issuedAt + 1000, addressKey })
      expect(verdict.signatureValid).toBe(false)
    })
  }

  it('fails verification when the ciphertext bytes of the address body are flipped', () => {
    const buf = Buffer.from(wire)
    // Flip a byte inside the encrypted-address-body region (after the fixed header, before the
    // trailing 64-byte signature) — anywhere in there is ciphertext or its GCM tag.
    const flipOffset = DOMAIN_PREFIX.length + 1 + 32 + 40 // well past the fixed-width header fields
    buf[flipOffset] ^= 0xff
    const verdict = verify(buf, { now: record.issuedAt + 1000, addressKey })
    expect(verdict.signatureValid).toBe(false)
  })
})

describe('peerId/key mismatch', () => {
  it('a record signed by key A but claiming peerId B fails verification', () => {
    const record = baseRecord({ peerId: peerIdB })
    const wire = signRecord(record, keyA, addressKey)
    const verdict = verify(wire, { now: record.issuedAt + 1000, addressKey })
    expect(verdict.signatureValid).toBe(false)
  })
})

describe('domain separation', () => {
  it('bytes signed under a different domain prefix do not verify as a rendezvous record', () => {
    const record = baseRecord()
    const normalSigned = buildSignedBytes(record, addressKey)
    const otherPrefix = Buffer.from('OTHERV1\0', 'ascii')
    const foreignSigned = Buffer.concat([otherPrefix, normalSigned.subarray(DOMAIN_PREFIX.length)])
    const signature = keyA.sign(foreignSigned)
    const wire = Buffer.concat([foreignSigned, Buffer.from(signature)])
    const verdict = verify(wire, { now: record.issuedAt + 1000, addressKey })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('malformed')
  })
})

describe('anti-downgrade: version byte is checked first and unconditionally', () => {
  it('the current (v2) verifier rejects a v1-shaped record outright, without attempting to decrypt', () => {
    const record = baseRecord()
    const signed = buildSignedBytes(record, addressKey)
    const tampered = Buffer.from(signed)
    tampered[DOMAIN_PREFIX.length] = 1 // a v1 record's version byte
    const verdict = verify(tampered, { addressKey })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('unsupported_version')
  })

  it('an unknown future version byte is rejected outright, without attempting to decode the rest', () => {
    const record = baseRecord()
    const signed = buildSignedBytes(record, addressKey)
    const tampered = Buffer.from(signed)
    tampered[DOMAIN_PREFIX.length] = VERSION + 1
    const truncated = tampered.subarray(0, DOMAIN_PREFIX.length + 2)
    expect(() => verify(truncated)).not.toThrow()
    const verdict = verify(truncated)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('unsupported_version')
  })

  it('a hypothetical v1-only verifier (version === 1 check) would reject a real v2 wire record', () => {
    const record = baseRecord()
    const wire = signRecord(record, keyA, addressKey)
    const versionByte = wire[DOMAIN_PREFIX.length]
    expect(versionByte).toBe(VERSION)
    expect(versionByte).not.toBe(1)
  })
})

describe('malformed / truncated / over-long input', () => {
  const record = baseRecord()
  let wire

  beforeAll(() => {
    wire = signRecord(record, keyA, addressKey)
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
    wire = signRecord(record, keyA, addressKey)
  })

  it('accepts exactly at the early boundary (issuedAt - skew)', () => {
    const verdict = verify(wire, { now: record.issuedAt - CLOCK_SKEW_MS, addressKey })
    expect(verdict.fresh).toBe(true)
  })

  it('rejects just outside the early boundary', () => {
    const verdict = verify(wire, { now: record.issuedAt - CLOCK_SKEW_MS - 1, addressKey })
    expect(verdict.fresh).toBe(false)
  })

  it('accepts exactly at the late boundary (expiresAt + skew)', () => {
    const verdict = verify(wire, { now: record.expiresAt + CLOCK_SKEW_MS, addressKey })
    expect(verdict.fresh).toBe(true)
  })

  it('rejects just outside the late boundary', () => {
    const verdict = verify(wire, { now: record.expiresAt + CLOCK_SKEW_MS + 1, addressKey })
    expect(verdict.fresh).toBe(false)
  })
})

describe('monotonicity (epoch-major watermark)', () => {
  const record = baseRecord({ epoch: 5, seq: 10 })
  let wire

  beforeAll(() => {
    wire = signRecord(record, keyA, addressKey)
  })

  it('rejects an equal (epoch, seq)', () => {
    const verdict = verify(wire, { now: record.issuedAt, lastEpoch: 5, lastSeq: 10, addressKey })
    expect(verdict.monotonic).toBe(false)
  })

  it('accepts a higher seq at the same epoch', () => {
    const verdict = verify(wire, { now: record.issuedAt, lastEpoch: 5, lastSeq: 9, addressKey })
    expect(verdict.monotonic).toBe(true)
  })

  it('accepts a higher epoch even with a lower seq', () => {
    const verdict = verify(wire, { now: record.issuedAt, lastEpoch: 4, lastSeq: 999, addressKey })
    expect(verdict.monotonic).toBe(true)
  })

  it('rejects a lower epoch even with a higher seq', () => {
    const verdict = verify(wire, { now: record.issuedAt, lastEpoch: 6, lastSeq: 0, addressKey })
    expect(verdict.monotonic).toBe(false)
  })

  it('trust-boundary order: monotonicity/freshness/signature are checked before any decryption is attempted', () => {
    // A record that fails monotonicity must not even attempt to decrypt (and must not crash if
    // given a garbage addressKey) — decryption is strictly last per the ADR's trust-boundary order.
    const verdict = verify(wire, { now: record.issuedAt, lastEpoch: 5, lastSeq: 10, addressKey: Buffer.alloc(32) })
    expect(verdict.ok).toBe(false)
    expect(verdict.addressBodyDecrypted).toBe(false)
  })
})

// T210 round 2, item 3: readU64BE used to do `Number(bigint)`, silently rounding above
// Number.MAX_SAFE_INTEGER (2^53-1) — its sibling readVarint already enforces
// Number.isSafeInteger, but the four u64 fields (epoch, seq, issuedAt, expiresAt) feed the
// monotonicity comparison directly, so two distinct u64s above the safe-integer boundary could
// decode to the same rounded Number and be treated as equal/monotonic when they are not.
describe('u64 fields reject values above Number.MAX_SAFE_INTEGER (no silent rounding)', () => {
  const UNSAFE = Number.MAX_SAFE_INTEGER + 2 // an even integer just past the boundary
  const boundaryRecordFor = (field) => baseRecord({ [field]: UNSAFE })

  for (const field of ['epoch', 'seq', 'issuedAt', 'expiresAt']) {
    it(`buildSignedBytes refuses to encode an unsafe ${field}`, () => {
      expect(() => buildSignedBytes(boundaryRecordFor(field), addressKey)).toThrow()
    })

    it(`verify() rejects a decoded wire record whose ${field} was written unsafely large`, () => {
      const record = baseRecord({ [field]: Number.MAX_SAFE_INTEGER })
      const wire = signRecord(record, keyA, addressKey)
      const buf = Buffer.from(wire)
      const fieldOffsets = { epoch: 0, seq: 8, issuedAt: 16, expiresAt: 24 }
      const namespaceLen = 32
      const peerIdFieldLen = 1 + Buffer.byteLength(peerIdA, 'utf8') // varint(<128) + utf8 bytes
      const u64Start = DOMAIN_PREFIX.length + 1 + namespaceLen + peerIdFieldLen
      const offset = u64Start + fieldOffsets[field]
      buf.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 2n, offset)

      const verdict = verify(buf, { now: record.issuedAt, addressKey })
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toBe('malformed')
    })
  }
})

// T210 round 2, item 5: verify() did not check issuedAt <= expiresAt. Decision: reject an inverted
// record as malformed — it can only be a bug or an attack, and rejecting it before running the two
// independent boundary comparisons is cheaper than reasoning about what an inverted window means.
describe('inverted issuedAt/expiresAt window is rejected as malformed', () => {
  it('rejects a record whose expiresAt is before its issuedAt', () => {
    const now = Date.parse('2026-09-18T12:00:00Z')
    const record = baseRecord({ issuedAt: now, expiresAt: now - 1000 })
    const wire = signRecord(record, keyA, addressKey)
    const verdict = verify(wire, { now, addressKey })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('malformed')
  })

  it('accepts a record whose expiresAt equals issuedAt (zero-width but not inverted)', () => {
    const now = Date.parse('2026-09-18T12:00:00Z')
    const record = baseRecord({ issuedAt: now, expiresAt: now })
    const wire = signRecord(record, keyA, addressKey)
    const verdict = verify(wire, { now, addressKey })
    expect(verdict.ok).toBe(true)
  })
})
