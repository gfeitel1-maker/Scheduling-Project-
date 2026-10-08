// T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) — sign/verify primitives for
// `camp_authority_log` entries. A sibling of tombstoneSignature.js's SHAPE (canonical-message +
// domain-separated signing context + node:crypto SYNCHRONOUS Ed25519 sign/verify, matching every
// other signature primitive in this codebase — projector.js's verify-and-replay loop is
// synchronous, inside better-sqlite3 transactions, and must stay that way), but NOT a copy of its
// CUSTODY: tombstones are signed Host-only with `host_signing_key`. This module signs with the
// ACTING device's own `device_identity_key` — every device already has one
// (electron/auth/deviceIdentity.js), stored as a hex-encoded libp2p-protobuf-marshaled Ed25519
// keypair, not node:crypto's hex-DER.
//
// org-source-verification (confirmed empirically against this repo's pinned @libp2p/crypto):
// Ed25519 signatures are DETERMINISTIC (RFC 8032) — a signature produced via node:crypto and one
// produced via @libp2p/crypto's own (async) sign() over the same key material are byte-identical,
// and each verifies under the other's verify(). This lets this module use node:crypto's
// SYNCHRONOUS sign/verify throughout (no new async boundary in the projection hot path) while
// still interoperating with every other place this codebase already uses @libp2p/crypto for the
// SAME key material (deviceIdentity.js, libp2p's own Noise handshake). The private key's `.raw`
// (64 bytes: 32-byte seed + 32-byte public key) and the public key's `.raw` (32 bytes) are wrapped
// in the minimal, fixed Ed25519 PKCS8/SPKI DER prefixes (RFC 8410) node:crypto requires — the same
// trick tombstoneSignature.js/authSignature.js already rely on for their own hex-DER key material,
// applied here to libp2p's raw key bytes instead.
//
// Verification needs the SIGNER's public key, which this module never stores or receives
// out-of-band: an Ed25519 libp2p PeerId IS the (identity-hashed) public key, recoverable directly
// via peerIdFromString(peerId).publicKey.raw. The signer's peer id is read from the ALREADY-
// VERIFIED camp_authority_log entry that granted them (or the genesis entry for the founder) —
// never from devices.libp2p_peer_id, which peerIdentity.js documents as "a routing convenience
// only, never a trust signal" and which this module must not repurpose into one.
import { sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from 'node:crypto'
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromString } from '@libp2p/peer-id'

// Domain-separation context — never interchangeable with a tombstone (shoresh-tombstone-sig-v1)
// or auth-field (shoresh-auth-sig-v2) signature. v2 (round-3 correction): the signed shape gained
// `id` — see SIGNED_FIELDS below — so this is bumped to make the two shapes structurally
// non-interchangeable even if a future bug ever tried to verify a v1-shaped message against a
// v2 signer or vice versa (pre-production; no v1-signed entry has ever shipped).
const AUTHORITY_SIG_CONTEXT = 'shoresh-authority-sig-v2'

// Fixed signed-field order. `id` — the entry's own camp_authority_log record id — is bound
// DELIBERATELY (round-3 security correction): without it, a genuine signed (kind, target, signer)
// tuple captured off one entry verifies equally well under a BRAND-NEW record id, letting a
// captured grant be replayed into the document again after a later revoke has already superseded
// it — resurrecting a removed device while the original signer is still (legitimately) a valid
// admin, with no forged signature required. Binding `id` means a replayed tuple only verifies
// under the SAME id it was originally signed for, and authorityReplay.js's entry map is keyed by
// id, so an identical id is an idempotent no-op, not a fresh signal. No `seq` field, deliberately
// — ordering comes from Automerge's own change-dependency graph (authorityReplay.js), never from
// a self-reported counter.
const SIGNED_FIELDS = ['id', 'kind', 'target_device_id', 'signer_device_id']

// RFC 8410 fixed prefixes for a RAW (headerless) Ed25519 key: PKCS8 wraps a 32-byte private seed,
// SPKI wraps a 32-byte public key. Confirmed empirically (org-source-verification) against this
// repo's pinned node:crypto/libp2p versions: a node:crypto key built from these prefixes
// sign/verifies identically to @libp2p/crypto's own Ed25519 operations over the same raw bytes.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function canonicalAuthorityMessage(fields) {
  const ordered = SIGNED_FIELDS.map((k) => String(fields?.[k] ?? ''))
  return `${AUTHORITY_SIG_CONTEXT}\n${JSON.stringify(ordered)}`
}

// Signs `fields` with THIS device's own device_identity_key private key. Every device has one
// (ensureDeviceIdentity is called before any sync node starts) — unlike signTombstone, this never
// throws "no key" for an ordinary device; it throws only if ensureDeviceIdentity was genuinely
// never called on this db, which is a wiring bug, not an authority-tier question.
export function signAuthorityEntry(db, fields) {
  return signMessageWithDeviceKey(db, canonicalAuthorityMessage(fields))
}

// The device-identity Ed25519 signing step, factored out so other camp-peer-signed payloads
// (punchGossip.js, punchSignaling.js) sign with the SAME key custody under their OWN
// domain-separated message contexts rather than a second copy of the key plumbing.
export function signMessageWithDeviceKey(db, message) {
  const row = db.prepare('SELECT private_key FROM device_identity_key WHERE id = 1').get()
  if (!row || !row.private_key) {
    throw new Error(
      'signAuthorityEntry: this device has no device_identity_key row — ensureDeviceIdentity must run before signing an authority entry'
    )
  }
  const libp2pKey = privateKeyFromProtobuf(Buffer.from(row.private_key, 'hex'))
  const seed = Buffer.from(libp2pKey.raw).subarray(0, 32)
  const privateKeyObj = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
  return edSign(null, Buffer.from(message, 'utf8'), privateKeyObj).toString('base64url')
}

// Verifies a `camp_authority_log` entry's signature against the SIGNER's libp2p peer id (recovered
// from that signer's own prior grant/genesis entry — see module header). Pure, side-effect-free,
// synchronous (callable from projector.js's existing sync transaction loop), NEVER throws, and
// NEVER returns true for junk/wrong/absent input.
export function verifyAuthorityEntry(signerPeerId, fields, sig) {
  return verifyMessageWithPeerId(signerPeerId, canonicalAuthorityMessage(fields), sig)
}

// Pure counterpart of signMessageWithDeviceKey: verifies `sig` over `message` against the public
// key recovered from an Ed25519 libp2p peer id. NEVER throws; false for junk/wrong/absent input.
export function verifyMessageWithPeerId(signerPeerId, message, sig) {
  if (typeof signerPeerId !== 'string' || signerPeerId.length === 0) return false
  if (typeof sig !== 'string' || sig.length === 0) return false
  try {
    const peerId = peerIdFromString(signerPeerId)
    if (!peerId.publicKey || !peerId.publicKey.raw || peerId.publicKey.raw.length !== 32) return false
    const publicKeyObj = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(peerId.publicKey.raw)]),
      format: 'der',
      type: 'spki',
    })
    const signature = Buffer.from(sig, 'base64url')
    if (signature.length === 0) return false
    return edVerify(null, Buffer.from(message, 'utf8'), publicKeyObj, signature)
  } catch {
    return false
  }
}
