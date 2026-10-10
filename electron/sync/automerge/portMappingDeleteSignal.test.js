// @vitest-environment node
//
// Final-build audit F1: on quit the router mapping was never removed ("unmap did not complete"), so the
// opening stayed until lease expiry. Cause: the UPnP deleteMapping reused the DISCOVERY AbortSignal
// (AbortSignal.timeout of a few seconds, created when the gateway was found), which has long fired by
// the time anyone deletes; every delete was cancelled at once. A delete must carry its own bound.
import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const lib = vi.hoisted(() => ({ gateway: null, runs: [] }))
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

function fakeLibraryGateway(location, { delayMs = 0 } = {}) {
  const device = {
    service: { location: new URL(location) },
    getService: () => ({ controlURL: `${new URL(location).origin}/ctl` }),
    async run(service, action, args, { signal } = {}) {
      if (signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
      await new Promise((r) => setTimeout(r, delayMs))
      if (signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
      lib.runs.push({ action, args })
    },
  }
  return { gateway: device, async getGateway() { return device }, stop() {} }
}

describe('UPnP deleteMapping carries its own time bound (F1)', () => {
  it('still deletes after the discovery signal has fired', async () => {
    lib.runs.length = 0
    const location = await serve()
    lib.gateway = fakeLibraryGateway(location)
    const discovery = new AbortController()
    const gw = await (await createLibraryDeps()).openUpnp(location, { signal: discovery.signal, maxBytes: 65536 })
    discovery.abort() // discovery finished long ago; its signal is spent
    await expect(gw.deleteMapping({ internalPort: 50123, externalPort: 50123 })).resolves.toBeUndefined()
    expect(lib.runs).toEqual([{ action: 'DeletePortMapping', args: [['NewRemoteHost', ''], ['NewExternalPort', 50123], ['NewProtocol', 'TCP']] }])
  })

  it('a slow but responsive router (300ms) is deleted', async () => {
    lib.runs.length = 0
    const location = await serve()
    lib.gateway = fakeLibraryGateway(location, { delayMs: 300 })
    const discovery = new AbortController()
    const gw = await (await createLibraryDeps()).openUpnp(location, { signal: discovery.signal, maxBytes: 65536 })
    discovery.abort()
    await gw.deleteMapping({ internalPort: 50123, externalPort: 50123 })
    expect(lib.runs).toHaveLength(1)
  })
})
