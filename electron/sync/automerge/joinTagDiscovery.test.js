import { describe, it, expect, vi } from 'vitest'
import { createJoinTagAdvertiser } from './joinTagDiscovery.js'

// A fake inner discovery whose start() can be made to fail once.
function fakeDiscovery({ failFirstStart }) {
  let starts = 0
  const started = []
  const discoveryFor = (tag) => () => {
    const service = new EventTarget()
    service.start = async () => {
      starts++
      if (failFirstStart && starts === 1) throw new Error('mdns bind failed')
      started.push(tag)
    }
    service.stop = async () => {}
    return service
  }
  return { discoveryFor, started }
}

describe('join tag advertiser — one failed start does not wedge it', () => {
  it('after a failed start, a later setCode still advertises', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { discoveryFor, started } = fakeDiscovery({ failFirstStart: true })
    const adv = createJoinTagAdvertiser({ discoveryFor })
    const svc = adv.factory({})
    await svc.start()
    await adv.setCode('ABCDE-FGHJK').catch(() => {}) // first start fails
    expect(adv.advertisedTag()).toBeNull() // a failed start is not reported as advertising
    await adv.setCode('LMNPQ-RSTVW')
    expect(started.length).toBe(1) // the second code really started
    expect(adv.advertisedTag()).not.toBeNull()
    err.mockRestore()
  })
})
