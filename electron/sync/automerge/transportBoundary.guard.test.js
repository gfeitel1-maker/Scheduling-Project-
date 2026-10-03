// TIER-4 ENFORCEABLE BOUNDARY GUARD (docs/adr/2026-09-14-internet-transport-security-gate.md,
// docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md "Addendum 2026-09-28 (Architect, T288)").
//
// Shoresh's entire threat model rests on one assumption: the sync transport is reachable only
// on the local network (loopback + mDNS-discovered LAN peers) plus whatever WAN capability has an
// explicit, dated sign-off in transportCapabilities.js. The moment an internet-reachable transport
// or discovery mechanism is added without a signoff entry — a circuit relay, a DHT, WebRTC/
// WebSocket/WebTransport, a bootstrap list, AutoNAT/UPnP hole-punching, or a non-loopback default
// listen address — a FULL security re-assessment is mandatory.
//
// T288 replaced the old single coarse `INTERNET_TRANSPORT_SIGNOFF` boolean with a per-capability
// registry (transportCapabilities.js): each capability is independently blocked/allowed, so
// authorizing `discovery` cannot, by construction, also widen what `relay`/`dcutr`/etc. are
// allowed to do. Every assertion below reads TRANSPORT_CAPABILITIES — none hard-codes a second
// copy of "is X allowed".
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { findInternetEgress, forbiddenPackagesPresent, unauthorizedEgress } from './internetRendezvousScan.js'
import {
  TRANSPORT_CAPABILITIES,
  ALL_FORBIDDEN_PACKAGES,
  ALL_FORBIDDEN_MARKERS,
  DISCOVERY_EGRESS_ALLOWLIST,
} from './transportCapabilities.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import path from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..', '..')

function walkSyncFiles() {
  const syncDir = join(repoRoot, 'electron', 'sync')
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(full)
    }
  }
  walk(syncDir)
  return files
}

describe('Tier-4 internet-transport boundary guard (per-capability, T288)', () => {
  const lockfile = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
  const transportSrc = readFileSync(join(__dirname, 'transport.js'), 'utf8')
  const starterSrc = readFileSync(join(__dirname, 'syncStarter.js'), 'utf8')

  // ── 1.1 Package presence — resolved tree, not direct deps ────────────────────────────────
  it('declares no un-signed-off internet-transport dependency, anywhere in the resolved tree', () => {
    const present = forbiddenPackagesPresent(lockfile.packages, ALL_FORBIDDEN_PACKAGES())
    expect(present, `Un-signed-off transport package present in the resolved dependency tree ` +
      `(direct or transitive): ${present.join(', ')}. Add a signoff entry in transportCapabilities.js ` +
      `only after the ADR re-assessment for that capability is recorded.`
    ).toEqual([])
  })

  // ── 1.2 syncStarter marker assertions — asymmetric per capability ────────────────────────
  it('syncStarter.js wires discovery when (and only when) discovery has a signoff', () => {
    const discoveryOn = Boolean(TRANSPORT_CAPABILITIES.discovery.signoff)
    const wiresMdns = /peerDiscovery\s*=\s*\[\s*createMdnsDiscovery\(/.test(starterSrc)
    expect(wiresMdns, 'mDNS discovery must remain wired, and first, regardless of the discovery capability state').toBe(true)
    if (discoveryOn) {
      expect(/createRendezvousDiscovery\(/.test(starterSrc),
        'discovery.signoff is set in transportCapabilities.js but syncStarter.js does not reference ' +
        'createRendezvousDiscovery( — a signed-off-but-never-wired flag reads as compliant when it is ' +
        'not; wire the capability or remove the signoff.'
      ).toBe(true)
    }
  })

  it('syncStarter.js references no marker of a still-blocked capability', () => {
    const forbiddenMarkers = ALL_FORBIDDEN_MARKERS()
    const present = forbiddenMarkers.filter((m) => starterSrc.includes(m))
    expect(present, `syncStarter.js references blocked-capability marker(s): ${present.join(', ')}.`).toEqual([])
  })

  // ── 1.3 Behavioral egress scan — allowlist by exact file identity ────────────────────────
  it('the sync path performs no internet egress outside the signed-off discovery allowlist', () => {
    const files = walkSyncFiles().filter((f) => !f.endsWith('internetRendezvousScan.js'))
    expect(files.length, 'no sync source files found — the walk is broken, not the tree clean').toBeGreaterThan(5)

    const entries = files.map((f) => ({
      relPath: f.slice(repoRoot.length + 1),
      basename: path.basename(f),
      source: readFileSync(f, 'utf8'),
    }))
    const discoveryOn = Boolean(TRANSPORT_CAPABILITIES.discovery.signoff)
    const offenders = unauthorizedEgress(entries, { discoveryOn, allowlist: DISCOVERY_EGRESS_ALLOWLIST })

    expect(offenders,
      `Unauthorized internet egress: ${offenders.join('; ')}. Only the files named in ` +
      `TRANSPORT_CAPABILITIES.discovery.egressAllowlist may perform their own egress, and only while ` +
      `discovery has a signoff entry.`
    ).toEqual([])
  })

  // ── 1.4 transport.js import scan — registry-driven ────────────────────────────────────────
  it('transport.js imports no internet-transport package directly (unless signed off)', () => {
    const importedInternet = ALL_FORBIDDEN_PACKAGES().filter((p) =>
      new RegExp(`from\\s+['"]${p.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]`).test(transportSrc)
    )
    expect(importedInternet, `transport.js imports an internet transport: ${importedInternet.join(', ')}`).toEqual([])
  })
})

// ── Non-vacuity — plants defects the registry-driven assertions above must still catch ───────
// (T288 addendum §6, seams 1-3: "plant the defect the guard cannot see", not just the defect the
// guard was designed around.)
describe('Tier-4 guard — non-vacuity (planted defects)', () => {
  it('seam 1: a still-blocked package goes red EVEN WITH discovery AND relay signed off', () => {
    // discovery.signoff AND relay.signoff are BOTH set in the real registry now (T337 landed the
    // relay coordination signoff) — this proves signing off those capabilities does not widen what
    // the per-capability check tolerates for an UNSIGNED one. We plant @libp2p/webrtc, whose
    // `webrtc` capability is still signoff:null, so it must still be flagged.
    expect(Boolean(TRANSPORT_CAPABILITIES.discovery.signoff)).toBe(true)
    expect(Boolean(TRANSPORT_CAPABILITIES.relay.signoff)).toBe(true)
    expect(TRANSPORT_CAPABILITIES.webrtc.signoff).toBe(null)
    const plantedLockfilePackages = {
      'node_modules/@libp2p/webrtc': {},
    }
    const present = forbiddenPackagesPresent(plantedLockfilePackages, ALL_FORBIDDEN_PACKAGES())
    expect(present).toEqual(['@libp2p/webrtc'])
  })

  it('seam 2: a transitive/nested package path is still caught (not direct-deps-only)', () => {
    const plantedLockfilePackages = {
      'node_modules/some-wrapper/node_modules/@libp2p/webrtc': {},
    }
    const present = forbiddenPackagesPresent(plantedLockfilePackages, ALL_FORBIDDEN_PACKAGES())
    expect(present).toEqual(['@libp2p/webrtc'])
  })

  it('seam 3: a file imported only by the discovery client is still flagged by its own basename', () => {
    // The importer-inheritance exploit: relayBridge.fixture.js is imported only by a stand-in for
    // rendezvousClient.js, but egress scope is file-identity-based, never import-graph-based.
    const entries = [
      { relPath: 'electron/sync/automerge/rendezvousClient.js', basename: 'rendezvousClient.js', source: `import './relayBridge.fixture.js'\nexport const x = 1` },
      { relPath: 'electron/sync/automerge/relayBridge.fixture.js', basename: 'relayBridge.fixture.js', source: `export async function bridge() { return fetch('https://evil.example/relay') }` },
    ]
    const offenders = unauthorizedEgress(entries, { discoveryOn: true, allowlist: DISCOVERY_EGRESS_ALLOWLIST })
    expect(offenders.some((o) => o.startsWith('electron/sync/automerge/relayBridge.fixture.js'))).toBe(true)
  })

  it('the discovery-allowlisted file itself is exempt only while discovery is on', () => {
    const entries = [
      { relPath: 'electron/sync/automerge/rendezvousClient.js', basename: 'rendezvousClient.js', source: `fetch('https://example.com')` },
    ]
    expect(unauthorizedEgress(entries, { discoveryOn: true, allowlist: DISCOVERY_EGRESS_ALLOWLIST })).toEqual([])
    expect(unauthorizedEgress(entries, { discoveryOn: false, allowlist: DISCOVERY_EGRESS_ALLOWLIST }).length).toBe(1)
  })

  // Round 2 FIX 3 — confirmed defect: `unauthorizedEgress` matched by basename only. A second
  // file named `rendezvousClient.js` at a DIFFERENT path would silently inherit the discovery
  // exemption, contradicting the module's own claim of "exact file identity". The allowlist and
  // the matcher must key on the FULL repo-relative path.
  it('seam: a same-basename file at a DIFFERENT path is still flagged, not exempted', () => {
    const entries = [
      {
        relPath: 'electron/sync/automerge/rendezvousClient.js',
        basename: 'rendezvousClient.js',
        source: `export const real = 1`,
      },
      {
        relPath: 'electron/sync/imposter/rendezvousClient.js',
        basename: 'rendezvousClient.js',
        source: `export async function bridge() { return fetch('https://evil.example/relay') }`,
      },
    ]
    const offenders = unauthorizedEgress(entries, { discoveryOn: true, allowlist: DISCOVERY_EGRESS_ALLOWLIST })
    expect(offenders.some((o) => o.startsWith('electron/sync/imposter/rendezvousClient.js'))).toBe(true)
  })

  it('dynamic import()/computed require() pattern does not false-positive on syncStarter.js\'s static import', () => {
    const starterSrc = readFileSync(join(__dirname, 'syncStarter.js'), 'utf8')
    expect(findInternetEgress(starterSrc)).toEqual([])
  })

  it('dynamic import() pattern DOES flag a computed specifier', () => {
    expect(findInternetEgress(`const mod = await import(somePath)`)).toContain('dynamic import()/computed require()')
  })
})

// ── Seam 8 — LAN-only parity when discovery is disabled ──────────────────────────────────────
describe('Tier-4 guard — LAN-only parity regression', () => {
  it('mDNS discovery stays wired in syncStarter.js regardless of the discovery capability state', () => {
    const starterSrc = readFileSync(join(__dirname, 'syncStarter.js'), 'utf8')
    expect(/peerDiscovery\s*=\s*\[\s*createMdnsDiscovery\(/.test(starterSrc),
      'electron/sync/automerge/syncStarter.js no longer wires mDNS-only discovery as the first ' +
      'peerDiscovery entry — the LAN-only path must stay byte-identical when SHORESH_RENDEZVOUS_URL ' +
      'is unset. See readRendezvousConfig() in rendezvousClient.js and mainSyncStartupWiring.test.js.'
    ).toBe(true)
  })
})
