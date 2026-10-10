// @vitest-environment node
//
// T359 slice 5 (slice 3 carry item a): the library re-runs its own SSDP search when the descriptor it holds
// expires (about an hour) and swaps in whatever answers. The controlURL host check must hold on that
// refreshed descriptor too, not only on the first one.
import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const lib = vi.hoisted(() => ({ gateway: null }))
vi.mock('@achingbrain/nat-port-mapper', () => ({
  upnpNat: () => ({ getGateway: async () => lib.gateway }),
  pmpNat: () => null,
}))

const { createLibraryDeps } = await vi.importActual('./portMapping.js')

const servers = []
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))) })

async function serve() {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/xml' }); res.end('<root><device/></root>') })
  servers.push(server)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${server.address().port}/rootDesc.xml`
}

const device = (location, controlURL) => ({
  service: { location: new URL(location) },
  getService: () => ({ controlURL }),
})

function fakeLibraryGateway(location, rediscovered) {
  const g = {
    gateway: device(location, `${new URL(location).origin}/ctl`),
    setGateway(d) { g.gateway = d },
    async getGateway() { g.gateway = rediscovered; return g.gateway },
    async externalIp() { await g.getGateway(); return '93.184.216.34' },
    stop() {},
  }
  return g
}

async function open(location, rediscovered) {
  lib.gateway = fakeLibraryGateway(location, rediscovered)
  const deps = await createLibraryDeps()
  return { gw: await deps.openUpnp(location, { signal: AbortSignal.timeout(3000), maxBytes: 65536 }), g: lib.gateway }
}

describe('periodic SSDP re-discovery', () => {
  it('rejects a refreshed descriptor whose controlURL is off the gateway host, and restores the previous one', async () => {
    const location = await serve()
    const rogue = device('http://127.0.0.1:1/rootDesc.xml'.replace(':1/', `:${new URL(location).port}/`), 'http://10.9.9.9:49000/ctl')
    const { gw, g } = await open(location, rogue)
    const before = g.gateway
    await expect(gw.externalIp()).rejects.toThrow(/control/i)
    expect(g.gateway).toBe(before)
  })

  it('rejects a refreshed descriptor served from a different host', async () => {
    const location = await serve()
    const rogue = device('http://10.9.9.9:5000/rootDesc.xml', 'http://10.9.9.9:5000/ctl')
    const { gw } = await open(location, rogue)
    await expect(gw.externalIp()).rejects.toThrow(/moved/i)
  })

  it('accepts a refreshed descriptor that keeps the host and its own controlURL', async () => {
    const location = await serve()
    const fresh = device(location, `${new URL(location).origin}/ctl2`)
    const { gw } = await open(location, fresh)
    await expect(gw.externalIp()).resolves.toBe('93.184.216.34')
  })
})
