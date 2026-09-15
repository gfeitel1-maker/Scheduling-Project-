// TIER-4 ENFORCEABLE BOUNDARY GUARD (docs/adr/2026-09-14-internet-transport-security-gate.md).
//
// Shoresh's entire threat model rests on one assumption: the sync transport is reachable only
// on the local network (loopback + mDNS-discovered LAN peers), never over the internet. The
// moment an internet-reachable transport or discovery mechanism is added — a circuit relay, a
// DHT, WebRTC/WebSocket/WebTransport, a bootstrap list, AutoNAT/UPnP hole-punching, or a
// non-loopback default listen address — the "trusted private LAN" boundary is gone and a FULL
// security re-assessment is mandatory (TLS/wss, authenticated relays, the plaintext-PIN-on-wire
// tradeoff, internet-scale rate limiting, Electron auto-update integrity).
//
// This test makes that non-negotiable and mechanical instead of a doc nobody re-reads: it FAILS
// the build if any internet-transport capability appears, UNTIL a human flips INTERNET_TRANSPORT_SIGNOFF
// to true — which you may only do after the ADR's re-assessment is recorded. Flipping it forces
// you to open this file and read the ADR pointer, which is exactly the checkpoint we want.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..', '..')

// ── The sign-off switch ─────────────────────────────────────────────────────
// FALSE = LAN-only boundary is in force (the shipped state). Set TRUE only after the
// re-assessment in docs/adr/2026-09-14-internet-transport-security-gate.md is done and recorded.
const INTERNET_TRANSPORT_SIGNOFF = false

// libp2p packages (and multiaddr protocols) that imply internet reachability. Absence of these
// is what keeps the boundary. This list is the definition of "internet-reachable" for the guard.
const INTERNET_TRANSPORT_PACKAGES = [
  '@libp2p/circuit-relay-v2',
  '@libp2p/webrtc',
  '@libp2p/websockets',
  '@libp2p/webtransport',
  '@libp2p/kad-dht',
  '@libp2p/bootstrap',
  '@libp2p/autonat',
  '@libp2p/dcutr',
  '@libp2p/upnp-nat',
]

describe('Tier-4 internet-transport boundary guard', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const transportSrc = readFileSync(join(__dirname, 'transport.js'), 'utf8')

  it('declares no internet-reachable libp2p transport/discovery dependency (unless signed off)', () => {
    const present = INTERNET_TRANSPORT_PACKAGES.filter((p) => p in deps)
    if (INTERNET_TRANSPORT_SIGNOFF) return // re-assessment recorded; boundary deliberately opened
    expect(present, `Internet-transport dependency added without sign-off: ${present.join(', ')}. ` +
      `The trusted-LAN threat model no longer holds. Complete the re-assessment in ` +
      `docs/adr/2026-09-14-internet-transport-security-gate.md, then set INTERNET_TRANSPORT_SIGNOFF=true here.`
    ).toEqual([])
  })

  it('the REAL production node uses mDNS-only discovery, no internet rendezvous (unless signed off)', () => {
    if (INTERNET_TRANSPORT_SIGNOFF) return
    // CORRECTION (2026-09-15 WAN assessment, finding 1): the earlier version of this test asserted
    // transport.js's DEFAULT_LISTEN stays loopback — but that constant is DEAD in production. The
    // real node (electron/main.js) binds `/ip4/0.0.0.0/tcp/0` (all interfaces — necessary for LAN
    // sync; loopback would let nothing connect). So "loopback" was never the boundary. The boundary
    // that actually keeps this off the internet is DISCOVERY: the production node is wired with
    // `createMdnsDiscovery` (link-local multicast) and NOTHING that performs internet rendezvous
    // (DHT/bootstrap/relay). This test asserts that real wiring, so the guard can no longer be
    // satisfied while the actual bind/discovery has already widened.
    const mainSrc = readFileSync(join(repoRoot, 'electron', 'main.js'), 'utf8')
    expect(/peerDiscovery:\s*\[\s*createMdnsDiscovery\(/.test(mainSrc),
      'electron/main.js no longer wires mDNS-only discovery (createMdnsDiscovery) into startSyncNode — ' +
      'if internet discovery (DHT/bootstrap/relay rendezvous) was added, the trusted-LAN boundary is gone; ' +
      'complete docs/adr/2026-09-14-internet-transport-security-gate.md and set INTERNET_TRANSPORT_SIGNOFF=true.'
    ).toBe(true)
    for (const marker of ['kadDHT', 'circuitRelay', 'bootstrap(', 'dcutr', 'autonat', 'webRTC']) {
      expect(mainSrc.includes(marker),
        `electron/main.js references '${marker}' — an internet rendezvous/transport was wired into the ` +
        `production node. That is the boundary change this gate exists to catch.`
      ).toBe(false)
    }
  })

  it('transport.js imports no internet-transport package directly (unless signed off)', () => {
    if (INTERNET_TRANSPORT_SIGNOFF) return
    const importedInternet = INTERNET_TRANSPORT_PACKAGES.filter((p) =>
      new RegExp(`from\\s+['"]${p.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]`).test(transportSrc)
    )
    expect(importedInternet, `transport.js imports an internet transport: ${importedInternet.join(', ')}`).toEqual([])
  })
})
