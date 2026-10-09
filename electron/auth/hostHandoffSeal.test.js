// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import {
  generateEphemeral,
  buildAad,
  signEphemeral,
  verifyEphemeral,
  seal,
  open,
} from './hostHandoffSeal.js'

const ids = { handoffId: 'h1', campId: 'camp-1', giverDeviceId: 'dev-H', takerDeviceId: 'dev-S' }

async function identity() {
  const privateKey = await generateKeyPair('Ed25519')
  return { privateKey, peerId: peerIdFromPrivateKey(privateKey).toString() }
}

describe('hostHandoffSeal', () => {
  it('seals to the taker and only the taker opens it', async () => {
    const taker = generateEphemeral()
    const sealed = seal({ takerEphemeralPublic: taker.publicKey, plaintext: Buffer.from('secret-key-material'), aad: buildAad(ids) })
    expect(JSON.stringify(sealed)).not.toContain('secret-key-material')
    expect(open({ takerEphemeralPrivate: taker.privateKey, sealed, aad: buildAad(ids) }).toString()).toBe('secret-key-material')

    const other = generateEphemeral()
    expect(() => open({ takerEphemeralPrivate: other.privateKey, sealed, aad: buildAad(ids) })).toThrow()
  })

  it('refuses tampered ciphertext, a tampered tag, and a mismatched AAD', () => {
    const taker = generateEphemeral()
    const sealed = seal({ takerEphemeralPublic: taker.publicKey, plaintext: Buffer.from('payload'), aad: buildAad(ids) })
    const flip = (hex) => (hex.startsWith('0') ? '1' : '0') + hex.slice(1)
    expect(() => open({ takerEphemeralPrivate: taker.privateKey, sealed: { ...sealed, ct: flip(sealed.ct) }, aad: buildAad(ids) })).toThrow()
    expect(() => open({ takerEphemeralPrivate: taker.privateKey, sealed: { ...sealed, tag: flip(sealed.tag) }, aad: buildAad(ids) })).toThrow()
    for (const field of ['handoffId', 'campId', 'giverDeviceId', 'takerDeviceId']) {
      expect(() => open({ takerEphemeralPrivate: taker.privateKey, sealed, aad: buildAad({ ...ids, [field]: 'other' }) })).toThrow()
    }
  })

  it('signs the ephemeral key with the device identity and binds it to the handoff', async () => {
    const dev = await identity()
    const eph = generateEphemeral()
    const sig = await signEphemeral(dev.privateKey, { ...ids, ephemeralPublic: eph.publicKey })
    expect(await verifyEphemeral(dev.peerId, { ...ids, ephemeralPublic: eph.publicKey }, sig)).toBe(true)
    expect(await verifyEphemeral(dev.peerId, { ...ids, handoffId: 'replayed', ephemeralPublic: eph.publicKey }, sig)).toBe(false)
    expect(await verifyEphemeral(dev.peerId, { ...ids, ephemeralPublic: generateEphemeral().publicKey }, sig)).toBe(false)
    const impostor = await identity()
    expect(await verifyEphemeral(impostor.peerId, { ...ids, ephemeralPublic: eph.publicKey }, sig)).toBe(false)
  })
})
