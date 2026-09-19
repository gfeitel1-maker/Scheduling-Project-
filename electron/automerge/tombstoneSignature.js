// T233: signed purge-tombstone sign/verify primitives — a sibling of
// electron/auth/authSignature.js's CREDENTIAL_FIELDS pattern (see
// docs/adr/2026-09-19-multi-device-erasure-propagation.md), not new machinery.
//
// A tombstone is presence, not absence: it names a purged record's id, its
// target entity type, and a monotonic version, and is Host-signed exactly like
// a users credential change. Enforcement (verify + monotonicity) happens at
// projection time in electron/automerge/projector.js, not here — this module
// is only the crypto primitive.
//
// Key formats mirror authSignature.js/the token path exactly: private key is
// hex DER pkcs8, public key is hex DER spki, Ed25519 via node:crypto sign/verify.
import { sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from 'node:crypto'

// Domain-separation context — a tombstone signature must never be interchangeable with an
// auth-field signature (shoresh-auth-sig-v2) or a session token signature. Bump if the signed
// shape ever changes.
const TOMBSTONE_SIG_CONTEXT = 'shoresh-tombstone-sig-v1'

// The fields the signature binds, in fixed order: the tombstoned target's id, its entity type,
// and a monotonic version. Binding `id`+`entity` together stops a tombstone minted for one
// record/entity pair being replayed against another; binding `version` stops a replay of an
// older genuinely-signed tombstone from rolling a fleet back to a lower version (anti-backdating —
// see the ADR's "Applied in causal order is not a real mechanism here" correction).
const SIGNED_FIELDS = ['id', 'entity', 'version']

// Canonical, deterministic, unambiguous serialization — same JSON.stringify-of-fixed-order-array
// approach as authSignature.js's canonicalAuthMessage, for the same reasons (caller key order
// cannot affect the result; JSON quoting prevents delimiter confusion). Exported for tests that
// pin it.
export function canonicalTombstoneMessage(fields) {
  const ordered = SIGNED_FIELDS.map((k) => String(fields?.[k] ?? ''))
  return `${TOMBSTONE_SIG_CONTEXT}\n${JSON.stringify(ordered)}`
}

// Sign a tombstone's fields with the Host's private key. HOST-ONLY: throws if this device holds
// no host_signing_key row — only the Host can mint a tombstone, exactly like signAuthFields.
// Returns a base64url signature string.
export function signTombstone(db, fields) {
  const hostKey = db.prepare('SELECT private_key FROM host_signing_key WHERE id = 1').get()
  if (!hostKey || !hostKey.private_key) {
    throw new Error('signTombstone: this device has no host_signing_key row — only the Host can sign a purge tombstone')
  }
  const privateKeyObj = createPrivateKey({
    key: Buffer.from(hostKey.private_key, 'hex'),
    format: 'der',
    type: 'pkcs8',
  })
  return edSign(null, Buffer.from(canonicalTombstoneMessage(fields), 'utf8'), privateKeyObj).toString('base64url')
}

// Verify a tombstone signature against a public key (hex DER spki — the trust root read from the
// local camps.signing_public_key column, NEVER from the document — see the ADR's Security F1
// correction). Pure and side-effect-free. NEVER throws and NEVER returns true for junk/wrong/
// absent input — returns a plain boolean.
export function verifyTombstone(publicKeyHex, fields, sig) {
  if (typeof publicKeyHex !== 'string' || publicKeyHex.length === 0) return false
  if (typeof sig !== 'string' || sig.length === 0) return false
  try {
    const publicKeyObj = createPublicKey({
      key: Buffer.from(publicKeyHex, 'hex'),
      format: 'der',
      type: 'spki',
    })
    const signature = Buffer.from(sig, 'base64url')
    if (signature.length === 0) return false
    return edVerify(null, Buffer.from(canonicalTombstoneMessage(fields), 'utf8'), publicKeyObj, signature)
  } catch {
    return false
  }
}
