// Canonical signed rendezvous record: encoding, signing, and verification.
// docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md, Decisions 1 and 2.
// docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md, Section 3 (v2 — encrypted address body).
//
// Pure library code: no network egress, no SQLite, no libp2p node instantiation — only
// @libp2p/crypto key objects (already generated elsewhere, e.g. electron/auth/deviceIdentity.js)
// and @libp2p/peer-id's peerIdFromString. Not imported by electron/main.js or any production
// discovery path; wiring is T211/T288 and is parked.
//
// Signs a FIXED-ORDER, LENGTH-PREFIXED BYTE CONCATENATION, never JSON.stringify — field order and
// number/unicode formatting are not stable across producers, so a JSON-signed record is a
// signature no second implementation could reliably re-verify. See the 2026-09-18 ADR's Decision 1
// for the full reasoning.
//
// V2 (this file, hard cutover — no v1 consumer ever shipped, see the 2026-09-27 ADR Section 3
// point 5): `namespace`, `peerId`, `epoch`, `seq`, `issuedAt`, `expiresAt`, and the signature stay
// PLAINTEXT — self-certification and the Worker's structural checks must work without decrypting
// anything. Only the address list is encrypted, as a single length-prefixed `encryptedAddressBody`
// field (12-byte nonce + AES-256-GCM ciphertext + 16-byte tag) replacing v1's plaintext address
// list, under a key HKDF-derived from the camp-shared `camps.rendezvousAddressKey`
// (rendezvousAddressKey.js) with a fixed, versioned info string — never the raw camp secret
// directly, so a future v3 can derive a different key without rotating the underlying secret.
import crypto from 'node:crypto'
import { peerIdFromString } from '@libp2p/peer-id'

export const DOMAIN_PREFIX = Buffer.from('SHRZV1\0', 'ascii') // 7 bytes — domain tag, unrelated to the record VERSION below
export const VERSION = 2
// Applied at BOTH freshness boundaries (ADR Decision 1): a verifier whose clock is wrong in either
// direction still accepts a genuinely valid record, without materially extending how long a stale
// record survives against a ~2h TTL.
export const CLOCK_SKEW_MS = 5 * 60 * 1000
const SIGNATURE_LENGTH = 64 // Ed25519

export const ADDRESS_KEY_INFO = 'shoresh-rendezvous-addr-v2'
const ADDRESS_KEY_BYTES = 32
const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16

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

// The four fixed-width 8-byte fields, in wire order. Both buildSignedBytes and decode() iterate
// THIS array rather than each independently naming the four fields (T210 round 2, item 4).
const U64_FIELDS = ['epoch', 'seq', 'issuedAt', 'expiresAt']

function namespaceBytes(namespace) {
  const buf = Buffer.from(String(namespace), 'hex')
  if (buf.length !== 32) {
    throw new Error('rendezvousRecord: namespace must be 32 bytes (64 hex chars)')
  }
  return buf
}

// --- address-body encryption (v2) ---------------------------------------------------------------

/**
 * Derive the AES-256-GCM key for the address body from the camp-shared
 * `camps.rendezvousAddressKey` secret (rendezvousAddressKey.js), via HKDF-SHA256 with a fixed,
 * versioned info string. Never uses the raw 32-byte camp secret directly as the AES key.
 */
export function deriveAddressKey(rendezvousAddressKey) {
  const ikm = Buffer.isBuffer(rendezvousAddressKey) ? rendezvousAddressKey : Buffer.from(String(rendezvousAddressKey), 'hex')
  const derived = crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(ADDRESS_KEY_INFO, 'utf8'), ADDRESS_KEY_BYTES)
  return Buffer.from(derived)
}

// Plaintext layout for the address list, encoded before encryption: varint count + length-prefixed
// UTF-8 strings, byte-lexicographically sorted (harmless leftover determinism from v1 — no longer
// buys byte-identical ciphertext across callers, since each encryption uses a fresh random nonce,
// but keeps the plaintext canonical for anyone who does hold the key).
function encodeAddressList(addresses) {
  const encoded = (addresses ?? []).map((addr) => Buffer.from(String(addr), 'utf8'))
  encoded.sort(Buffer.compare)
  return Buffer.concat([writeVarint(encoded.length), ...encoded.map(writeLengthPrefixed)])
}

function decodeAddressList(buf) {
  let offset = 0
  const { value: count, next } = readVarint(buf, offset)
  offset = next
  const addresses = []
  for (let i = 0; i < count; i++) {
    const field = readLengthPrefixed(buf, offset)
    addresses.push(field.bytes.toString('utf8'))
    offset = field.next
  }
  return addresses
}

/** Encrypt the address list under the derived AES key. Returns nonce(12) + ciphertext + tag(16). */
function encryptAddressBody(addresses, addressKey) {
  const derivedKey = deriveAddressKey(addressKey)
  const nonce = crypto.randomBytes(GCM_NONCE_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, nonce)
  const plaintext = encodeAddressList(addresses)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, ciphertext, tag])
}

/**
 * Decrypt an address body. Never throws — a wrong/missing key or tampered ciphertext is a clean
 * { ok: false, reason: 'decrypt_failed' } outcome (org-interface-contracts error-shape discipline),
 * not a crash. This is the LAST step of verification — callers must only invoke it after the
 * record's plaintext fields (signature, freshness, monotonicity) have already passed.
 */
function decryptAddressBody(encryptedAddressBody, addressKey) {
  try {
    if (encryptedAddressBody.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) {
      return { ok: false, reason: 'decrypt_failed' }
    }
    const derivedKey = deriveAddressKey(addressKey)
    const nonce = encryptedAddressBody.subarray(0, GCM_NONCE_BYTES)
    const tag = encryptedAddressBody.subarray(encryptedAddressBody.length - GCM_TAG_BYTES)
    const ciphertext = encryptedAddressBody.subarray(GCM_NONCE_BYTES, encryptedAddressBody.length - GCM_TAG_BYTES)
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, nonce)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return { ok: true, addresses: decodeAddressList(plaintext) }
  } catch {
    return { ok: false, reason: 'decrypt_failed' }
  }
}

/**
 * Build the exact bytes that get signed. `addressKey` is the camp-shared 32-byte secret (or its
 * 64-hex-char string form) from rendezvousAddressKey.js — required, since v2 has no plaintext
 * address path. Encrypts the address list into a single length-prefixed `encryptedAddressBody`
 * field, replacing v1's plaintext address list in the wire layout.
 */
export function buildSignedBytes(record, addressKey) {
  const { namespace, peerId } = record
  const encryptedAddressBody = encryptAddressBody(record.addresses, addressKey)
  return Buffer.concat([
    DOMAIN_PREFIX,
    Buffer.from([VERSION]),
    namespaceBytes(namespace),
    writeLengthPrefixed(Buffer.from(String(peerId), 'utf8')),
    ...U64_FIELDS.map((field) => writeU64BE(record[field])),
    writeLengthPrefixed(encryptedAddressBody),
  ])
}

/**
 * Sign a record with the device's own libp2p Ed25519 identity key (a @libp2p/crypto private key
 * object, e.g. from electron/auth/deviceIdentity.js's ensureDeviceIdentity). Returns the full
 * wire-format bytes: the signed material with a fixed 64-byte Ed25519 signature appended.
 */
export function signRecord(record, privateKey, addressKey) {
  const signedBytes = buildSignedBytes(record, addressKey)
  const signature = privateKey.sign(signedBytes)
  return Buffer.concat([signedBytes, Buffer.from(signature)])
}

// Internal: parse wire bytes into fields. Returns a sentinel object for the two decisions that
// must be made WITHOUT attempting further parsing (malformed prefix, unrecognized version) and
// otherwise returns the decoded record (with the address body still ENCRYPTED — decode() never
// decrypts). Throws for any deeper structural problem (truncated or over-claiming length prefixes,
// truncated fixed-width fields) — callers catch this and turn it into a clean 'malformed' verdict.
function decode(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length < DOMAIN_PREFIX.length + 1) return { malformed: true }
  const prefix = buf.subarray(0, DOMAIN_PREFIX.length)
  if (!prefix.equals(DOMAIN_PREFIX)) return { malformed: true }

  // The version byte is checked, and acted on, before any variable-length field is read. A
  // verifier that does not recognise the version has no code path left that could accept — or
  // even attempt to parse — anything but a well-formed v2 record. This is the anti-downgrade
  // property: a v1 record's version byte (1) is rejected here, outright, never misparsed.
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
  const addressBodyField = readLengthPrefixed(buf, offset)
  offset = addressBodyField.next

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
      encryptedAddressBody: Buffer.from(addressBodyField.bytes),
      signature: Buffer.from(signature).toString('hex'),
    },
    signedBytes,
  }
}

/**
 * Verify a wire-format rendezvous record. Never throws — every malformed shape, unsupported
 * version, invalid signature, staleness, or replay is a distinguishable field on the returned
 * verdict, never an exception and never folded into one boolean.
 *
 * Trust-boundary order (2026-09-27 ADR): version -> structural shape -> signature -> freshness ->
 * monotonicity, ALL as adversarial plaintext input, before any attempt to decrypt the address
 * body. `ok` reflects those five checks only; a failure to decrypt (wrong/missing `addressKey`,
 * e.g. a device that hasn't synced `rendezvousAddressKey` yet) does NOT flip `ok` to false — the
 * record is still authentically the claimed peer's, just "not yet resolvable" rather than
 * malformed (org-interface-contracts error-shape discipline). See `addressBodyDecrypted` /
 * `record.addressBodyError` for that outcome.
 *
 * `lastEpoch`/`lastSeq`: the highest (epoch, seq) this caller has ever accepted for this peer
 * (verifier-side watermark). Defaults to (0, 0). `now`: injectable clock. `addressKey`: the
 * camp-shared secret (rendezvousAddressKey.js) — optional; omit to verify authenticity only.
 */
export function verify(bytes, { lastEpoch = 0, lastSeq = 0, now = Date.now(), addressKey } = {}) {
  let decoded
  try {
    decoded = decode(bytes)
  } catch {
    return { ok: false, reason: 'malformed', addressBodyDecrypted: false }
  }
  if (decoded.malformed) return { ok: false, reason: 'malformed', addressBodyDecrypted: false }
  if (decoded.unsupportedVersion) return { ok: false, reason: 'unsupported_version', addressBodyDecrypted: false }

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
  const ok = signatureValid && fresh && monotonic

  // Decryption is strictly last, and only attempted once the record has passed every plaintext
  // check above — an attacker who cannot produce a valid signature must never be able to use
  // malformed ciphertext to probe the decryption code path at all.
  let addressBodyDecrypted = false
  const { encryptedAddressBody, ...plainFields } = record
  const outRecord = { ...plainFields }
  if (ok) {
    if (!addressKey) {
      outRecord.addressBodyError = 'no_key'
    } else {
      const decrypted = decryptAddressBody(encryptedAddressBody, addressKey)
      if (decrypted.ok) {
        outRecord.addresses = decrypted.addresses
        addressBodyDecrypted = true
      } else {
        outRecord.addressBodyError = decrypted.reason
      }
    }
  }

  return {
    ok,
    reason: ok ? undefined : 'rejected',
    signatureValid,
    fresh,
    monotonic,
    addressBodyDecrypted,
    record: outRecord,
  }
}
