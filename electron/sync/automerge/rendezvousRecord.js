// Canonical signed rendezvous record: encoding, signing, and verification.
// docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md, Decisions 1 and 2.
//
// Pure library code: no network egress, no SQLite, no libp2p node instantiation — only
// @libp2p/crypto key objects (already generated elsewhere, e.g. electron/auth/deviceIdentity.js)
// and @libp2p/peer-id's peerIdFromString. Not imported by electron/main.js or any production
// discovery path; wiring is T211 and is parked (see the ADR's Decision 4).
//
// Signs a FIXED-ORDER, LENGTH-PREFIXED BYTE CONCATENATION, never JSON.stringify — field order and
// number/unicode formatting are not stable across producers, so a JSON-signed record is a
// signature no second implementation could reliably re-verify. See the ADR's Decision 1 for the
// full reasoning.
import { peerIdFromString } from '@libp2p/peer-id'

export const DOMAIN_PREFIX = Buffer.from('SHRZV1\0', 'ascii') // 7 bytes
export const VERSION = 1
// Applied at BOTH freshness boundaries (ADR Decision 1): a verifier whose clock is wrong in either
// direction still accepts a genuinely valid record, without materially extending how long a stale
// record survives against a ~2h TTL.
export const CLOCK_SKEW_MS = 5 * 60 * 1000
const SIGNATURE_LENGTH = 64 // Ed25519

// --- unsigned varint (LEB128) ------------------------------------------------------------------

function writeVarint(n) {
  const bytes = []
  let value = n
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80)
    value = Math.floor(value / 128)
  }
  bytes.push(value)
  return Buffer.from(bytes)
}

// Throws on a truncated or absurdly large varint — both are malformed input, not a value to trust.
function readVarint(buf, offset) {
  let result = 0
  let multiplier = 1
  let pos = offset
  for (;;) {
    if (pos >= buf.length) throw new Error('rendezvousRecord: truncated varint')
    const byte = buf[pos]
    pos++
    result += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) break
    multiplier *= 128
    if (pos - offset > 7) throw new Error('rendezvousRecord: varint too large')
  }
  if (!Number.isSafeInteger(result)) throw new Error('rendezvousRecord: varint too large')
  return { value: result, next: pos }
}

function readBytes(buf, offset, length) {
  if (length < 0 || offset + length > buf.length) throw new Error('rendezvousRecord: truncated field')
  return buf.subarray(offset, offset + length)
}

function readLengthPrefixed(buf, offset) {
  const { value: length, next } = readVarint(buf, offset)
  const bytes = readBytes(buf, next, length)
  return { bytes, next: next + length }
}

function writeLengthPrefixed(bytes) {
  return Buffer.concat([writeVarint(bytes.length), Buffer.from(bytes)])
}

// Symmetric with readVarint's Number.isSafeInteger guard below: a u64 field above
// Number.MAX_SAFE_INTEGER (2^53-1) cannot round-trip through a JS Number, and epoch/seq feed the
// monotonicity comparison directly — refuse to encode one rather than write bytes that would
// decode to a rounded, wrong value.
function writeU64BE(n) {
  if (!Number.isSafeInteger(n)) throw new Error('rendezvousRecord: u64 field exceeds Number.MAX_SAFE_INTEGER')
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(n))
  return buf
}

function readU64BE(buf, offset) {
  if (offset + 8 > buf.length) throw new Error('rendezvousRecord: truncated u64')
  const value = buf.readBigUInt64BE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('rendezvousRecord: u64 field exceeds Number.MAX_SAFE_INTEGER')
  }
  return Number(value)
}

// Byte-lexicographic sort of the UTF-8 encoded addresses. This is what makes two callers who
// assembled the same address set in different orders sign identical bytes (ADR Decision 1).
function sortedAddressBytes(addresses) {
  const encoded = addresses.map((addr) => Buffer.from(String(addr), 'utf8'))
  encoded.sort(Buffer.compare)
  return encoded
}

// The four fixed-width 8-byte fields, in wire order. Both buildSignedBytes and decode() iterate
// THIS array rather than each independently naming the four fields — item 4 of the T210 round-2
// review found the two sides enumerating the same sequence by hand, with nothing but the test
// suite forcing them to agree. `namespace`, `peerId` and `addresses` stay hand-paired below
// (namespaceBytes/readBytes(32) and writeLengthPrefixed/readLengthPrefixed are already the same
// shared helpers on both sides, and addresses is a variable-length list with its own count prefix)
// — a single generic table spanning all 7 fields would have to abstract three genuinely different
// shapes (fixed 32 bytes, one length-prefixed scalar, four identical u64s, a counted list) for one
// real win, so only the part that is actually a duplicated identical shape is unified.
const U64_FIELDS = ['epoch', 'seq', 'issuedAt', 'expiresAt']

function namespaceBytes(namespace) {
  const buf = Buffer.from(String(namespace), 'hex')
  if (buf.length !== 32) {
    throw new Error('rendezvousRecord: namespace must be 32 bytes (64 hex chars)')
  }
  return buf
}

/**
 * Build the exact bytes that get signed (ADR Decision 1's layout). Pure — addresses are sorted
 * internally, so callers never need to pre-sort, and two logically-identical records with
 * differently-ordered address arrays produce byte-identical output.
 */
export function buildSignedBytes(record) {
  const { namespace, peerId, addresses } = record
  const addressList = sortedAddressBytes(addresses ?? [])
  return Buffer.concat([
    DOMAIN_PREFIX,
    Buffer.from([VERSION]),
    namespaceBytes(namespace),
    writeLengthPrefixed(Buffer.from(String(peerId), 'utf8')),
    ...U64_FIELDS.map((field) => writeU64BE(record[field])),
    writeVarint(addressList.length),
    ...addressList.map(writeLengthPrefixed),
  ])
}

/**
 * Sign a record with the device's own libp2p Ed25519 identity key (a @libp2p/crypto private key
 * object, e.g. from electron/auth/deviceIdentity.js's ensureDeviceIdentity). Returns the full
 * wire-format bytes: the signed material with a fixed 64-byte Ed25519 signature appended.
 */
export function signRecord(record, privateKey) {
  const signedBytes = buildSignedBytes(record)
  const signature = privateKey.sign(signedBytes)
  return Buffer.concat([signedBytes, Buffer.from(signature)])
}

// Internal: parse wire bytes into fields. Returns a sentinel object for the two decisions that
// must be made WITHOUT attempting further parsing (malformed prefix, unrecognized version) and
// otherwise returns the decoded record. Throws for any deeper structural problem (truncated or
// over-claiming length prefixes, truncated fixed-width fields) — callers catch this and turn it
// into a clean 'malformed' verdict; nothing here is meant to escape uncaught.
function decode(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length < DOMAIN_PREFIX.length + 1) return { malformed: true }
  const prefix = buf.subarray(0, DOMAIN_PREFIX.length)
  if (!prefix.equals(DOMAIN_PREFIX)) return { malformed: true }

  // The version byte is checked, and acted on, before any variable-length field is read. A
  // verifier that does not recognise the version has no code path left that could accept — or
  // even attempt to parse — anything but a well-formed v1 record.
  const version = buf[DOMAIN_PREFIX.length]
  if (version !== VERSION) return { unsupportedVersion: true }

  let offset = DOMAIN_PREFIX.length + 1
  const namespace = readBytes(buf, offset, 32)
  offset += 32
  const peerIdField = readLengthPrefixed(buf, offset)
  offset = peerIdField.next
  const u64s = {}
  for (const field of U64_FIELDS) {
    u64s[field] = readU64BE(buf, offset)
    offset += 8
  }
  const { epoch, seq, issuedAt, expiresAt } = u64s
  const { value: addressCount, next: afterCount } = readVarint(buf, offset)
  offset = afterCount
  const addresses = []
  for (let i = 0; i < addressCount; i++) {
    const field = readLengthPrefixed(buf, offset)
    addresses.push(field.bytes.toString('utf8'))
    offset = field.next
  }

  const signedBytes = buf.subarray(0, offset)
  const signature = buf.subarray(offset)
  if (signature.length !== SIGNATURE_LENGTH) return { malformed: true }

  // An inverted window (expiresAt before issuedAt) can only be a bug or an attack — there is no
  // legitimate record for which it is true. Reject it here, before the two independent boundary
  // comparisons in verify()'s `fresh` check, rather than let two separately-passing comparisons
  // reason about a window that never made sense.
  if (expiresAt < issuedAt) return { malformed: true }

  return {
    record: {
      namespace: namespace.toString('hex'),
      peerId: peerIdField.bytes.toString('utf8'),
      epoch,
      seq,
      issuedAt,
      expiresAt,
      addresses,
      signature: Buffer.from(signature).toString('hex'),
    },
    signedBytes,
  }
}

/**
 * Verify a wire-format rendezvous record. Never throws — every malformed shape, unsupported
 * version, invalid signature, staleness, or replay is a distinguishable field on the returned
 * verdict, never an exception and never folded into one boolean (T211's caller needs to log them
 * apart).
 *
 * `lastEpoch`/`lastSeq`: the highest (epoch, seq) this caller has ever accepted for this peer
 * (ADR Decision 2's verifier-side watermark). Defaults to (0, 0) — "nothing seen yet" — so a
 * caller that has no watermark can still call this and get a decidable answer.
 * `now`: injectable clock, so freshness is testable without relying on wall-clock time.
 */
export function verify(bytes, { lastEpoch = 0, lastSeq = 0, now = Date.now() } = {}) {
  let decoded
  try {
    decoded = decode(bytes)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (decoded.malformed) return { ok: false, reason: 'malformed' }
  if (decoded.unsupportedVersion) return { ok: false, reason: 'unsupported_version' }

  const { record, signedBytes } = decoded

  let signatureValid = false
  try {
    const publicKey = peerIdFromString(record.peerId).publicKey
    signatureValid = publicKey ? Boolean(publicKey.verify(signedBytes, Buffer.from(record.signature, 'hex'))) : false
  } catch {
    signatureValid = false
  }

  const fresh = record.issuedAt - CLOCK_SKEW_MS <= now && now <= record.expiresAt + CLOCK_SKEW_MS

  const monotonic = record.epoch > lastEpoch || (record.epoch === lastEpoch && record.seq > lastSeq)

  return {
    ok: signatureValid && fresh && monotonic,
    reason: signatureValid && fresh && monotonic ? undefined : 'rejected',
    signatureValid,
    fresh,
    monotonic,
    record,
  }
}
