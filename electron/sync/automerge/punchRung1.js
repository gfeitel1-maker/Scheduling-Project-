// T348 (docs/adr/2026-10-08-relayless-cross-network-reconnect.md, Rung 1): redial a peer's remembered
// public reflexive candidate(s) with ZERO signaling messages - pinned DTLS cert, ICE ufrag/pwd and port,
// preserved roles, disableAutoNegotiation (all inherited from punchTransport.connectFromMemory). It is
// best-effort by the ADR's own finding: a NAT may have remapped the port since the memory was written.
// The result tells the S4 coordinator whether to escalate to rung 2; this module never contacts
// rung 3 or any signaling channel, and never throws.
//
// Imports nothing from punchTransport.js (the T347 guard keeps syncStarter.js its sole importer), so the
// transport's ICE-failure error is recognised by name.
//
// INERT: nothing imports this unless something outside tests wires it; punchTransport itself is only
// built behind syncStarter.js's strict SHORESH_PUNCH_ENABLED === 'true' gate.
import { multiaddr } from '@multiformats/multiaddr'
import { isIPv4, isIPv6 } from 'node:net'
import { TimeoutError } from '@libp2p/interface'
import { loadMappedPeerAddress, loadTrustedPunchMemory } from './peerAddressBook.js'
import { createBoundPeerTrust } from './peerIdentity.js'

export const RUNG1_DEFAULT_TIMEOUT_MS = 8_000
// NAT mappings do not survive long idle; past this a redial only probes whoever now owns the address.
export const RUNG1_MEMORY_MAX_AGE_MS = 12 * 60 * 60 * 1000

const V4_NON_PUBLIC = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]
const v4Int = (a) => a.split('.').reduce((n, o) => n * 256 + Number(o), 0)
function isPublicAddress(addr) {
  if (isIPv4(addr)) {
    const n = v4Int(addr)
    return !V4_NON_PUBLIC.some(([net, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Int(net) / 2 ** (32 - bits)))
  }
  if (isIPv6(addr)) return (parseInt(addr.split(':')[0] || '0', 16) & 0xe000) === 0x2000
  return false
}

// The production candidate filter: a server-reflexive candidate on a public address. Tests that run over
// loopback inject their own filter; there is no flag that relaxes this one.
export function isPublicSrflxCandidate(c) {
  const parts = typeof c?.candidate === 'string' ? c.candidate.split(' ') : []
  return parts[6] === 'typ' && parts[7] === 'srflx' && isPublicAddress(parts[4])
}

// T359 slice 2: before the UDP punch, dial the peer's remembered router-mapped TCP address (7 day age
// limit, trust re-checked before the dial and after the upgrade). Any failure falls through to the punch.
async function attemptMappedDial(peer, { db, dial, timeoutMs, signal, checkTrust, isPeerRevoked, mappedAddressFilter }) {
  const address = loadMappedPeerAddress(db, peer.peerId, { isPeerTrusted: checkTrust, isAddressAllowed: mappedAddressFilter })
  if (!address) return null
  let connection
  try {
    const timeout = AbortSignal.timeout(timeoutMs)
    connection = await dial(multiaddr(address), { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  } catch {
    return null
  }
  if (connection?.remotePeer?.toString() !== peer.peerId) {
    try { await connection?.close?.() } catch { /* already closing */ }
    return null
  }
  if (!checkTrust(peer.peerId) || isPeerRevoked?.(peer.peerId)) {
    try { await connection.close() } catch { /* already closing */ }
    return { ok: false, reason: 'revoked' }
  }
  return { ok: true, connection }
}

// peer: { peerId }. deps: { db, dial? (libp2p dial; enables the mapped-address-first step), transport, upgrader, timeoutMs?, signal?, isPeerTrusted?, maxAgeMs?,
// candidateFilter? (UDP candidates) and mappedAddressFilter? (TCP address); injected by loopback tests only, both default to the public filters }.
// -> { ok: true, connection } | { ok: false, reason: 'no-memory' | 'mapping-moved' | 'timeout' | 'revoked' | 'error' }
// A revoked, unknown, stale or unusable memory reports 'no-memory' and is never probed. Trust is
// checked again after the upgrade: a peer revoked mid-dial gets its connection closed and 'revoked'.
export async function attemptRung1(peer, { db, transport, upgrader, timeoutMs = RUNG1_DEFAULT_TIMEOUT_MS, signal, isPeerTrusted, isPeerRevoked, maxAgeMs = RUNG1_MEMORY_MAX_AGE_MS, candidateFilter = isPublicSrflxCandidate, dial, mappedAddressFilter }) {
  try {
    const checkTrust = isPeerTrusted ?? createBoundPeerTrust(db)
    if (dial) {
      const mapped = await attemptMappedDial(peer, { db, dial, timeoutMs, signal, checkTrust, isPeerRevoked, mappedAddressFilter })
      if (mapped) return mapped
    }
    let memory = loadTrustedPunchMemory(db, peer?.peerId, { isPeerTrusted: checkTrust })
    if (!memory) return { ok: false, reason: 'no-memory' }
    if (!(Date.now() - Date.parse(memory.lastSeenAt) <= maxAgeMs)) return { ok: false, reason: 'no-memory' }
    const candidates = memory.candidates.filter(candidateFilter)
    if (candidates.length === 0) return { ok: false, reason: 'no-memory' }
    memory = { ...memory, candidates, remoteSdp: memory.remoteSdp.replace(/^a=candidate:.*\r?\n?/gm, '') }
    const connection = await transport.connectFromMemory(memory, { upgrader, signal, timeoutMs })
    if (connection?.remotePeer?.toString() !== peer.peerId) {
      try { await connection?.close?.() } catch { /* already closing */ }
      return { ok: false, reason: 'mapping-moved' }
    }
    if (!checkTrust(peer.peerId) || isPeerRevoked?.(peer.peerId)) {
      try { await connection.close() } catch { /* already closing */ }
      return { ok: false, reason: 'revoked' }
    }
    return { ok: true, connection }
  } catch (err) {
    if (err?.name === 'PunchConnectionFailedError') return { ok: false, reason: 'mapping-moved' }
    if (err instanceof TimeoutError) return { ok: false, reason: 'timeout' }
    return { ok: false, reason: 'error' }
  }
}
