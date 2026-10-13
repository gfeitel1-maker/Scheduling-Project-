// Camp-signed genesis authority entry (docs/adr/2026-10-02-distributed-revocation-authority.md,
// "Amendment 2026-10-13: genesis anchored on the camp signing key"). The founder is the genesis whose
// signature verifies against THIS device's local camps.signing_public_key, the same trust root as the
// device roster (deviceRosterSignature.js). Same primitive and key formats; its own domain-separation
// context so a genesis signature can never verify as a roster, credential, token or authority-entry one.
import { sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from 'node:crypto'

const GENESIS_SIG_CONTEXT = 'shoresh-genesis-sig-v1'
const SIGNED_FIELDS = ['id', 'camp_id', 'target_device_id', 'target_peer_id']

export function canonicalGenesisMessage(fields) {
  return `${GENESIS_SIG_CONTEXT}\n${JSON.stringify(SIGNED_FIELDS.map((k) => String(fields?.[k] ?? '')))}`
}

export function signGenesisEntry(db, fields) {
  const hostKey = db.prepare('SELECT private_key FROM host_signing_key WHERE id = 1').get()
  if (!hostKey?.private_key) {
    throw new Error('signGenesisEntry: this device has no host_signing_key row — only the Host can sign a genesis')
  }
  const privateKey = createPrivateKey({ key: Buffer.from(hostKey.private_key, 'hex'), format: 'der', type: 'pkcs8' })
  return edSign(null, Buffer.from(canonicalGenesisMessage(fields), 'utf8'), privateKey).toString('base64url')
}

export function verifyGenesisEntry(publicKeyHex, fields, sig) {
  if (typeof publicKeyHex !== 'string' || publicKeyHex.length === 0) return false
  if (typeof sig !== 'string' || sig.length === 0) return false
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' })
    const signature = Buffer.from(sig, 'base64url')
    if (signature.length === 0) return false
    return edVerify(null, Buffer.from(canonicalGenesisMessage(fields), 'utf8'), publicKey, signature)
  } catch {
    return false
  }
}

// This device's camp root, read only from local state (never from the document). A device that has not
// yet received the camp key gets publicKey null, which resolves no founder (fail closed).
export function readCampRoot(db) {
  const camp = db.prepare('SELECT id, signing_public_key FROM camps LIMIT 1').get()
  return { campId: camp?.id ?? null, publicKey: camp?.signing_public_key || null }
}
