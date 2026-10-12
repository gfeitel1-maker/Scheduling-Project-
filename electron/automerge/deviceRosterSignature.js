// Host-signed device roster entries (docs/adr/2026-10-12-shared-signed-device-roster.md, T376).
// Same primitive and key formats as electron/auth/authSignature.js (host_signing_key, hex DER pkcs8;
// camps.signing_public_key, hex DER spki; Ed25519), with its own domain-separation context so a roster
// signature can never verify as a credential, token or authority-log signature, or the reverse.
import { sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from 'node:crypto'

const ROSTER_SIG_CONTEXT = 'shoresh-roster-sig-v1'
const SIGNED_FIELDS = ['id', 'camp_id', 'device_id', 'device_peer_id', 'added_at']

export function canonicalRosterMessage(fields) {
  return `${ROSTER_SIG_CONTEXT}\n${JSON.stringify(SIGNED_FIELDS.map((k) => String(fields?.[k] ?? '')))}`
}

export function signRosterEntry(db, fields) {
  const hostKey = db.prepare('SELECT private_key FROM host_signing_key WHERE id = 1').get()
  if (!hostKey?.private_key) {
    throw new Error('signRosterEntry: this device has no host_signing_key row — only the Host can enroll a device')
  }
  const privateKey = createPrivateKey({ key: Buffer.from(hostKey.private_key, 'hex'), format: 'der', type: 'pkcs8' })
  return edSign(null, Buffer.from(canonicalRosterMessage(fields), 'utf8'), privateKey).toString('base64url')
}

export function verifyRosterEntry(publicKeyHex, fields, sig) {
  if (typeof publicKeyHex !== 'string' || publicKeyHex.length === 0) return false
  if (typeof sig !== 'string' || sig.length === 0) return false
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' })
    const signature = Buffer.from(sig, 'base64url')
    if (signature.length === 0) return false
    return edVerify(null, Buffer.from(canonicalRosterMessage(fields), 'utf8'), publicKey, signature)
  } catch {
    return false
  }
}
