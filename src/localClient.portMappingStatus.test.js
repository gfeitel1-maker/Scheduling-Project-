// T359 slice 4 - the renderer-side getter must exist on the mock (the :5200 preview) and report null by default.
import { describe, it, expect } from 'vitest'
import { localClient } from './localClient'

describe('getPortMappingStatus on the browser mock', () => {
  it('is exposed and resolves null when nothing is staged', async () => {
    expect(typeof localClient.getPortMappingStatus).toBe('function')
    expect(await localClient.getPortMappingStatus()).toBeNull()
  })
})
