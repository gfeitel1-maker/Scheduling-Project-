// electron/auth/deviceIdentity.js
//
// Per-device persistent libp2p transport identity (ADR:
// docs/adr/2026-09-14-device-identity-and-token-binding.md §1/§2). Distinct
// from host_signing_key (localAuth.js): that key is Host-only and signs
// tokens; this key belongs to EVERY device (Host or Client) and is what
// makes that device's libp2p PeerId stable across restarts, which is the
// precondition the ADR's token-binding design depends on. Generated lazily,
// once, the first time a device runs a sync node — see syncNode.js's
// startSyncNode, which calls this before startTransport.
//
// Storage: same singleton `CHECK (id = 1)` shape as host_signing_key
// (electron/db/schema.sql). Deliberately reuses that shape rather than a
// parallel key-storage scheme (a file on disk, a separate keychain call) —
// electron/db/sqliteCipher.js keys the WHOLE SQLite file with SQLCipher, so
// a secret stored in a SQLite table inherits at-rest encryption automatically
// once T175/SHORESH_AT_REST_ENCRYPTION is activated; a parallel scheme would
// silently miss that.
//
// Encoding: hex-encoded libp2p protobuf-marshaled PrivateKey
// (privateKeyToProtobuf/privateKeyFromProtobuf, @libp2p/crypto/keys) — NOT
// host_signing_key's hex-DER, because this key round-trips through
// createLibp2p's own privateKey option and @libp2p/peer-id's
// peerIdFromPrivateKey, which consume the protobuf marshal format directly.
//
// Never synced: same exclusion class as host_signing_key. This table must
// never be registered in PROJECTIONS, campScopedEntities.js, or
// campDocument.js's MODELED_ENTITIES — see
// electron/db/deviceIdentityKey.migration.test.js's standing guard.
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

export async function ensureDeviceIdentity(db) {
  const existing = db.prepare('SELECT peer_id, private_key FROM device_identity_key WHERE id = 1').get()
  if (existing) {
    const privateKey = privateKeyFromProtobuf(Buffer.from(existing.private_key, 'hex'))
    return { peerId: existing.peer_id, privateKey }
  }

  const privateKey = await generateKeyPair('Ed25519')
  const peerId = peerIdFromPrivateKey(privateKey).toString()
  const privateKeyHex = Buffer.from(privateKeyToProtobuf(privateKey)).toString('hex')

  db.prepare(
    'INSERT INTO device_identity_key (id, peer_id, private_key, created_at) VALUES (1, ?, ?, ?)'
  ).run(peerId, privateKeyHex, new Date().toISOString())

  return { peerId, privateKey }
}
