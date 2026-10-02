// T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) — sign/verify primitives for
// `camp_authority_log` entries. A sibling of tombstoneSignature.js's SHAPE (canonical-message +
// domain-separated signing context), but deliberately NOT a copy of its CRYPTO: tombstones are
// signed Host-only with `host_signing_key` (node:crypto Ed25519, hex-DER pkcs8/spki). This module
// signs with the ACTING device's own `device_identity_key` — every device already has one
// (electron/auth/deviceIdentity.js), stored as a hex-encoded libp2p-protobuf-marshaled keypair,
// not hex-DER. That storage format only round-trips through @libp2p/crypto/keys's own
// sign()/verify(), not node:crypto — so this module uses that API, not authSignature.js/
// tombstoneSignature.js's node:crypto calls.
//
// Verification needs the SIGNER's public key, which this module never stores or receives
// out-of-band: an Ed25519 libp2p PeerId IS the (identity-hashed) public key, recoverable directly
// via peerIdFromString(peerId).publicKey — confirmed empirically (org-source-verification) against
// this repo's pinned @libp2p/peer-id. The signer's peer id is read from the ALREADY-VERIFIED
// camp_authority_log entry that granted them (or the genesis entry for the founder) — never from
// devices.libp2p_peer_id, which peerIdentity.js documents as "a routing convenience only, never a
// trust signal" and which this module must not repurpose into one.
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromString } from '@libp2p/peer-id'

// Domain-separation context — never interchangeable with a tombstone (shoresh-tombstone-sig-v1)
// or auth-field (shoresh-auth-sig-v2) signature. Bump if the signed shape ever changes.
const AUTHORITY_SIG_CONTEXT = 'shoresh-authority-sig-v1'

// Fixed signed-field order, per the ADR: binding kind+target+signer stops a signature minted for
// one (kind, target, signer) triple being replayed as a different one. No `seq` field,
// deliberately — ordering comes from Automerge's own change-dependency graph (authorityReplay.js),
// never from a self-reported counter.
const SIGNED_FIELDS = ['kind', 'target_device_id', 'signer_device_id']

export function canonicalAuthorityMessage(fields) {
  const ordered = SIGNED_FIELDS.map((k) => String(fields?.[k] ?? ''))
  return `${AUTHORITY_SIG_CONTEXT}\n${JSON.stringify(ordered)}`
}

// Signs `fields` with THIS device's own device_identity_key private key. Every device has one
// (ensureDeviceIdentity is called before any sync node starts) — unlike signTombstone, this never
// throws "no key" for an ordinary device; it throws only if ensureDeviceIdentity was genuinely
// never called on this db, which is a wiring bug, not an authority-tier question.
export async function signAuthorityEntry(db, fields) {
  const row = db.prepare('SELECT private_key FROM device_identity_key WHERE id = 1').get()
  if (!row || !row.private_key) {
    throw new Error(
      'signAuthorityEntry: this device has no device_identity_key row — ensureDeviceIdentity must run before signing an authority entry'
    )
  }
  const privateKey = privateKeyFromProtobuf(Buffer.from(row.private_key, 'hex'))
  const sig = await privateKey.sign(Buffer.from(canonicalAuthorityMessage(fields), 'utf8'))
  return Buffer.from(sig).toString('base64url')
}

// Verifies a `camp_authority_log` entry's signature against the SIGNER's libp2p peer id (recovered
// from that signer's own prior grant/genesis entry — see module header). Pure, side-effect-free,
// NEVER throws, and NEVER returns true for junk/wrong/absent input.
export async function verifyAuthorityEntry(signerPeerId, fields, sig) {
  if (typeof signerPeerId !== 'string' || signerPeerId.length === 0) return false
  if (typeof sig !== 'string' || sig.length === 0) return false
  try {
    const peerId = peerIdFromString(signerPeerId)
    if (!peerId.publicKey) return false
    const signature = Buffer.from(sig, 'base64url')
    if (signature.length === 0) return false
    return await peerId.publicKey.verify(Buffer.from(canonicalAuthorityMessage(fields), 'utf8'), signature)
  } catch {
    return false
  }
}
