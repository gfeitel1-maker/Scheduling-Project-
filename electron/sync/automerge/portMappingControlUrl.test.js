// @vitest-environment node
//
// T359 slice 3 (slice 1 carry item): the library re-fetches the SSDP LOCATION itself and then talks to
// the descriptor's controlURL, whatever host that names. openUpnp must refuse a device whose controlURL
// is not on the LOCATION host, so a LAN device cannot steer SOAP requests (with this device's internal
// address in them) to another host.
import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
const { createLibraryDeps } = await vi.importActual('./portMapping.js')

const servers = []
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))) })

const descriptor = (controlURL) => `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:2</deviceType><UDN>uuid:test</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType><SCPDURL>/scpd.xml</SCPDURL><controlURL>${controlURL}</controlURL></service></serviceList></device></root>`

async function serve(controlURL, { redirectTo } = {}) {
  const server = http.createServer((req, res) => {
    if (redirectTo) { res.writeHead(302, { Location: redirectTo }); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/xml' })
    res.end(descriptor(controlURL))
  })
  servers.push(server)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${server.address().port}/rootDesc.xml`
}

const open = async (location) => (await createLibraryDeps()).openUpnp(location, { signal: AbortSignal.timeout(3000), maxBytes: 65536 })

describe('openUpnp control URL', () => {
  it('rejects a descriptor whose controlURL points off the LOCATION host', async () => {
    const location = await serve('http://10.9.9.9:49000/ctl')
    await expect(open(location)).rejects.toThrow(/control/i)
  })

  it('rejects an https controlURL on the same host', async () => {
    const location = await serve('https://127.0.0.1/ctl')
    await expect(open(location)).rejects.toThrow(/control/i)
  })

  it('accepts a relative controlURL on the LOCATION host', async () => {
    await expect(open(await serve('/ctl'))).resolves.toBeTruthy()
  })

  it('does not follow a redirect, even to a valid descriptor', async () => {
    const valid = await serve('/ctl')
    const redirecting = await serve('/ctl', { redirectTo: valid })
    await expect(open(redirecting)).rejects.toThrow()
  })
})
