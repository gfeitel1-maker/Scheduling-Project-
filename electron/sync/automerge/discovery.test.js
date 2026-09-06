// @vitest-environment node
//
// Stage 4d's automated slice: a headless smoke test that the wrapper calls
// the right libp2p API without crashing. Real mDNS advertise/discover on a
// physical LAN needs the owner's two machines (design doc's Test strategy) —
// not exercisable here.
import { describe, it, expect, afterEach } from 'vitest'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { createMdnsDiscovery } from './discovery.js'

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
})
