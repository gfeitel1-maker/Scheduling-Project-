// @vitest-environment node
// T340: startTransport applies the profile to libp2p's global pending cap and the limiter's public sub-cap.
import { describe, it, expect, vi } from 'vitest'

const seen = {}
vi.mock('libp2p', () => ({ createLibp2p: async (cfg) => { seen.libp2p = cfg; throw new Error('stop-after-config') } }))
vi.mock('./connectionRateLimiter.js', async (orig) => {
  const real = await orig()
  return { ...real, makeConnectionRateLimiter: (o) => { seen.limiter = o; return real.makeConnectionRateLimiter(o) } }
})

const { startTransport } = await import('./transport.js')

describe('startTransport pending sizing', () => {
  it('hands maxIncomingPendingConnections to libp2p and maxPublicPendingTotal to the limiter', async () => {
    await expect(startTransport({ maxIncomingPendingConnections: 128, maxPublicPendingTotal: 32 })).rejects.toThrow('stop-after-config')
    expect(seen.libp2p.connectionManager.maxIncomingPendingConnections).toBe(128)
    expect(seen.limiter.maxPublicPendingTotal).toBe(32)
  })
})
