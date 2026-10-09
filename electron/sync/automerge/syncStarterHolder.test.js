import { describe, it, expect } from 'vitest'
import { createSyncStarterHolder } from './syncStarterHolder.js'

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function fakeFactory(startGate) {
  const made = []
  const make = () => {
    const s = { id: made.length, node: null, stops: 0, boundTo: made.length }
    s.start = async () => {
      if (startGate) await startGate.promise
      s.node = { stop: async () => { s.stops++ } }
    }
    s.getNode = () => s.node
    s.shutdownPunch = async () => {}
    s.releaseBroadcaster = () => {}
    s.getStartupAttempted = () => true
    s.getRelayReservationRefused = () => false
    made.push(s)
    return s
  }
  return { make, made }
}

describe('syncStarterHolder switch serialization', () => {
  it('two overlapping swaps: exactly one proceeds, one live node, old node stopped once', async () => {
    const f = fakeFactory()
    const holder = createSyncStarterHolder(f.make)
    await holder.start()
    const first = f.made[0]
    const gate = deferred()
    let builds = 0
    const opts = () => ({ commit() {}, revert() {}, build: async () => { builds++; await gate.promise; return 'h' } })
    const a = holder.swap(opts())
    const b = holder.swap(opts())
    await expect(b).rejects.toMatchObject({ code: 'project_switch_in_progress' })
    gate.resolve()
    await expect(a).resolves.toBe('h')
    expect(builds).toBe(1)
    await holder.start().catch(() => {})
    const live = f.made.filter((s) => s.node && s.stops === 0)
    expect(live).toHaveLength(1)
    expect(first.stops).toBe(1)
  })

  it('a start via handlerOptions().onCampBootstrapped pending at replace() is awaited; no node bound to the old starter survives', async () => {
    const gate = deferred()
    const f = fakeFactory(gate)
    const holder = createSyncStarterHolder(f.make)
    const pending = holder.handlerOptions().onCampBootstrapped()
    let replaced = false
    const r = holder.replace().then(() => { replaced = true })
    await new Promise((res) => setTimeout(res, 10))
    expect(replaced).toBe(false)
    gate.resolve()
    await pending
    await r
    await new Promise((res) => setTimeout(res, 10))
    const live = f.made.filter((s) => s.node && s.stops === 0)
    expect(live).toHaveLength(1)
    expect(live[0]).toBe(f.made[1])
    expect(f.made[0].stops).toBe(1)
  })

  it('swap rethrows the original build error even when the rollback replace() throws', async () => {
    const f = fakeFactory()
    const holder = createSyncStarterHolder(() => {
      if (f.made.length >= 2) throw new Error('rollback boom')
      return f.make()
    })
    await holder.start()
    await expect(holder.swap({
      commit() {}, revert() {},
      build: () => { throw new Error('build boom') },
    })).rejects.toThrow('build boom')
  })
})
