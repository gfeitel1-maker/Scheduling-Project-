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
import net from 'node:net'
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
const CANDIDATE_RE = /^\/(ip4|ip6)\/([^/]+)\/udp\/(\d{1,5})$/
const NONCE_BYTES = 12
const TAG_BYTES = 16

function campKeyFor(addressKeyHex) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(addressKeyHex, 'hex'), Buffer.alloc(0), Buffer.from(GOSSIP_KEY_INFO, 'utf8'), 32))
}

function canonicalMessage({ deviceId, peerId, ts, candidates }) {
  return `${GOSSIP_SIG_CONTEXT}\n${JSON.stringify([deviceId, peerId, ts, candidates])}`
}

// Public unicast only: a gossip candidate is dialled by every camp peer, so a private, loopback,
// link-local, CGNAT, multicast, unspecified or IPv4-mapped address would aim the dial at the
// reader's own network (a hostile-but-valid peer's SSRF-style probe).
export function isPublicAddress(version, ip) {
  if (version === 'ip4') {
    if (net.isIPv4(ip) === false) return false
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    return true
  }
  if (!net.isIPv6(ip)) return false
  let host
  try {
    host = new URL(`http://[${ip}]`).hostname.slice(1, -1)
  } catch {
    return false
  }
  const groups = host.split(':')
  if (host.startsWith('::ffff:')) return false
  const first = parseInt(groups[0] || '0', 16)
  if (host.startsWith('::')) {
    const rest = groups.filter(Boolean)
    if (rest.length <= 2) return false
  }
  if ((first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00 || (first & 0xff00) === 0xff00) return false
  return true
}

function validCandidate(c, allowPrivate) {
  if (typeof c !== 'string' || c.length > MAX_CANDIDATE_CHARS) return false
  const m = CANDIDATE_RE.exec(c)
  if (!m) return false
  const port = Number(m[3])
  if (port < 1 || port > 65535) return false
  return allowPrivate || isPublicAddress(m[1], m[2])
}

function validCandidates(candidates, allowPrivate = false) {
  return Array.isArray(candidates) && candidates.length <= MAX_CANDIDATES && candidates.every((c) => validCandidate(c, allowPrivate))
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
export function publishReflexive(doc, db, { campId, deviceId, peerId, candidates, now = Date.now, signMessage, allowPrivateCandidates = false }) {
  if (!validCandidates(candidates, allowPrivateCandidates)) {
    throw new Error(`punchGossip: candidates must be at most ${MAX_CANDIDATES} public udp multiaddrs of at most ${MAX_CANDIDATE_CHARS} chars (bad candidate list)`)
  }
  const { doc: keyed, addressKey } = mintRendezvousAddressKey(doc, campId)
  const value = sealGossipEntry(db, { addressKey, deviceId, peerId, candidates, ts: now(), signMessage })
  return A.change(keyed, (d) => {
    if (!d.camps) d.camps = {}
    d.camps[recordKey(campId, `${GOSSIP_FIELD_PREFIX}${deviceId}`)] = value
  })
}

/**
 * Map<deviceId, {deviceId, peerId, candidates, ts}> of every entry that passed every check. The
 * returned map carries `.skewed`: Map<deviceId, skewMs> of correctly signed entries refused only
 * because they are dated beyond the future-skew bound - the sender's clock disagrees with ours, and
 * the caller must surface that rather than treat it as "no entry".
 *
 * highWater (optional Map<deviceId, ts>) is the reader's memory of the newest verified ts per
 * device: an entry older than it is a rolled-back document value and is refused.
 * allowPrivateCandidates is for loopback test fixtures only.
 */
export function readReflexive(doc, { campId, registry, now = Date.now, highWater, allowPrivateCandidates = false }) {
  const out = new Map()
  out.skewed = new Map()
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
    if (!validCandidates(entry.candidates, allowPrivateCandidates)) continue
    const boundPeerId = registry.peerIdForDevice(deviceId)
    if (!boundPeerId || entry.peerId !== boundPeerId) continue
    if (!verifyMessageWithPeerId(boundPeerId, canonicalMessage(entry), entry.sig)) continue
    if (entry.ts - at > MAX_FUTURE_SKEW_MS) {
      out.skewed.set(deviceId, entry.ts - at)
      continue
    }
    if (at - entry.ts > GOSSIP_TTL_MS) continue
    if (highWater) {
      if (entry.ts < (highWater.get(deviceId) ?? -Infinity)) continue
      highWater.set(deviceId, entry.ts)
    }
    out.set(deviceId, { deviceId, peerId: boundPeerId, candidates: entry.candidates, ts: entry.ts })
  }
  return out
}
