// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createPortMapper, PERMANENT_LEASE_REASON, STATUSES, fetchCapped } from './portMapping.js'

const PUBLIC_IP = '93.184.216.34'
const LAN = [{ address: '192.168.1.20', netmask: '255.255.255.0' }]
const LOCATION = 'http://192.168.1.1:5000/rootDesc.xml'

function fakeGateway({ externalIp = PUBLIC_IP, mode = 'timed', grantPort } = {}) {
  const table = new Map()
  const calls = []
  return {
    table,
    calls,
    externalIp: async () => externalIp,
    addMapping: async ({ internalPort, internalHost, leaseSeconds, externalPort }) => {
      calls.push({ op: 'add', internalPort, internalHost, leaseSeconds, externalPort })
      if (mode === 'refused') throw Object.assign(new Error('refused'), { code: 'REFUSED' })
      if (mode === 'error') throw new Error('boom')
      if (mode === 'permanent-only' && leaseSeconds !== 0) throw Object.assign(new Error('725'), { code: 'PERMANENT_ONLY' })
      const granted = grantPort ?? externalPort ?? internalPort
      table.set(granted, { internalHost, internalPort, leaseSeconds })
      return { externalPort: granted }
    },
    deleteMapping: async ({ externalPort }) => {
      calls.push({ op: 'delete', externalPort })
      table.delete(externalPort)
    },
  }
}

function world({ gateway = fakeGateway(), ssdp = [{ location: LOCATION }], pmp = null, defaultGw = '192.168.1.1', ...over } = {}) {
  const timers = []
  const deps = {
    lanInterfaces: () => LAN,
    ssdpSearch: vi.fn(async function* () { yield* ssdp }),
    openUpnp: vi.fn(async () => gateway),
    defaultGatewayIp: async () => defaultGw,
    openPmp: vi.fn(() => pmp),
    schedule: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    cancel: (t) => { t.cleared = true },
    ...over,
  }
  const log = vi.fn()
  const mapper = createPortMapper({ localPort: 50123, deps, log, discoveryMs: 50 })
  return { mapper, deps, gateway, timers, log }
}

describe('status enum against a fake gateway', () => {
  it('exports the closed status set', () => {
    expect(STATUSES).toEqual(['mapped', 'permanent-lease', 'refused', 'no-gateway', 'double-nat', 'port-in-use', 'error'])
  })

  it('mapped: timed 1h lease, router-reported external IP, LAN host of the gateway subnet', async () => {
    const w = world()
    const r = await w.mapper.map()
    expect(r).toMatchObject({ status: 'mapped', externalIp: PUBLIC_IP, externalPort: 50123, lease: 3600 })
    expect(w.gateway.table.get(50123)).toEqual({ internalHost: '192.168.1.20', internalPort: 50123, leaseSeconds: 3600 })
  })

  it('uses the RETURNED external port, not the requested one', async () => {
    const w = world({ gateway: fakeGateway({ grantPort: 61000 }) })
    const r = await w.mapper.map()
    expect(r).toMatchObject({ status: 'mapped', externalPort: 61000 })
  })

  it('refused', async () => {
    const w = world({ gateway: fakeGateway({ mode: 'refused' }) })
    expect(await w.mapper.map()).toMatchObject({ status: 'refused' })
  })

  it('error: an unexpected gateway failure is a status, never a throw', async () => {
    const w = world({ gateway: fakeGateway({ mode: 'error' }) })
    expect(await w.mapper.map()).toMatchObject({ status: 'error' })
    const w2 = world({ openUpnp: async () => { throw new Error('xml') } })
    expect((await w2.mapper.map()).status).toBe('no-gateway')
  })

  it('no-gateway: nothing answers SSDP and there is no default gateway', async () => {
    const w = world({ ssdp: [], defaultGw: null })
    expect(await w.mapper.map()).toMatchObject({ status: 'no-gateway' })
  })

  it('no-gateway: a discovery that never answers is cut off by the timeout', async () => {
    const w = world({ ssdpSearch: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }), defaultGw: null })
    expect(await w.mapper.map()).toMatchObject({ status: 'no-gateway' })
  })

  it('falls back to NAT-PMP via the default gateway when UPnP finds nothing', async () => {
    const pmp = fakeGateway()
    const w = world({ ssdp: [], pmp })
    expect(await w.mapper.map()).toMatchObject({ status: 'mapped', externalPort: 50123 })
    expect(w.deps.openPmp).toHaveBeenCalledWith('192.168.1.1')
  })

  it('port-in-use: answers without touching the network', async () => {
    const w = world()
    const mapper = createPortMapper({ localPort: 0, portInUse: true, deps: w.deps })
    expect(await mapper.map()).toMatchObject({ status: 'port-in-use' })
    expect(w.deps.ssdpSearch).not.toHaveBeenCalled()
  })
})

describe('double NAT', () => {
  for (const ip of ['10.1.2.3', '192.168.0.9', '172.20.0.4', '100.64.3.4', '100.127.255.254']) {
    it(`${ip} reported as the external address is double-nat and nothing is mapped`, async () => {
      const w = world({ gateway: fakeGateway({ externalIp: ip }) })
      const r = await w.mapper.map()
      expect(r.status).toBe('double-nat')
      expect(r.externalPort).toBeUndefined()
      expect(w.gateway.calls.filter((c) => c.op === 'add')).toHaveLength(0)
    })
  }
})

describe('SSDP LOCATION validation', () => {
  it('never follows a LOCATION that is off the gateway subnet or not an IPv4 literal', async () => {
    const w = world({ ssdp: [{ location: 'http://8.8.8.8/d.xml' }, { location: 'http://10.0.0.1/d.xml' }, { location: 'http://router.example/d.xml' }, { location: 'file:///etc/passwd' }], defaultGw: null })
    expect(await w.mapper.map()).toMatchObject({ status: 'no-gateway' })
    expect(w.deps.openUpnp).not.toHaveBeenCalled()
  })

  it('an on-subnet LOCATION after an off-subnet one is still used', async () => {
    const w = world({ ssdp: [{ location: 'http://8.8.8.8/d.xml' }, { location: LOCATION }] })
    expect((await w.mapper.map()).status).toBe('mapped')
    expect(w.deps.openUpnp).toHaveBeenCalledTimes(1)
    expect(w.deps.openUpnp.mock.calls[0][0]).toBe(LOCATION)
  })
})

describe('lease policy', () => {
  it('prefers a timed lease when the router offers both: one add, lease 3600, never a lease 0', async () => {
    const w = world()
    await w.mapper.map()
    expect(w.gateway.calls.filter((c) => c.op === 'add').map((c) => c.leaseSeconds)).toEqual([3600])
  })

  it('a permanent-only router is still mapped, as permanent-lease, with the exact director-facing reason', async () => {
    const w = world({ gateway: fakeGateway({ mode: 'permanent-only' }) })
    const r = await w.mapper.map()
    expect(PERMANENT_LEASE_REASON).toBe('this router keeps the opening after Shoresh quits')
    expect(r).toMatchObject({ status: 'permanent-lease', lease: 0, externalPort: 50123, reason: PERMANENT_LEASE_REASON })
    expect(w.gateway.table.size).toBe(1)
  })

  it('a permanent lease is deleted on unmap', async () => {
    const w = world({ gateway: fakeGateway({ mode: 'permanent-only', grantPort: 60001 }) })
    await w.mapper.map()
    await w.mapper.unmap()
    expect(w.gateway.table.size).toBe(0)
  })

  it('a permanent lease left by a crashed run is deleted by cleanupStale on a fresh mapper', async () => {
    const gateway = fakeGateway({ mode: 'permanent-only' })
    await world({ gateway }).mapper.map()
    expect(gateway.table.size).toBe(1)
    const fresh = world({ gateway })
    await fresh.mapper.cleanupStale()
    expect(gateway.table.size).toBe(0)
  })

  it('start() cleans stale mappings before it adds', async () => {
    const w = world()
    await w.mapper.start()
    const ops = w.gateway.calls.map((c) => c.op)
    expect(ops.indexOf('delete')).toBeLessThan(ops.indexOf('add'))
    expect(w.gateway.table.size).toBe(1)
  })
})

describe('refresh, unmap and logging', () => {
  it('schedules a refresh that re-adds the mapping; unmap cancels it and removes the entry', async () => {
    const w = world()
    await w.mapper.map()
    expect(w.timers).toHaveLength(1)
    await w.timers[0].fn()
    expect(w.gateway.calls.filter((c) => c.op === 'add')).toHaveLength(2)
    await w.mapper.unmap()
    expect(w.timers.at(-1).cleared).toBe(true)
    expect(w.gateway.table.size).toBe(0)
  })

  it('unmap before any mapping, or with a dead gateway, never throws', async () => {
    const w = world()
    await expect(w.mapper.unmap()).resolves.toBeUndefined()
    await w.mapper.map()
    w.gateway.deleteMapping = async () => { throw new Error('gone') }
    await expect(w.mapper.unmap()).resolves.toBeUndefined()
  })

  it('never writes the external IP to the log', async () => {
    const w = world()
    await w.mapper.map()
    await w.mapper.unmap()
    expect(JSON.stringify(w.log.mock.calls)).not.toContain(PUBLIC_IP)
  })
})

describe('fetchCapped', () => {
  it('does not follow redirects', async () => {
    let init
    await fetchCapped('http://192.168.1.1/d.xml', { fetchImpl: async (_u, i) => { init = i; return res('<a/>') } })
    expect(init.redirect).toBe('manual')
  })

  const res = (body, extra = {}) => ({ ok: true, headers: new Map([['content-type', 'text/xml']]), text: async () => body, ...extra })
  it('returns a body under the cap', async () => {
    expect(await fetchCapped('http://192.168.1.1/d.xml', { maxBytes: 100, fetchImpl: async () => res('<a/>') })).toBe('<a/>')
  })
  it('rejects a body over the cap', async () => {
    await expect(fetchCapped('http://192.168.1.1/d.xml', { maxBytes: 10, fetchImpl: async () => res('x'.repeat(50)) })).rejects.toThrow(/too large/)
  })
})

describe('re-map and library deps', () => {
  it('mapping twice on the same port leaves exactly the fresh mapping (the old one is not deleted after the new add)', async () => {
    const w = world()
    await w.mapper.map()
    await w.mapper.map()
    expect(w.gateway.table.size).toBe(1)
  })

  it('createLibraryDeps loads the dependency lazily and exposes the collaborator surface', async () => {
    const { createLibraryDeps } = await vi.importActual('./portMapping.js')
    const deps = await createLibraryDeps()
    for (const k of ['lanInterfaces', 'ssdpSearch', 'openUpnp', 'openPmp', 'defaultGatewayIp', 'schedule', 'cancel']) expect(typeof deps[k]).toBe('function')
  })
})

describe('remembered grant: startup cleanup removes a mapping whose external port differs', () => {
  const memoryStore = () => {
    let rec = null
    return { load: () => rec, save: (r) => { rec = r }, clear: () => { rec = null }, peek: () => rec }
  }

  it('a crash after the router granted a different external port leaves nothing behind on the next start', async () => {
    const gateway = fakeGateway({ grantPort: 61000 })
    const store = memoryStore()
    const first = world({ gateway })
    const crashed = createPortMapper({ localPort: 50123, deps: first.deps, discoveryMs: 50, grantStore: store })
    expect(await crashed.map()).toMatchObject({ status: 'mapped', externalPort: 61000 })
    expect(store.peek()).toEqual({ externalPort: 61000 })
    // no unmap: the process died. A fresh mapper on the next start shares only the store.
    const next = createPortMapper({ localPort: 50123, deps: first.deps, discoveryMs: 50, grantStore: store })
    await next.cleanupStale()
    expect(gateway.table.has(61000)).toBe(false)
    expect(store.peek()).toBe(null)
  })

  it('a permanent-lease grant is remembered and removed by startup cleanup', async () => {
    const gateway = fakeGateway({ mode: 'permanent-only', grantPort: 61001 })
    const store = memoryStore()
    const w = world({ gateway })
    const crashed = createPortMapper({ localPort: 50123, deps: w.deps, discoveryMs: 50, grantStore: store })
    expect(await crashed.map()).toMatchObject({ status: 'permanent-lease', reason: PERMANENT_LEASE_REASON })
    await createPortMapper({ localPort: 50123, deps: w.deps, discoveryMs: 50, grantStore: store }).cleanupStale()
    expect(gateway.table.size).toBe(0)
  })

  it('a clean unmap forgets the remembered grant', async () => {
    const store = memoryStore()
    const w = world()
    const m = createPortMapper({ localPort: 50123, deps: w.deps, discoveryMs: 50, grantStore: store })
    await m.map()
    await m.unmap()
    expect(store.peek()).toBe(null)
  })
})

describe('T359 slice 3 carry items: a failing grantStore and a missing entry', () => {
  const throwingStore = { load: () => { throw new Error('load') }, save: () => { throw new Error('save') }, clear: () => { throw new Error('clear') } }

  it('a grantStore whose load, save and clear all throw never makes the mapper throw', async () => {
    const w = world()
    const m = createPortMapper({ localPort: 50123, deps: w.deps, discoveryMs: 50, grantStore: throwingStore })
    await expect(m.start()).resolves.toMatchObject({ status: 'mapped' })
    await expect(m.cleanupStale()).resolves.toBeUndefined()
    await expect(m.unmap()).resolves.toBeUndefined()
    await expect(m.map()).resolves.toMatchObject({ status: 'mapped' })
  })

  const noEntryGateway = () => {
    const g = fakeGateway()
    g.deleteMapping = async () => { throw Object.assign(new Error('Code 714 - NoSuchEntryInArray'), { code: 'NO_SUCH_ENTRY' }) }
    return g
  }
  const memoryStore = () => {
    let rec = null
    return { load: () => rec, save: (r) => { rec = r }, clear: () => { rec = null }, peek: () => rec }
  }

  it('unmap treats "no such entry" as success: the remembered grant clears', async () => {
    const store = memoryStore()
    const w = world({ gateway: noEntryGateway() })
    const m = createPortMapper({ localPort: 50123, deps: w.deps, discoveryMs: 50, grantStore: store })
    await m.map()
    expect(store.peek()).toEqual({ externalPort: 50123 })
    await m.unmap()
    expect(store.peek()).toBe(null)
  })

  it('cleanupStale treats "no such entry" as success: the remembered grant clears', async () => {
    const store = memoryStore()
    store.save({ externalPort: 61000 })
    const w = world({ gateway: noEntryGateway() })
    await createPortMapper({ localPort: 50123, deps: w.deps, discoveryMs: 50, grantStore: store }).cleanupStale()
    expect(store.peek()).toBe(null)
  })

  it('any other delete failure keeps the remembered grant for the next start', async () => {
    const store = memoryStore()
    store.save({ externalPort: 61000 })
    const g = fakeGateway()
    g.deleteMapping = async () => { throw new Error('router unreachable') }
    const w = world({ gateway: g })
    await createPortMapper({ localPort: 50123, deps: w.deps, discoveryMs: 50, grantStore: store }).cleanupStale()
    expect(store.peek()).toEqual({ externalPort: 61000 })
  })
})

describe('quit unmap failure is recovered at the next start (final-build audit F1)', () => {
  const memoryStore = () => { let rec = null; return { load: () => rec, save: (r) => { rec = r }, clear: () => { rec = null }, peek: () => rec } }

  it('a failed unmap keeps the grant record; the next start removes the mapping, clears the record and says so', async () => {
    const gateway = fakeGateway()
    const realDelete = gateway.deleteMapping
    const store = memoryStore()
    const w = world({ gateway })
    const first = createPortMapper({ localPort: 50123, deps: w.deps, discoveryMs: 50, grantStore: store, log: w.log })
    await first.map()
    gateway.deleteMapping = async () => { throw new Error('This operation was aborted') }
    await first.unmap()
    expect(w.log).toHaveBeenCalledWith('portMapping: unmap did not complete')
    expect(store.peek()).toEqual({ externalPort: 50123 })
    expect(gateway.table.has(50123)).toBe(true)
    gateway.deleteMapping = realDelete
    const log = vi.fn()
    await createPortMapper({ localPort: 50123, deps: w.deps, discoveryMs: 50, grantStore: store, log }).cleanupStale()
    expect(gateway.table.has(50123)).toBe(false)
    expect(store.peek()).toBe(null)
    expect(log).toHaveBeenCalledWith('portMapping: removed stale mapping')
  })
})
