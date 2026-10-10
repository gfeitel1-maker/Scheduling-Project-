// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PERMANENT_LEASE_REASON } from './portMapping.js'
import { createFileGrantStore } from './portMappingGrantStore.js'
import { createPortMappingLifecycle } from './portMappingLifecycle.js'

const PUBLIC_IP = '93.184.216.34'
const tmpDirs = []
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function fakeGateway(log, name, { mode = 'timed', hangDelete = false } = {}) {
  const table = new Map()
  return {
    table,
    externalIp: async () => PUBLIC_IP,
    addMapping: async ({ internalPort, internalHost, leaseSeconds, externalPort }) => {
      log.push(`${name}:add`)
      if (mode === 'refused') throw Object.assign(new Error('refused'), { code: 'REFUSED' })
      if (mode === 'permanent-only' && leaseSeconds !== 0) throw Object.assign(new Error('725'), { code: 'PERMANENT_ONLY' })
      table.set(externalPort, { internalHost, internalPort })
      return { externalPort }
    },
    deleteMapping: async ({ externalPort }) => {
      log.push(`${name}:delete`)
      if (hangDelete) await new Promise(() => {})
      table.delete(externalPort)
    },
  }
}

// One mutable "network": which LAN we are on, and the gateway that answers there.
function network(opts = {}) {
  const log = []
  const nets = {
    A: { lan: [{ address: '192.168.1.20', netmask: '255.255.255.0' }], location: 'http://192.168.1.1:5000/d.xml', gw: '192.168.1.1', gateway: fakeGateway(log, 'A', opts) },
    B: { lan: [{ address: '10.0.0.20', netmask: '255.255.255.0' }], location: 'http://10.0.0.1:5000/d.xml', gw: '10.0.0.1', gateway: fakeGateway(log, 'B') },
  }
  let at = 'A'
  const deps = {
    lanInterfaces: () => nets[at].lan,
    ssdpSearch: async function* () { yield { location: nets[at].location } },
    openUpnp: async () => nets[at].gateway,
    defaultGatewayIp: async () => nets[at].gw,
    openPmp: () => null,
    schedule: () => ({}),
    cancel: () => {},
  }
  return { log, nets, deps, moveTo: (n) => { at = n } }
}

const make = (net, extra = {}) => createPortMappingLifecycle({ localPort: 50123, portInUse: false, deps: net.deps, discoveryMs: 50, checkMs: 0, ...extra })

describe('start', () => {
  it('cleans stale mappings, then maps; status and mapped address come from the live result', async () => {
    const net = network()
    const lc = make(net)
    expect(lc.getStatus()).toBe(null)
    expect(lc.getMappedAddress()).toBe(null)
    await lc.start()
    expect(net.log).toEqual(['A:delete', 'A:add'])
    expect(lc.getStatus()).toEqual({ status: 'mapped', lease: 3600 })
    expect(lc.getMappedAddress()).toBe(`/ip4/${PUBLIC_IP}/tcp/50123`)
    await lc.stop()
  })

  it('reports port-in-use and never adds a mapping (a stale one is still cleaned)', async () => {
    const net = network()
    const lc = make(net, { portInUse: true })
    await lc.start()
    expect(lc.getStatus()).toEqual({ status: 'port-in-use', lease: null })
    expect(lc.getMappedAddress()).toBe(null)
    expect(net.log).not.toContain('A:add')
    await lc.stop()
  })

  it('onChange fires when the first result arrives', async () => {
    const onChange = vi.fn()
    const lc = make(network(), { onChange })
    await lc.start()
    expect(onChange).toHaveBeenCalled()
    await lc.stop()
  })
})

describe('getStatus is exactly { status, lease, reason? }', () => {
  const KEYS = new Set(['status', 'lease', 'reason'])
  it('never carries the external IP or port, for any status', async () => {
    const cases = [
      network(),
      network({ mode: 'refused' }),
      network({ mode: 'permanent-only' }),
    ]
    for (const net of cases) {
      const lc = make(net)
      await lc.start()
      const status = lc.getStatus()
      expect(Object.keys(status).every((k) => KEYS.has(k))).toBe(true)
      expect(JSON.stringify(status)).not.toContain(PUBLIC_IP)
      expect(JSON.stringify(status)).not.toContain('externalIp')
      await lc.stop()
    }
  })

  it('permanent-lease carries the exact reason; mapped carries none', async () => {
    const mapped = make(network())
    await mapped.start()
    expect(mapped.getStatus()).toEqual({ status: 'mapped', lease: 3600 })
    await mapped.stop()
    const permanent = make(network({ mode: 'permanent-only' }))
    await permanent.start()
    expect(permanent.getStatus()).toEqual({ status: 'permanent-lease', lease: 0, reason: PERMANENT_LEASE_REASON })
    await permanent.stop()
  })
})

describe('stop', () => {
  it('removes the mapping from the router and forgets the address', async () => {
    const net = network()
    const lc = make(net)
    await lc.start()
    await lc.stop()
    expect(net.nets.A.gateway.table.size).toBe(0)
    expect(lc.getMappedAddress()).toBe(null)
    expect(lc.getStatus()).toBe(null)
  })

  it('is bounded: a router that never answers the delete cannot hold quit', async () => {
    const net = network({ hangDelete: true })
    const lc = make(net, { quitUnmapMs: 80, callMs: 100 })
    await lc.start()
    const t0 = Date.now()
    await lc.stop()
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('a start that finishes after the stop bound has elapsed still removes its mapping', async () => {
    const net = network()
    const gate = {}
    const slow = new Promise((r) => { gate.release = r })
    const openUpnp = net.deps.openUpnp
    net.deps.openUpnp = async (...a) => { await slow; return openUpnp(...a) }
    const lc = make(net, { quitUnmapMs: 20 })
    const starting = lc.start()
    await lc.stop()
    gate.release()
    await starting
    expect(net.nets.A.gateway.table.size).toBe(0)
    expect(lc.getMappedAddress()).toBe(null)
  })
})

describe('network or gateway change', () => {
  it('unmaps from the old gateway, then maps on the new one', async () => {
    const net = network()
    const lc = make(net)
    await lc.start()
    net.log.length = 0
    net.moveTo('B')
    await lc.checkNetwork()
    expect(net.log).toEqual(['A:delete', 'B:add'])
    expect(net.nets.A.gateway.table.size).toBe(0)
    expect(net.nets.B.gateway.table.size).toBe(1)
    expect(lc.getMappedAddress()).toBe(`/ip4/${PUBLIC_IP}/tcp/50123`)
    await lc.stop()
  })

  it('an unchanged network does nothing', async () => {
    const net = network()
    const lc = make(net)
    await lc.start()
    net.log.length = 0
    await lc.checkNetwork()
    expect(net.log).toEqual([])
    await lc.stop()
  })

  it('an old gateway that is gone does not stop the new mapping', async () => {
    const net = network()
    net.nets.A.gateway.deleteMapping = async () => { throw new Error('unreachable') }
    const lc = make(net)
    await lc.start()
    net.moveTo('B')
    await lc.checkNetwork()
    expect(lc.getStatus()).toEqual({ status: 'mapped', lease: 3600 })
    await lc.stop()
  })

  it('does nothing after stop', async () => {
    const net = network()
    const lc = make(net)
    await lc.start()
    await lc.stop()
    net.log.length = 0
    net.moveTo('B')
    await lc.checkNetwork()
    expect(net.log).toEqual([])
  })
})

describe('crash recovery through the file grantStore', () => {
  it('a mapping left by a crashed run is deleted by the next start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'))
    tmpDirs.push(dir)
    const file = path.join(dir, 'g.json')
    const net = network()
    const first = make(net, { grantStore: createFileGrantStore(file) })
    await first.start()
    expect(fs.existsSync(file)).toBe(true)
    // no stop: the process died
    const next = make(net, { grantStore: createFileGrantStore(file) })
    net.log.length = 0
    await next.start()
    expect(net.log[0]).toBe('A:delete')
    await next.stop()
    expect(fs.existsSync(file)).toBe(false)
  })
})
