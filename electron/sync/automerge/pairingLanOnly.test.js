// @vitest-environment node
//
// T340 (owner ruling 2026-10-08: pairing can only ever happen first over a local network).
// pairing_request is refused unless the connection's remote address POSITIVELY classifies as LAN
// (fail-closed: null / public / dns-only / p2p-circuit are NOT LAN), with the named signal
// 'pairing-requires-local-network'.
import { describe, it, expect } from 'vitest'
import { encode } from 'it-length-prefixed'
import { registerAuthGate, isLanMultiaddr, PAIRING_REQUIRES_LOCAL_NETWORK } from './authGate.js'
const encodeMessage = (o) => new TextEncoder().encode(JSON.stringify(o))
const decodeMessage = (b) => JSON.parse(new TextDecoder().decode(b))

describe('isLanMultiaddr (fail-closed classifier)', () => {
  const lan = [
    '/ip4/127.0.0.1/tcp/1', '/ip4/10.1.2.3/tcp/1', '/ip4/172.16.0.1/tcp/1', '/ip4/172.31.255.255/tcp/1',
    '/ip4/192.168.1.5/tcp/1', '/ip4/169.254.3.4/tcp/1', '/ip6/::1/tcp/1', '/ip6/fd12:3456::1/tcp/1',
    '/ip6/fc00::1/tcp/1', '/ip6/fe80::1%en0/tcp/1', '/ip6/febf::1/tcp/1',
  ]
  const notLan = [
    null, undefined, '', 42, {}, 'garbage', '/ip4/8.8.8.8/tcp/1', '/ip4/172.32.0.1/tcp/1', '/ip4/172.15.0.1/tcp/1',
    '/ip4/192.169.1.1/tcp/1', '/ip4/10.1.2/tcp/1', '/ip4/10.1.2.999/tcp/1', '/ip4/10.evil.1.1/tcp/1',
    '/ip6/2001:db8::1/tcp/1', '/ip6/fec0::1/tcp/1', '/ip6/::/tcp/1', '/ip6/::ffff:10.0.0.1/tcp/1',
    '/dns4/camp.local/tcp/1', '/dns/example.com/tcp/443', '/dns4/10.0.0.1/tcp/1',
    '/ip4/10.0.0.1/tcp/1/p2p/12D3KooWRelay/p2p-circuit', '/ip4/8.8.8.8/tcp/1/p2p/R/p2p-circuit/p2p/J',
  ]
  it.each(lan)('LAN: %s', (a) => expect(isLanMultiaddr(a)).toBe(true))
  it.each(notLan)('NOT LAN: %s', (a) => expect(isLanMultiaddr(a)).toBe(false))
})

function fakeGateWith(addr) {
  const node = new EventTarget()
  let handler
  node.handle = (_proto, h) => { handler = h }
  const onPairingRequestCalls = []
  registerAuthGate(node, { onPairingRequest: (m) => { onPairingRequestCalls.push(m); return { ok: true } } })
  const sent = []
  const stream = {
    async *[Symbol.asyncIterator]() { yield encode.single(encodeMessage({ type: 'pairing_request', device_id: 'd', device_name: 'D' })) },
    send: (frame) => { sent.push(frame.subarray ? frame.subarray() : frame); return true },
    close: async () => {},
    abort: () => {},
  }
  const connection = { remoteAddr: { toString: () => addr, getComponents: () => { throw new Error('n/a') } }, remotePeer: { toString: () => 'peerX' } }
  handler(stream, connection)
  return { sent, onPairingRequestCalls }
}

async function refusalFor(addr) {
  const g = fakeGateWith(addr)
  await new Promise((r) => setTimeout(r, 50))
  return g
}

describe('pairing_request is LAN-only', () => {
  it.each([
    ['public IP', '/ip4/8.8.8.8/tcp/4001'],
    ['p2p-circuit', '/ip4/10.0.0.9/tcp/4001/p2p/12D3KooWRelay/p2p-circuit'],
    ['dns-only (no IP)', '/dns4/relay.example.com/tcp/443'],
  ])('refused on %s with the named signal and never reaches onPairingRequest', async (_n, addr) => {
    const { sent, onPairingRequestCalls } = await refusalFor(addr)
    expect(onPairingRequestCalls).toHaveLength(0)
    expect(sent).toHaveLength(1)
    const body = decodeMessage(sent[0].subarray(1))
    expect(body).toEqual({ type: 'pairing_denied', reason: PAIRING_REQUIRES_LOCAL_NETWORK })
    expect(PAIRING_REQUIRES_LOCAL_NETWORK).toBe('pairing-requires-local-network')
  })

  it('a LAN address reaches onPairingRequest', async () => {
    const { onPairingRequestCalls } = await refusalFor('/ip4/192.168.1.20/tcp/4001')
    expect(onPairingRequestCalls).toHaveLength(1)
  })
})
