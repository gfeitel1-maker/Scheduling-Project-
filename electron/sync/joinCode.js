// The join secret, its scrypt-hardened rendezvous tag, and the join proof —
// the pre-identity half of a device joining a camp over LAN mDNS today, and
// (once Slice C ships) over the public DHT. See docs/adr/2026-09-08-libp2p-join-flow.md
// for the original flow and docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md
// + docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md §4 (T286) for why this
// module no longer derives anything from the campId.
//
// WHAT CHANGED (T286). Until this ticket, the "join code" was
// `base32Crockford(sha256(campId)[:5])` — permanent, deterministic, and not a
// secret (anyone who learns the campId can compute it). That was defensible on
// a LAN, where the mDNS tag is broadcast in the clear anyway and the join
// PROOF (below) is what actually keeps an impostor out. It stops being
// defensible the moment discovery becomes public (a DHT): the tag published to
// a public DHT is then a cheap offline path back to the code. So the code is
// now:
//   - RANDOM, never a function of the campId (mintJoinSecret) — minted by the
//     Host when a director opens "Add a device".
//   - EPHEMERAL — the caller (main.js) discards it the moment the Add-a-device
//     window closes; a new window mints a new secret.
//   - Rendezvous-tagged via a SLOW KDF (scrypt), not a bare hash, so a captured
//     tag cannot be ground back to the secret at effectively zero cost per
//     guess (see joinDiscoveryTag below for the chosen parameters and the
//     measured cost).
//
// WHAT DID NOT CHANGE. The person-facing flow: a director still reads a short
// grouped code off a screen, the joiner still types it. The join PROOF
// mechanism (an HMAC over the code, exchanged by both sides before anything
// that matters happens) is unchanged in shape — only what's fed into it
// (a minted secret instead of a campId-derived one) is different.
//
// WIRE COMPATIBILITY. joinDiscoveryTag's output is an mDNS serviceTag, matched
// EXACTLY by both sides. Changing the alphabet, the length, the KDF, or its
// parameters changes what goes on the wire — a hard cutover, acceptable
// pre-production (no field installs of the old derivation exist to break).
import crypto from 'node:crypto'

// Crockford base32: no I, L, O, or U. The first three are dropped because they
// are unreadable next to 1 and 0 in the fonts this code will actually be read
// in (a Host screen across a room, a phone photo, a whiteboard); U is dropped
// by Crockford to avoid accidental obscenities. `normalizeJoinCode` below
// undoes the reader's inevitable I/l→1 and O→0 substitutions rather than
// telling a director their correctly-copied code is wrong.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// 10 chars × 5 bits = 50 bits — the owner-ruled length (2026-09-15: "go, 10
// chars"), reached from the 2026-09-27 ADR's corrected entropy math: at the
// scrypt cost measured below, 2^50 offline guesses is ~3.5 million CPU-YEARS,
// infeasible within the secret's own ephemeral (minutes-long) window. 7 random
// bytes (56 bits) are drawn and truncated to the first 10 Crockford characters
// (50 bits) — the same "draw slightly more, keep only what's needed" pattern
// the old 8-char/5-byte derivation used when 5 bytes divided evenly instead.
const CODE_CHARS = 10
const CODE_BYTES = 7

const TAG_PREFIX = '_shoresh-join-'
const TAG_SUFFIX = '._udp.local'

// scrypt parameters for the rendezvous tag (joinDiscoveryTag below).
//
// MEASURED, not assumed — 2026-09-27 ADR §4 attack 1 requires this: the
// design only promises infeasible offline brute force if the REAL, benchmarked
// cost is in the ~100ms/guess band, not whatever N/r/p happens to look right
// on paper. Measured on this dev machine (node -e microbenchmark, 7 runs,
// Node v25.8.1, darwin/x64): N=32768, r=8, p=1 -> mean 112.7ms/guess (range
// 103.6-128.8ms). joinCode.test.js re-measures this and asserts the real cost
// stays in a defensible band (50-600ms) so a future Node/libuv change that
// silently made scrypt faster would fail loud rather than quietly erode the
// margin.
//
// Memory: scrypt needs ~128*N*r bytes = 128*32768*8 = 32 MiB. maxmem is set
// above that (not left at Node's 32 MiB default, which is exactly the memory
// this needs and would be one rounding error from throwing
// ERR_CRYPTO_INVALID_SCRYPT_PARAMS on some builds).
export const JOIN_TAG_SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
const JOIN_TAG_KEYLEN = 32
// Fixed, not random: this is not password-at-rest storage (there is no stored
// hash to protect from a rainbow table across many users) — it is a KDF used
// once, synchronously, to derive a rendezvous tag from a single secret this
// process already holds. A fixed salt makes the tag deterministic (both sides
// must derive the SAME tag from the SAME secret, exactly like the old
// sha256-based derivation was), and does not weaken the offline-brute-force
// argument, which already assumes the attacker knows every public constant
// (the salt, N/r/p) and is grinding candidate SECRETS.
const JOIN_TAG_SALT = Buffer.from('shoresh-join-tag-v1')

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
 * A fresh, random join secret — 10 Crockford chars / 50 bits, never a
 * function of anything about the camp. The caller (main.js) mints one when
 * the director opens "Add a device" and discards it when the window closes;
 * this module has no notion of that lifecycle, only of producing a secret
 * that cannot be predicted from anything an attacker could already know.
 */
export function mintJoinSecret() {
  const bytes = crypto.randomBytes(CODE_BYTES)
  return base32Crockford(bytes).slice(0, CODE_CHARS)
}

/**
 * Display form: `K4P72MRQ7B` -> `K4P72-MRQ7B`. Grouping is presentation only —
 * never pass this to joinDiscoveryTag without normalizing (it normalizes
 * anyway, but relying on that by accident is how a second, subtly different
 * formatting rule gets invented somewhere else).
 */
export function formatJoinCode(code) {
  const normalized = normalizeJoinCode(code)
  if (normalized === null) return null
  const half = CODE_CHARS / 2
  return `${normalized.slice(0, half)}-${normalized.slice(half)}`
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
 * A join code/secret -> the mDNS serviceTag the Host advertises while its
 * Add-a-device window is open, and the joining device searches on. Accepts
 * any form a person may have typed (see normalizeJoinCode); throws on input
 * that is not a code at all, because deriving a tag from nonsense would
 * surface to the director as a silent "no camps found" rather than "that code
 * is wrong".
 *
 * Derived via scrypt (see JOIN_TAG_SCRYPT_PARAMS above), not a bare hash: a
 * tag published to a public rendezvous (Slice C) is otherwise a cheap offline
 * path back to the 50-bit secret. On a LAN today this also raises the bar
 * for the same attack over mDNS, at the cost of ~100ms per derivation — paid
 * once by the Host (opening the window) and once by the joiner (typing the
 * code), both imperceptible.
 */
export function joinDiscoveryTag(code) {
  const normalized = normalizeJoinCode(code)
  if (normalized === null) {
    throw new Error(`joinDiscoveryTag requires a valid ${CODE_CHARS}-character join code`)
  }
  const key = crypto.scryptSync(normalized, JOIN_TAG_SALT, JOIN_TAG_KEYLEN, JOIN_TAG_SCRYPT_PARAMS)
  const hash = key.toString('hex').slice(0, 16)
  return `${TAG_PREFIX}${hash}${TAG_SUFFIX}`
}

// ---------------------------------------------------------------------------
// Proof of code knowledge.
//
// WHY THIS EXISTS. The mDNS service tag is BROADCAST IN THE CLEAR; that is
// what mDNS is. So an attacker on the LAN never has to guess the secret at
// all: they watch the Host advertise the tag and advertise the identical tag
// themselves, which costs nothing and requires no knowledge of the secret. A
// joining device then discovers (or races to) the attacker, and because the
// attacker approves its own pairing request, the director's approval protects
// nothing — the joining device sends the user's PIN to the attacker, which
// answers with its own camp and becomes that device's permanent trust root.
//
// Both legitimate parties already hold the secret; nobody who merely mirrored
// the tag does. So each side proves it holds the secret before anything that
// matters happens:
//
//   joiner -> host  : nonce + joinProof(secret, nonce, 'joiner')
//   host   -> joiner: joinProof(secret, nonce, 'host')   (on the pairing reply)
//
// The joining device verifies the Host's half BEFORE it sends a PIN, and
// before it writes a camps row or calls admitPeer. An attacker who mirrored
// the tag can produce neither half, because producing either requires the
// secret itself, not the (public) tag derived from it.
//
// The two roles are separate labels so neither half can be reflected back as
// the other — the classic mistake when both sides HMAC "the same nonce".
//
// This is proof of a SHARED, LOW-ENTROPY, DISPLAYED value, not a key
// exchange: it establishes "this peer was told the secret by the director",
// exactly the human trust anchor the flow is built on, and nothing more. It
// is not forward-secret and does not authenticate anything after the join.
const JOIN_PROOF_ROLES = ['joiner', 'host']

export function joinProof(code, nonce, role) {
  const normalized = normalizeJoinCode(code)
  if (normalized === null) throw new Error('joinProof requires a valid join code')
  if (typeof nonce !== 'string' || nonce.length < 16) {
    throw new Error('joinProof requires a nonce of at least 16 characters')
  }
  if (!JOIN_PROOF_ROLES.includes(role)) {
    throw new Error(`joinProof role must be one of ${JOIN_PROOF_ROLES.join(', ')}`)
  }
  return crypto.createHmac('sha256', normalized).update(`${role}|${nonce}`).digest('hex')
}

/** Timing-safe check. Returns false — never throws — for anything malformed, so
 * a caller can treat "bad proof" and "no proof" identically at the call site. */
export function verifyJoinProof(code, nonce, role, provided) {
  if (typeof provided !== 'string') return false
  let expected
  try {
    expected = joinProof(code, nonce, role)
  } catch {
    return false
  }
  if (expected.length !== provided.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'))
  } catch {
    return false
  }
}

/** A fresh nonce for one join attempt. 32 hex chars = 128 bits, so a Host's
 * reply can never be replayed against a different attempt. */
export function newJoinNonce() {
  return crypto.randomBytes(16).toString('hex')
}
