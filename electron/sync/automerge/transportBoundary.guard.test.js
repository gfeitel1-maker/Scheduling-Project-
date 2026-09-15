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

  it('the default listen address stays loopback (unless signed off)', () => {
    if (INTERNET_TRANSPORT_SIGNOFF) return
    // The shipped default binds loopback only; real-LAN listening is passed in explicitly by a
    // caller, not baked into the default. A non-loopback default is a boundary change.
    const m = transportSrc.match(/const DEFAULT_LISTEN\s*=\s*(\[[^\]]*\])/)
    expect(m, 'Could not find DEFAULT_LISTEN in transport.js — the guard needs to see it').toBeTruthy()
    expect(m[1], `DEFAULT_LISTEN changed away from loopback: ${m?.[1]}. If intentional, complete the ` +
      `ADR re-assessment and set INTERNET_TRANSPORT_SIGNOFF=true.`
    ).toContain('127.0.0.1')
  })

  it('transport.js imports no internet-transport package directly (unless signed off)', () => {
    if (INTERNET_TRANSPORT_SIGNOFF) return
    const importedInternet = INTERNET_TRANSPORT_PACKAGES.filter((p) =>
      new RegExp(`from\\s+['"]${p.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]`).test(transportSrc)
    )
    expect(importedInternet, `transport.js imports an internet transport: ${importedInternet.join(', ')}`).toEqual([])
  })
})
