// The camp join code and the mDNS tag derived from it — the first-join half of
// LAN discovery. See docs/adr/2026-09-08-libp2p-join-flow.md.
//
// WHY THIS EXISTS. ../sync/automerge/discovery.js scopes mDNS by
// campDiscoveryTag(campId), which answers "how does a device that already
// knows its camp find its Host". It structurally cannot answer "how does a
// BRAND NEW device find its Host", because its input is the very campId that
// device does not have yet. That gap is what this module fills, and it hands
// straight back to campDiscoveryTag the moment the joining device has
// projected a camps row (see the ADR's step 8). Nothing here is used by a
// device that has already paired.
//
// WHAT THE CODE IS. A short, human-typeable label derived from the camp id and
// shown on the Host's Add-a-device screen. It is NOT a secret and must never be
// treated as one: it is displayed on a screen, and anyone holding the campId
// can compute it. It grants discoverability of a Host that is already
// advertising itself, during a window a director deliberately opened — nothing
// more. Director approval (pairing_request), PIN authentication, mutual auth,
// and authorize() all still stand in front of any data. If that threat model
// ever changes, the correct move is to make the code an ephemeral Host-minted
// secret; the flow a person sees does not change, only the derivation below.
//
// WIRE COMPATIBILITY — read before changing anything here, and read
// ./campIdHash.js's note of the same name first. joinDiscoveryTag's output is
// an mDNS serviceTag, and mDNS matches on that string EXACTLY: a node only ever
// sees answers from nodes advertising the identical value. Changing the
// alphabet, the length, the hash, or the normalization changes what goes on the
// wire, and two devices on different app versions would simply stop finding
// each other — no error, no warning, nothing in a log. The symptom a director
// reports is "the new iPad says the code is wrong". joinCode.test.js pins fixed
// vectors for exactly this reason; if one fails, updating the expectation hides
// the break rather than fixing it.
//
// PRIVACY. Both derivations are one-way, and neither ever sees camps.name — the
// same guarantee ./campIdHash.js already makes for the camp tag. What goes on
// the LAN is a hash of a hash of the camp id.
import crypto from 'node:crypto'

// Crockford base32: no I, L, O, or U. The first three are dropped because they
// are unreadable next to 1 and 0 in the fonts this code will actually be read
// in (a Host screen across a room, a phone photo, a whiteboard); U is dropped
// by Crockford to avoid accidental obscenities. `normalizeJoinCode` below
// undoes the reader's inevitable I/l→1 and O→0 substitutions rather than
// telling a director their correctly-copied code is wrong.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// 8 chars × 5 bits = 40 bits = exactly the first 5 bytes of the digest, so the
// encoding below never has to deal with a partial final group. 40 bits is far
// more than "how many camps are on one LAN" needs; the length is chosen for
// what a person can read off a screen and type without losing their place,
// which is why it is displayed grouped as XXXX-XXXX.
const CODE_CHARS = 8
const CODE_BYTES = 5

const TAG_PREFIX = '_shoresh-join-'
const TAG_SUFFIX = '._udp.local'

function base32Crockford(bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

/**
 * campId -> the 8-character join code shown on the Host. Pure and stable: the
 * same camp always shows the same code, so there is no "the code expired, ask
 * the director again" failure mode in the field.
 */
export function joinCode(campId) {
  if (typeof campId !== 'string' || campId.length === 0) {
    throw new Error('joinCode requires a non-empty campId string')
  }
  const digest = crypto.createHash('sha256').update(campId).digest()
  return base32Crockford(digest.subarray(0, CODE_BYTES)).slice(0, CODE_CHARS)
}

/**
 * Display form: `K4P72MRQ` -> `K4P7-2MRQ`. Grouping is presentation only —
 * never pass this to joinDiscoveryTag without normalizing (it normalizes
 * anyway, but relying on that by accident is how a second, subtly different
 * formatting rule gets invented somewhere else).
 */
export function formatJoinCode(code) {
  const normalized = normalizeJoinCode(code)
  if (normalized === null) return null
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
}

/**
 * What the director typed -> the canonical code, or null if it cannot be one.
 *
 * Forgiving in exactly the ways a person is wrong and unforgiving otherwise:
 * case, spaces, and dashes are noise; I/l and O are the substitutions a reader
 * makes for 1 and 0 and are corrected rather than rejected. Anything else —
 * wrong length, a character outside the alphabet — is a genuine typo and
 * returns null so the caller can say so, rather than silently deriving a tag
 * that will never match anything and presenting it as "no camps found".
 */
export function normalizeJoinCode(input) {
  if (typeof input !== 'string') return null
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
  if (cleaned.length !== CODE_CHARS) return null
  for (const ch of cleaned) {
    if (!CROCKFORD.includes(ch)) return null
  }
  return cleaned
}

/**
 * A join code -> the mDNS serviceTag the Host advertises while its
 * Add-a-device window is open, and the joining device searches on. Accepts any
 * form a person may have typed (see normalizeJoinCode); throws on input that
 * is not a code at all, because deriving a tag from nonsense would surface to
 * the director as a silent "no camps found" rather than "that code is wrong".
 */
export function joinDiscoveryTag(code) {
  const normalized = normalizeJoinCode(code)
  if (normalized === null) {
    throw new Error('joinDiscoveryTag requires a valid 8-character join code')
  }
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  return `${TAG_PREFIX}${hash}${TAG_SUFFIX}`
}

/**
 * Convenience for the Host, which holds a campId rather than a typed string.
 * Deliberately routed through joinCode + joinDiscoveryTag rather than hashing
 * the campId directly: the Host must advertise the tag a CLIENT will compute
 * from the code, and a second derivation path is how those two drift apart.
 */
export function joinDiscoveryTagForCamp(campId) {
  return joinDiscoveryTag(joinCode(campId))
}
