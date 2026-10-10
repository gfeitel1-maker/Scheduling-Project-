// @vitest-environment node
// T359 slice 3: the starter exposes the port-mapping status slice 4 reads, inert unless the punch flag is on,
// and the router-reported address never reaches an IPC-facing file.
import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createAutomergeSyncStarter } from './syncStarter.js'

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
const saved = process.env.SHORESH_PUNCH_ENABLED
afterEach(() => { if (saved === undefined) delete process.env.SHORESH_PUNCH_ENABLED; else process.env.SHORESH_PUNCH_ENABLED = saved })

const starter = () => createAutomergeSyncStarter({ deviceId: 'd', db: {}, userDataPath: '/nonexistent', getLiveHandlers: () => null })

describe('getPortMappingStatus', () => {
  it('is null with the flag off', () => {
    delete process.env.SHORESH_PUNCH_ENABLED
    expect(starter().getPortMappingStatus()).toBeNull()
    process.env.SHORESH_PUNCH_ENABLED = '1'
    expect(starter().getPortMappingStatus()).toBeNull()
  })

  it('is null with the flag on until the mapper has a result', () => {
    process.env.SHORESH_PUNCH_ENABLED = 'true'
    expect(starter().getPortMappingStatus()).toBeNull()
  })
})

describe('wiring', () => {
  it('starts the lifecycle, feeds gossip from it, and unmaps on shutdown', () => {
    const src = read('./syncStarter.js')
    expect(src).toMatch(/portMapping\.start\(\)/)
    expect(src).toMatch(/getMappedAddress: \(\) => portMapping\?\.getMappedAddress\(\)/)
    expect(src).toMatch(/shutdownPunch: async \(\) => \{[\s\S]*?portMapping[\s\S]*?\.stop\(\)/)
  })

  it('the IPC and handler files never carry externalIp', () => {
    for (const f of ['./syncStarter.js', './syncStarterHolder.js', '../../main.js', '../../preload.js']) {
      expect(read(f), f).not.toMatch(/externalIp/)
    }
  })
})
