// Sealing for the planned host handoff (docs/adr/2026-10-09-host-succession-simple.md, "Sealing").
//
// The successor (taker) sends a fresh X25519 public key signed by its device identity key; the
// current host (giver) answers with its own fresh X25519 key and an AES-256-GCM ciphertext under
// HKDF-SHA256(ECDH). Both keys are ephemeral, so a recorded stream decrypts to nothing later. The
// AAD binds the handoff, the camp and both device ids, so a ciphertext cannot be replayed into a
// different handoff. node:crypto only. Pure: no database, no transport.
import {
  generateKeyPairSync,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import { peerIdFromString } from '@libp2p/peer-id'

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const HKDF_INFO = Buffer.from('shoresh-host-handoff-v1')

export function generateEphemeral() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(X25519_SPKI_PREFIX.length).toString('hex'),
    privateKey,
  }
}

function publicKeyObject(hex) {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' })
}

export function buildAad({ handoffId, campId, giverDeviceId, takerDeviceId }) {
  return Buffer.from([handoffId, campId, giverDeviceId, takerDeviceId].join('|'))
}

function deriveKey(privateKey, peerPublicHex, aad) {
  const shared = diffieHellman({ privateKey, publicKey: publicKeyObject(peerPublicHex) })
  return Buffer.from(hkdfSync('sha256', shared, aad, HKDF_INFO, 32))
}

function acceptBytes({ handoffId, campId, giverDeviceId, takerDeviceId, ephemeralPublic }) {
  return Buffer.from(['handoff-accept', handoffId, campId, giverDeviceId, takerDeviceId, ephemeralPublic].join('|'))
}

export async function signEphemeral(devicePrivateKey, fields) {
  return Buffer.from(await devicePrivateKey.sign(acceptBytes(fields))).toString('hex')
}

export async function verifyEphemeral(takerPeerId, fields, signatureHex) {
  try {
    const publicKey = peerIdFromString(takerPeerId).publicKey
    if (!publicKey) return false
    return Boolean(await publicKey.verify(acceptBytes(fields), Buffer.from(signatureHex, 'hex')))
  } catch {
    return false
  }
}

export function seal({ takerEphemeralPublic, plaintext, aad }) {
  const giver = generateKeyPairSync('x25519')
  const giverPublic = giver.publicKey.export({ format: 'der', type: 'spki' }).subarray(X25519_SPKI_PREFIX.length).toString('hex')
  const key = deriveKey(giver.privateKey, takerEphemeralPublic, aad)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { ephemeralPublic: giverPublic, iv: iv.toString('hex'), ct: ct.toString('hex'), tag: cipher.getAuthTag().toString('hex') }
}

export function open({ takerEphemeralPrivate, sealed, aad }) {
  const key = deriveKey(takerEphemeralPrivate, sealed.ephemeralPublic, aad)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'hex'))
  decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'hex')), decipher.final()])
}

