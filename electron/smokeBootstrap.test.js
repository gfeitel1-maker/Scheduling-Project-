// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { smokeBootstrapRequested, runSmokeBootstrap } from './smokeBootstrap.js'

describe('smokeBootstrapRequested', () => {
  it('needs both the smoke nonce and the bootstrap flag', () => {
    expect(smokeBootstrapRequested({ SHORESH_SMOKE_NONCE: 'n', SHORESH_SMOKE_BOOTSTRAP: '1' })).toBe(true)
    expect(smokeBootstrapRequested({ SHORESH_SMOKE_BOOTSTRAP: '1' })).toBe(false)
    expect(smokeBootstrapRequested({ SHORESH_SMOKE_NONCE: 'n' })).toBe(false)
  })
})

describe('runSmokeBootstrap', () => {
  const make = (node) => {
    const calls = []
    return {
      calls,
      handlers: { chooseMode: vi.fn((a) => calls.push(['chooseMode', a.mode])), bootstrapCamp: vi.fn(async () => { calls.push(['bootstrapCamp']) }) },
      holder: { start: vi.fn(async () => { calls.push(['start']) }), getNode: () => node },
      writeSyncMarker: vi.fn(() => calls.push(['marker'])),
    }
  }
  it('chooses host, bootstraps, starts sync, then writes the marker', async () => {
    const m = make({})
    await runSmokeBootstrap({ handlers: m.handlers, syncStarterHolder: m.holder, writeSyncMarker: m.writeSyncMarker })
    expect(m.calls.map((c) => c[0])).toEqual(['chooseMode', 'bootstrapCamp', 'start', 'marker'])
  })
  it('writes no marker when the node did not start', async () => {
    const m = make(null)
    await expect(runSmokeBootstrap({ handlers: m.handlers, syncStarterHolder: m.holder, writeSyncMarker: m.writeSyncMarker })).rejects.toThrow(/did not start/)
    expect(m.writeSyncMarker).not.toHaveBeenCalled()
  })
})
