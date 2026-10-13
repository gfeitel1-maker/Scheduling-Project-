// Test support: a camp signing keypair and camp-signed genesis fields, so tests can build documents
// whose genesis verifies against a root without standing up a Host database.
import { generateKeyPairSync } from 'node:crypto'
import { signGenesisEntry } from './genesisSignature.js'

export function makeTestCamp(campId = 'camp-test') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('hex')
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex')
  const keyDb = { prepare: () => ({ get: () => ({ private_key: priv }) }) }
  return {
    campId,
    publicKey: pub,
    root: { campId, publicKey: pub },
    genesisFields({ id, deviceId, peerId }) {
      const signature = signGenesisEntry(keyDb, { id, camp_id: campId, target_device_id: deviceId, target_peer_id: peerId })
      return { kind: 'genesis', target_device_id: deviceId, target_peer_id: peerId, signature }
    },
  }
}

// Genesis signature from a REAL Host database (its host_signing_key and camps row), for integration tests that
// write authority entries straight into a document.
export function hostGenesisSignature(hostDb, { id, target_device_id, target_peer_id }) {
  const camp_id = hostDb.prepare('SELECT id FROM camps LIMIT 1').get().id
  return signGenesisEntry(hostDb, { id, camp_id, target_device_id, target_peer_id })
}
