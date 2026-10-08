// S3 / Rung 2 of the relay-less cross-network reconnect
// (docs/adr/2026-10-08-relayless-cross-network-reconnect.md, "Rung 2"; the mechanism T338 sketched).
//
// Each device publishes ITS OWN reflexive-address entry {deviceId, peerId, candidates, ts} into the
// camp Automerge document, signed with its T331 device identity key and encrypted under the camp
// key, so a peer learns another device's current address over ordinary authenticated sync and
// never from a third party.
//
// WHERE IT LIVES (docs/current/WHERE_DATA_LIVES.md): document only, no SQLite table and no schema
// change - exactly like `camps.rendezvousAddressKey`. One field per device on the camp's own `camps`
// record (`punchGossip_<deviceId>`), so two devices never write the same field and a merge cannot
// clash. PROJECTIONS.camps.fields is ['name'], so the projector never touches these fields.
//
// TRUST: nothing here is trusted from the document. A reader verifies the signature against the
// peer id the LOCAL registry has bound to that deviceId (devices.libp2p_peer_id, the TOFU bind from
// admission), and drops revoked / unauthorized / unknown devices, stale or future-dated entries,
// and anything over the size bounds - before decrypting an oversize value, and before trusting a
// decrypted one.
import crypto from 'node:crypto'
import * as A from '@automerge/automerge'
import { recordKey, readRecord } from '../../automerge/campDocument.js'
import { signMessageWithDeviceKey, verifyMessageWithPeerId } from '../../automerge/authorityLogSignature.js'
import { deviceTrustStatus } from '../../auth/deviceTrust.js'
import { mintRendezvousAddressKey, readRendezvousAddressKey } from './rendezvousAddressKey.js'

export const GOSSIP_FIELD_PREFIX = 'punchGossip_'
export const GOSSIP_TTL_MS = 10 * 60 * 1000
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
export const MAX_CANDIDATES = 8
export const MAX_CANDIDATE_CHARS = 128
export const MAX_VALUE_CHARS = 4096
const MAX_ENTRIES_READ = 64
const GOSSIP_SIG_CONTEXT = 'shoresh-punch-gossip-sig-v1'
const GOSSIP_KEY_INFO = 'shoresh-punch-gossip-v1'
const CANDIDATE_RE = /^\/ip[46]\/[^/]+\/udp\/\d{1,5}$/
const NONCE_BYTES = 12
const TAG_BYTES = 16

function campKeyFor(addressKeyHex) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(addressKeyHex, 'hex'), Buffer.alloc(0), Buffer.from(GOSSIP_KEY_INFO, 'utf8'), 32))
}

function canonicalMessage({ deviceId, peerId, ts, candidates }) {
  return `${GOSSIP_SIG_CONTEXT}\n${JSON.stringify([deviceId, peerId, ts, candidates])}`
}

function validCandidates(candidates) {
  return (
    Array.isArray(candidates) &&
    candidates.length <= MAX_CANDIDATES &&
    candidates.every((c) => typeof c === 'string' && c.length <= MAX_CANDIDATE_CHARS && CANDIDATE_RE.test(c))
  )
}

// Signs and encrypts WITHOUT validating bounds; publishReflexive validates first. Exported so a
// test can build the hostile-but-correctly-signed entry that a reader must still refuse.
export function sealGossipEntry(db, { addressKey, deviceId, peerId, candidates, ts, signMessage = signMessageWithDeviceKey }) {
  const sig = signMessage(db, canonicalMessage({ deviceId, peerId, ts, candidates }))
  const nonce = crypto.randomBytes(NONCE_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', campKeyFor(addressKey), nonce)
  const body = Buffer.concat([cipher.update(JSON.stringify({ deviceId, peerId, ts, candidates, sig }), 'utf8'), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')
}

function openGossipValue(value, addressKey) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE_CHARS) return null
  try {
    const raw = Buffer.from(value, 'base64')
    if (raw.length < NONCE_BYTES + TAG_BYTES) return null
    const decipher = crypto.createDecipheriv('aes-256-gcm', campKeyFor(addressKey), raw.subarray(0, NONCE_BYTES))
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
    const plain = Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)), decipher.final()])
    const entry = JSON.parse(plain.toString('utf8'))
    return entry && typeof entry === 'object' ? entry : null
  } catch {
    return null
  }
}

/**
 * The local device registry both rung-2 modules trust: a device is usable only when it is
 * authorized, not revoked (devices.revoked_at or the T331 authority_cache), and bound to a peer id.
 * Queried fresh on every call so a revocation takes effect at once.
 */
export function deviceRegistryFromDb(db) {
  const trusted = (row) => {
    if (!row?.libp2p_peer_id) return false
    const trust = deviceTrustStatus(db, row.id)
    if (!trust.authorized || trust.revoked) return false
    return db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(row.id)?.status !== 'revoked'
  }
  return {
    peerIdForDevice(deviceId) {
      if (typeof deviceId !== 'string') return null
      const row = db.prepare('SELECT id, libp2p_peer_id FROM devices WHERE id = ?').get(deviceId)
      return trusted(row) ? row.libp2p_peer_id : null
    },
    deviceIdForPeer(peerId) {
      if (typeof peerId !== 'string') return null
      const row = db.prepare('SELECT id, libp2p_peer_id FROM devices WHERE libp2p_peer_id = ?').get(peerId)
      return trusted(row) ? row.id : null
    },
  }
}

/**
 * Returns the document with this device's entry written (minting the camp key if the camp has none
 * yet). Throws on an out-of-bounds candidate list: a device must never publish what readers drop.
 */
export function publishReflexive(doc, db, { campId, deviceId, peerId, candidates, now = Date.now, signMessage }) {
  if (!validCandidates(candidates)) {
    throw new Error(`punchGossip: candidates must be at most ${MAX_CANDIDATES} udp multiaddrs of at most ${MAX_CANDIDATE_CHARS} chars (bad candidate list)`)
  }
  const { doc: keyed, addressKey } = mintRendezvousAddressKey(doc, campId)
  const value = sealGossipEntry(db, { addressKey, deviceId, peerId, candidates, ts: now(), signMessage })
  return A.change(keyed, (d) => {
    if (!d.camps) d.camps = {}
    d.camps[recordKey(campId, `${GOSSIP_FIELD_PREFIX}${deviceId}`)] = value
  })
}

/** Map<deviceId, {deviceId, peerId, candidates, ts}> of every entry that passed every check. */
export function readReflexive(doc, { campId, registry, now = Date.now }) {
  const out = new Map()
  const addressKey = readRendezvousAddressKey(doc, campId)
  const row = readRecord(doc, 'camps', campId)
  if (!addressKey || !row) return out
  const at = now()
  let seen = 0
  for (const field of Object.keys(row)) {
    if (!field.startsWith(GOSSIP_FIELD_PREFIX)) continue
    if (++seen > MAX_ENTRIES_READ) break
    const deviceId = field.slice(GOSSIP_FIELD_PREFIX.length)
    const entry = openGossipValue(row[field], addressKey)
    if (!entry || entry.deviceId !== deviceId) continue
    if (typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) continue
    if (at - entry.ts > GOSSIP_TTL_MS || entry.ts - at > MAX_FUTURE_SKEW_MS) continue
    if (!validCandidates(entry.candidates)) continue
    const boundPeerId = registry.peerIdForDevice(deviceId)
    if (!boundPeerId || entry.peerId !== boundPeerId) continue
    if (!verifyMessageWithPeerId(boundPeerId, canonicalMessage(entry), entry.sig)) continue
    out.set(deviceId, { deviceId, peerId: boundPeerId, candidates: entry.candidates, ts: entry.ts })
  }
  return out
}
