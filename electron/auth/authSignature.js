// Host-signed credential fields — the sign/verify primitives.
// Slice 1 of docs/adr/2026-09-14-users-auth-fields-off-the-replicated-document.md (the Q1 fix).
//
// PROBLEM (Q1, docs/work/security/2026-09-14-Q1-crdt-merge-blast-radius-assessment.md): `users`
// replicates via the Automerge document and the merge→projection path runs no authorize(), so a
// compromised paired device can forge `role`/`pin_hash`/`pin_salt` on every peer — self-promotion
// to admin, or overwriting the admin's PIN. FIX: the Host signs those fields with its existing
// Ed25519 key (host_signing_key — the same key that signs camp tokens); every device verifies the
// signature before applying them, so a device that cannot produce the Host's signature cannot forge
// credentials. This module is ONLY the crypto primitive; nothing calls it in production until slice 2.
//
// Key formats mirror the token path exactly (issueCampToken / verifySessionToken): private key is
// hex DER pkcs8, public key is hex DER spki, Ed25519 via node:crypto sign/verify with algorithm null.
import { sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from 'node:crypto'

// Domain-separation prefix: an auth-field signature must never be interchangeable with a session
// token signature (which signs a base64url payload). Bumped v1→v2 when `cred_version` joined the
// signed tuple (T172 replay defense) — a v1 signature no longer verifies, which is intended: the
// v61 migration re-signs every user at v2. Bump again if the signed shape changes.
const AUTH_SIG_CONTEXT = 'shoresh-auth-sig-v2'

// The fields the signature binds, in fixed order. Binding `id` stops a signature being moved to
// another user; binding the three credential fields stops any one being altered independently; and
// binding `cred_version` — a monotonic per-user counter minted by the Host — stops a REPLAY of an
// older genuinely-signed tuple (T172): projection rejects a verified tuple whose version is not
// newer than the local row's, so an attacker cannot roll an admin back to a prior signed state.
const SIGNED_FIELDS = ['id', 'role', 'pin_hash', 'pin_salt', 'cred_version']

// Canonical, deterministic, UNAMBIGUOUS serialization of the signed fields. Uses JSON.stringify of
// a fixed-order ARRAY (not the input object) so the result cannot depend on the caller's key order,
// and so a value that contains a delimiter cannot be confused with a field boundary (JSON quoting
// handles that — "ab","c" and "a","bc" serialize differently). Exported for the tests that pin it.
export function canonicalAuthMessage(fields) {
  const ordered = SIGNED_FIELDS.map((k) => String(fields?.[k] ?? ''))
  return `${AUTH_SIG_CONTEXT}\n${JSON.stringify(ordered)}`
}

// Sign the credential fields with the Host's private key. HOST-ONLY: throws if this device holds no
// host_signing_key row, exactly like issueCampToken — a client cannot mint credential signatures,
// which is the whole point. Returns a base64url signature string (stored as the `auth_sig` field).
export function signAuthFields(db, fields) {
  const hostKey = db.prepare('SELECT private_key FROM host_signing_key WHERE id = 1').get()
  if (!hostKey || !hostKey.private_key) {
    throw new Error('signAuthFields: this device has no host_signing_key row — only the Host can sign credential fields')
  }
  const privateKeyObj = createPrivateKey({
    key: Buffer.from(hostKey.private_key, 'hex'),
    format: 'der',
    type: 'pkcs8',
  })
  return edSign(null, Buffer.from(canonicalAuthMessage(fields), 'utf8'), privateKeyObj).toString('base64url')
}

// Verify a credential-field signature against a public key (hex DER spki — the value replicated in
// camps.signing_public_key). Pure and side-effect-free so any device can call it. NEVER throws and
// NEVER returns true for junk/wrong/absent input — returns a plain boolean. NOTE for slice 3: an
// ABSENT public key (e.g. a device rebuilt from the document, #401) returns false here; the
// enforcement call site must treat "no key" as keep-last-known / do-not-newly-enforce rather than
// "invalid signature → lock out". That policy lives at the call site, not in this primitive.
export function verifyAuthFields(publicKeyHex, fields, sig) {
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
    return edVerify(null, Buffer.from(canonicalAuthMessage(fields), 'utf8'), publicKeyObj, signature)
  } catch {
    return false
  }
}
