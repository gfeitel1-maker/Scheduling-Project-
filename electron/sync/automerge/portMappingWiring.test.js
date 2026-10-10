// @vitest-environment node
//
// T359 slice 3: the router port mapping is wired into the sync starter's lifecycle, inside the strict
// SHORESH_PUNCH_ENABLED === 'true' gate, and its address reaches the signed gossip and nothing else.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAutomergeSyncStarter } from './syncStarter.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './liveDoc.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../../db/localDb.js'
import { makeSignalingPair } from './punchTestSupport.js'

const wired = vi.hoisted(() => ({ calls: [], publish: null, stoppedAt: null }))
vi.mock('./punchReconnectWiring.js', async (importActual) => ({
  ...(await importActual()),
  wirePunchReconnect: vi.fn(async (opts) => {
    wired.calls.push(opts)
    return { stop: async () => { wired.stoppedAt = Date.now() }, publishOwnReflexive: wired.publish }
  }),
}))

const PUBLIC_IP = '93.184.216.34'
let db, dbFile, deviceId, userDataPath, originalFlag

beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  dbFile = templated.file
  deviceId = getOrCreateDeviceId(db)
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-wiring-'))
  resetForTests()
  setUserDataDirGetter(() => userDataPath)
  setDocCipher(null)
  originalFlag = process.env.SHORESH_PUNCH_ENABLED
  process.env.SHORESH_PUNCH_ENABLED = 'true'
  wired.calls.length = 0
  wired.publish = vi.fn()
  wired.stoppedAt = null
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(randomUUID(), 'Camp Test', 'a'.repeat(64))
})
afterEach(() => {
  if (originalFlag === undefined) delete process.env.SHORESH_PUNCH_ENABLED
  else process.env.SHORESH_PUNCH_ENABLED = originalFlag
  resetForTests()
  db.close()
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile)
  fs.rmSync(userDataPath, { recursive: true, force: true })
  cleanupTemplatedDbs()
})

const noop = Object.assign(() => {}, { error() {}, trace() {}, newScope: () => noop })

function fakeRouter() {
  const table = new Map()
  const gateway = {
    externalIp: async () => PUBLIC_IP,
    addMapping: async ({ internalPort, externalPort }) => { table.set(externalPort, internalPort); return { externalPort } },
    deleteMapping: async ({ externalPort }) => { table.delete(externalPort) },
  }
  const deps = {
    lanInterfaces: () => [{ address: '192.168.1.20', netmask: '255.255.255.0' }],
    ssdpSearch: vi.fn(async function* () { yield { location: 'http://192.168.1.1:5000/d.xml' } }),
    openUpnp: async () => gateway,
    defaultGatewayIp: async () => '192.168.1.1',
    openPmp: () => null,
    schedule: () => ({}),
    cancel: () => {},
  }
  return { table, deps, gateway }
}

async function startStarter({ deps, withFactory = false } = {}) {
  let listen
  const startSyncNode = vi.fn(async (opts) => {
    listen = opts.listen
    if (withFactory) opts.punchTransportFactory({ logger: { forComponent: () => noop } })
    return { broadcastLocalDoc() {}, onPeersChanged() {}, setAuthToken() {}, stop: async () => {} }
  })
  const starter = createAutomergeSyncStarter({
    deviceId, db, userDataPath, docCipher: null,
    getMainWindow: () => null, getLiveHandlers: () => null,
    startSyncNodeImpl: async () => startSyncNode,
    ...(withFactory ? {} : { punchSignaling: makeSignalingPair()[0] }),
    portMappingDeps: deps,
  })
  await starter.start()
  return { starter, pinnedPort: Number(listen.find((a) => /\/tcp\/\d+$/.test(a)).split('/').pop()) }
}

describe('lifecycle', () => {
  it('maps the pinned TCP port once the listener is bound, and records the grant', async () => {
    const router = fakeRouter()
    const { starter, pinnedPort } = await startStarter({ deps: router.deps })
    await vi.waitFor(() => expect(starter.getPortMappingStatus()).not.toBe(null))
    expect([...router.table.keys()]).toEqual([pinnedPort])
    expect(JSON.parse(fs.readFileSync(path.join(userDataPath, 'port-mapping-grant.json'), 'utf8'))).toEqual({ externalPort: pinnedPort })
    await starter.shutdownPunch()
  })

  it('shutdownPunch (sync stop and app quit) removes the mapping and forgets the status', async () => {
    const router = fakeRouter()
    const { starter } = await startStarter({ deps: router.deps })
    await vi.waitFor(() => expect(router.table.size).toBe(1))
    await starter.shutdownPunch()
    expect(router.table.size).toBe(0)
    expect(starter.getPortMappingStatus()).toBe(null)
  })

  it('flag off: the router is never contacted', async () => {
    process.env.SHORESH_PUNCH_ENABLED = 'false'
    const router = fakeRouter()
    const { starter } = await startStarter({ deps: router.deps })
    await new Promise((r) => setTimeout(r, 50))
    expect(router.deps.ssdpSearch).not.toHaveBeenCalled()
    expect(router.table.size).toBe(0)
    expect(fs.existsSync(path.join(userDataPath, 'port-mapping-grant.json'))).toBe(false)
    expect(starter.getPortMappingStatus()).toBe(null)
  })
})

describe('test isolation', () => {
  it('flag on and no injected deps under Vitest: no mapper is started, so no real router can be touched', async () => {
    const { starter } = await startStarter({ deps: undefined })
    await new Promise((r) => setTimeout(r, 100))
    expect(starter.getPortMappingStatus()).toBe(null)
    expect(fs.existsSync(path.join(userDataPath, 'port-mapping-grant.json'))).toBe(false)
    await starter.shutdownPunch()
  })
})

describe('getPortMappingStatus contract', () => {
  it('is null before the mapper has a result', async () => {
    const router = fakeRouter()
    const { starter } = await startStarter({ deps: router.deps })
    expect(starter.getPortMappingStatus()).toBe(null)
    await vi.waitFor(() => expect(starter.getPortMappingStatus()).not.toBe(null))
    await starter.shutdownPunch()
  })

  // The flag is read once at start (T347's guard pins exactly one SHORESH_PUNCH_ENABLED read in
  // syncStarter.js), so "flag off" means a starter started with it off: no mapper, no router call, null.
  it('is null, and the router is never asked, when the starter starts with the flag off', async () => {
    const router = fakeRouter()
    process.env.SHORESH_PUNCH_ENABLED = 'false'
    try {
      const { starter } = await startStarter({ deps: router.deps })
      await new Promise((r) => setTimeout(r, 50))
      expect(starter.getPortMappingStatus()).toBe(null)
      expect(router.table.size).toBe(0)
      await starter.shutdownPunch()
    } finally {
      process.env.SHORESH_PUNCH_ENABLED = 'true'
    }
  })

  it('is exactly { status, lease } for a mapped result: no external IP, no port', async () => {
    const router = fakeRouter()
    const { starter, pinnedPort } = await startStarter({ deps: router.deps })
    await vi.waitFor(() => expect(starter.getPortMappingStatus()).not.toBe(null))
    const status = starter.getPortMappingStatus()
    expect(status).toEqual({ status: 'mapped', lease: 3600 })
    const text = JSON.stringify(status)
    expect(text).not.toContain(PUBLIC_IP)
    expect(text).not.toContain(String(pinnedPort))
    expect(text).not.toMatch(/externalIp|externalPort/)
    await starter.shutdownPunch()
  })
})

describe('gossip feed', () => {
  it('hands the mapped address to wirePunchReconnect, and republishes when it changes', async () => {
    const router = fakeRouter()
    const { starter, pinnedPort } = await startStarter({ deps: router.deps, withFactory: true })
    expect(wired.calls).toHaveLength(1)
    expect(typeof wired.calls[0].getMappedAddress).toBe('function')
    await vi.waitFor(() => expect(wired.calls[0].getMappedAddress()).toBe(`/ip4/${PUBLIC_IP}/tcp/${pinnedPort}`))
    expect(wired.publish).toHaveBeenCalled()
    await starter.shutdownPunch()
    expect(wired.calls[0].getMappedAddress()).toBe(null)
  })
})

describe('quit ordering', () => {
  // willQuit.js bounds the whole quit at 5s and the native punch teardown is what lets the process
  // exit, so an unresponsive router must never hold the punch teardown behind its 3s unmap bound.
  it('tears down the punch path at once even while the router unmap hangs', async () => {
    const router = fakeRouter()
    const { starter } = await startStarter({ deps: router.deps, withFactory: true })
    await vi.waitFor(() => expect(starter.getPortMappingStatus()).not.toBe(null))
    router.gateway.deleteMapping = () => new Promise(() => {})
    const t0 = Date.now()
    const done = starter.shutdownPunch()
    await vi.waitFor(() => expect(wired.stoppedAt).not.toBe(null), { timeout: 1000 })
    expect(wired.stoppedAt - t0).toBeLessThan(1000)
    await done
  }, 10000)
})
