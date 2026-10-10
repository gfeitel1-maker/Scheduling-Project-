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
import { loadPairs, savePairs, warnLoadFailure } from './punchFileStore.js'
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
const CANDIDATE_RE = /^\/(ip4|ip6)\/([^/]+)\/(?:udp|tcp)\/(\d{1,5})$/
const NONCE_BYTES = 12
const TAG_BYTES = 16

function campKeyFor(addressKeyHex) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(addressKeyHex, 'hex'), Buffer.alloc(0), Buffer.from(GOSSIP_KEY_INFO, 'utf8'), 32))
}

function canonicalMessage({ deviceId, peerId, ts, candidates }) {
  return `${GOSSIP_SIG_CONTEXT}\n${JSON.stringify([deviceId, peerId, ts, candidates])}`
}

// Public unicast only: a gossip candidate is dialled by every camp peer, so a private, loopback,
// link-local, CGNAT, multicast, unspecified, documentation/benchmark, IPv4-mapped or IPv4-embedding
// (NAT64, 6to4) address would aim the dial at the reader's own network (a hostile-but-valid peer's
// SSRF-style probe).
function v4Public(a, b, c) {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  return true
}

// Eight 16-bit groups of an IPv6 literal (net.isIPv6 already vetted it), or null.
function parseIPv6Groups(ip) {
  let s = ip
  if (s.includes('%')) return null
  let tail = null
  if (s.includes('.')) {
    const i = s.lastIndexOf(':')
    const v4 = s.slice(i + 1)
    if (!net.isIPv4(v4)) return null
    const o = v4.split('.').map(Number)
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]]
    s = `${s.slice(0, i + 1)}0:0`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (h) => (h === '' ? [] : h.split(':').map((g) => parseInt(g, 16)))
  const head = parse(halves[0])
  let groups = head
  if (halves.length === 2) {
    const rest = parse(halves[1])
    const fill = 8 - head.length - rest.length
    if (fill < 1) return null
    groups = [...head, ...new Array(fill).fill(0), ...rest]
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null
  if (tail) groups.splice(6, 2, ...tail)
  return groups
}

export function isPublicAddress(version, ip) {
  if (version === 'ip4') {
    if (net.isIPv4(ip) === false) return false
    const [a, b, c] = ip.split('.').map(Number)
    return v4Public(a, b, c)
  }
  if (!net.isIPv6(ip)) return false
  const g = parseIPv6Groups(ip)
  if (!g) return false
  const [g0, g1, g2, g3, g4, g5] = g
  // ::, ::1, IPv4-compatible and IPv4-mapped (::ffff:a.b.c.d)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return false
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return false
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return false
  // 6to4 2002::/16: rejected outright - the embedded IPv4 is sender-chosen and the prefix has no
  // legitimate use as a camp peer's reflexive address.
  if (g0 === 0x2002) return false
  // Teredo 2001::/32, documentation 2001:db8::/32, ORCHID 2001:10::/28 and ORCHIDv2 2001:20::/28
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8 || (g1 & 0xfff0) === 0x10 || (g1 & 0xfff0) === 0x20)) return false
  // documentation 3fff::/20 (RFC 9637)
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return false
  // discard-only 100::/64
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return false
  // site-local fec0::/10 (deprecated, still non-public)
  if ((g0 & 0xffc0) === 0xfec0) return false
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xfe00) === 0xfc00 || (g0 & 0xff00) === 0xff00) return false
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
    throw new Error(`punchGossip: candidates must be at most ${MAX_CANDIDATES} public udp or tcp multiaddrs of at most ${MAX_CANDIDATE_CHARS} chars (bad candidate list)`)
  }
  const { doc: keyed, addressKey } = mintRendezvousAddressKey(doc, campId)
  const value = sealGossipEntry(db, { addressKey, deviceId, peerId, candidates, ts: now(), signMessage })
  return A.change(keyed, (d) => {
    if (!d.camps) d.camps = {}
    d.camps[recordKey(campId, `${GOSSIP_FIELD_PREFIX}${deviceId}`)] = value
  })
}

const HIGH_WATER_MAX = 256

/**
 * The reader's persisted memory of the newest verified ts per device (rollback check). Bounded at
 * `max` devices (oldest-inserted evicted) and rewritten (fsynced) on every raise so a restart cannot
 * re-accept a rolled-back entry. filePath is REQUIRED. A missing file is a first run; an unreadable
 * or corrupt one is reported (warning + `.failed`) and readReflexive then refuses every entry rather
 * than starting empty. A failed write is warned, returned from set(), and kept in `.lastWriteError`;
 * the in-memory mark still holds.
 */
export function createHighWaterStore({ filePath, max = HIGH_WATER_MAX, onError = () => {} } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('punchGossip: createHighWaterStore requires a filePath')
  const m = new Map()
  const loaded = loadPairs(filePath)
  for (const [k, v] of loaded.pairs) m.set(k, v)
  if (loaded.error) {
    warnLoadFailure(filePath, loaded.error)
    onError(loaded.error)
  }
  const store = {
    persistent: true,
    failed: loaded.error,
    lastWriteError: null,
    get: (k) => m.get(k),
    set(k, v) {
      m.delete(k)
      m.set(k, v)
      while (m.size > max) m.delete(m.keys().next().value)
      const err = savePairs(filePath, [...m])
      store.lastWriteError = err
      if (err) onError(err)
      return err
    },
  }
  return store
}

export function isHighWaterStore(s) {
  return !!s && s.persistent === true && typeof s.get === 'function' && typeof s.set === 'function'
}

/**
 * Map<deviceId, {deviceId, peerId, candidates, ts}> of every entry that passed every check. The
 * returned map carries `.skewed`: Map<deviceId, skewMs> of correctly signed entries refused only
 * because they are dated beyond the future-skew bound - the sender's clock disagrees with ours, and
 * the caller must surface that rather than treat it as "no entry". `.refused` is the store's load
 * error when the store is corrupt: every entry is then refused (fail closed). `.storeErrors` lists
 * highWater write failures during this read.
 *
 * highWater (REQUIRED; a createHighWaterStore - a plain Map is refused) is the reader's memory of the newest verified
 * ts per device: an entry older than it is a rolled-back document value and is refused.
 * allowPrivateCandidates is for loopback test fixtures only.
 */
export function readReflexive(doc, { campId, registry, now = Date.now, highWater, allowPrivateCandidates = false }) {
  if (!isHighWaterStore(highWater)) {
    throw new Error('punchGossip: readReflexive requires a highWater store (rollback protection is not optional)')
  }
  const out = new Map()
  out.skewed = new Map()
  out.refused = highWater.failed ?? null
  out.storeErrors = []
  if (out.refused) return out
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
    const mark = highWater.get(deviceId) ?? -Infinity
    if (entry.ts < mark) continue
    if (entry.ts > mark) {
      const err = highWater.set(deviceId, entry.ts)
      if (err) out.storeErrors.push(err)
    }
    out.set(deviceId, { deviceId, peerId: boundPeerId, candidates: entry.candidates, ts: entry.ts })
  }
  return out
}
