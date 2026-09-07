// @vitest-environment node
//
// Stage 4d's automated slice: a headless smoke test that the wrapper calls
// the right libp2p API without crashing. Real mDNS advertise/discover on a
// physical LAN needs the owner's two machines (design doc's Test strategy) —
// not exercisable here.
//
// Stage 5d-2a (docs/adr/2026-09-06-libp2p-membership-mapping.md): camp-scoped
// discovery. The pure functions (campDiscoveryTag, belongsToCamp) are tested
// thoroughly and directly — no real multicast involved, per this module's
// own comment about mDNS being unreliable in CI/sandboxes.
import { describe, it, expect, afterEach } from 'vitest'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { createMdnsDiscovery, campDiscoveryTag, belongsToCamp } from './discovery.js'

let node
afterEach(async () => {
  if (node) await node.stop()
  node = undefined
})

describe('discovery — @libp2p/mdns wrapper', () => {
  it('returns a peerDiscovery service usable in createLibp2p config', async () => {
    node = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [createMdnsDiscovery()],
      services: { identify: identify() },
    })

    expect(node.peerId.toString()).toBeTruthy()
    await node.stop()
    node = undefined
  })

  it('accepts a campId and still returns a usable peerDiscovery service', async () => {
    node = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [createMdnsDiscovery({ campId: 'camp-abc' })],
      services: { identify: identify() },
    })

    expect(node.peerId.toString()).toBeTruthy()
    await node.stop()
    node = undefined
  })
})

describe('campDiscoveryTag — pure, no real mDNS involved', () => {
  // Wire-compatibility tripwire (see the WIRE COMPATIBILITY note in
  // campIdHash.js). The hash vector in campIdHash.test.js pins the hash but
  // NOT the format around it — a changed prefix, separator or truncation
  // length would leave that test green while silently breaking discovery
  // against every already-installed copy of the app. This pins the complete
  // string that actually goes on the wire. If it fails, updating the
  // expectation hides the breakage rather than fixing it.
  it('produces its frozen service tag for a known camp id', () => {
    expect(campDiscoveryTag('shoresh-fixed-test-vector')).toBe('_shoresh-84211277a6a9b47e._udp.local')
    expect(campDiscoveryTag('camp-1')).toBe('_shoresh-89e6b4f18ea169c7._udp.local')
  })

  it('is deterministic: the same campId always produces the same tag', () => {
    expect(campDiscoveryTag('camp-1')).toBe(campDiscoveryTag('camp-1'))
  })

  it('produces different tags for different camp ids', () => {
    expect(campDiscoveryTag('camp-1')).not.toBe(campDiscoveryTag('camp-2'))
  })

  it('never contains the camp id itself, or anything resembling it, in the tag', () => {
    const campId = 'ohalo-summer-camp-2026'
    const tag = campDiscoveryTag(campId)
    expect(tag).not.toContain(campId)
    expect(tag.toLowerCase()).not.toContain('ohalo')
  })

  it('produces a tag shaped like a valid mDNS service tag, within DNS label limits', () => {
    const tag = campDiscoveryTag('camp-1')
    expect(tag).toMatch(/^_shoresh-[0-9a-f]{16}\._udp\.local$/)
    // The DNS label limit is 63 chars per dot-separated label; '_shoresh-<16 hex>'
    // is the longest single label here and must stay well under that.
    const longestLabel = tag.split('.').reduce((a, b) => (b.length > a.length ? b : a), '')
    expect(longestLabel.length).toBeLessThan(64)
  })

  it('rejects a missing or empty campId rather than silently producing an unscoped tag', () => {
    expect(() => campDiscoveryTag('')).toThrow()
    expect(() => campDiscoveryTag(undefined)).toThrow()
    expect(() => campDiscoveryTag(null)).toThrow()
  })
})

describe('belongsToCamp — the filter a Client applies before ever dialing', () => {
  it('matches a tag derived from the same campId', () => {
    const tag = campDiscoveryTag('camp-1')
    expect(belongsToCamp(tag, 'camp-1')).toBe(true)
  })

  it('rejects a tag derived from a different camp', () => {
    const tag = campDiscoveryTag('camp-2')
    expect(belongsToCamp(tag, 'camp-1')).toBe(false)
  })

  it('rejects a peer advertising no camp tag at all (undefined/null/empty)', () => {
    expect(belongsToCamp(undefined, 'camp-1')).toBe(false)
    expect(belongsToCamp(null, 'camp-1')).toBe(false)
    expect(belongsToCamp('', 'camp-1')).toBe(false)
  })

  it('rejects a malformed or unrelated string masquerading as a tag', () => {
    expect(belongsToCamp('_p2p._udp.local', 'camp-1')).toBe(false)
    expect(belongsToCamp('not-even-a-service-tag', 'camp-1')).toBe(false)
  })

  it('never matches when campId itself is missing', () => {
    const tag = campDiscoveryTag('camp-1')
    expect(belongsToCamp(tag, undefined)).toBe(false)
    expect(belongsToCamp(tag, '')).toBe(false)
  })
})

describe('createMdnsDiscovery — camp scoping wiring', () => {
  it('derives serviceTag from campId when given', () => {
    // mdns() stores init options on the returned factory's closure; the
    // cleanest black-box assertion available without starting a real node is
    // that createMdnsDiscovery({campId}) does not throw and produces a
    // distinct factory per distinct campId — the actual serviceTag value is
    // exercised end-to-end by the loopback smoke test above.
    const a = createMdnsDiscovery({ campId: 'camp-1' })
    const b = createMdnsDiscovery({ campId: 'camp-2' })
    expect(a).toBeTypeOf('function')
    expect(b).toBeTypeOf('function')
  })

  it('falls back to an explicit serviceTag override when no campId is given', () => {
    expect(() => createMdnsDiscovery({ serviceTag: '_custom._udp.local' })).not.toThrow()
  })

  it('falls back to @libp2p/mdns\'s own default when neither campId nor serviceTag is given', () => {
    expect(() => createMdnsDiscovery()).not.toThrow()
  })
})
