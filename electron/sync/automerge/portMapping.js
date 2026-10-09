// T359 slice 1 (docs/adr/2026-10-09-router-port-mapping-on-rung-1.md): ask this device's own router to
// forward the libp2p TCP listener, with no third party. Collaborators are injected; the production set
// (createLibraryDeps) wraps @achingbrain/nat-port-mapper and is loaded lazily. Nothing in production
// imports this module yet (slice 2+), so it is inert. map/unmap/cleanupStale never throw: every
// failure is a status. The external IP is returned to callers but never logged.
import { isIPv4 } from 'node:net'
import { isPublicAddress } from './punchGossip.js'

export const STATUSES = ['mapped', 'permanent-lease', 'refused', 'no-gateway', 'double-nat', 'port-in-use', 'error']
export const PERMANENT_LEASE_REASON = 'this router keeps the opening after Shoresh quits'
export const TIMED_LEASE_SECONDS = 3600
export const MAX_XML_BYTES = 64 * 1024
const DISCOVERY_MS = 3000
const CALL_MS = 5000
const REFRESH_MS = (TIMED_LEASE_SECONDS / 2) * 1000

const ipInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0)
const sameSubnet = (ip, lan) => {
  const mask = ipInt(lan.netmask)
  return ((ipInt(ip) & mask) >>> 0) === ((ipInt(lan.address) & mask) >>> 0)
}
const lanFor = (ip, interfaces) => interfaces.find((lan) => sameSubnet(ip, lan))

function locationHost(location, interfaces) {
  try {
    const url = new URL(location)
    if (url.protocol !== 'http:' || !isIPv4(url.hostname)) return null
    return lanFor(url.hostname, interfaces) ? url.hostname : null
  } catch {
    return null
  }
}

const withTimeout = (promise, ms) => {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export async function fetchCapped(url, { maxBytes = MAX_XML_BYTES, signal, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { signal, redirect: 'manual' })
  if (!res.ok) throw new Error(`descriptor fetch failed (${res.status ?? 'error'})`)
  if (Number(res.headers.get('content-length')) > maxBytes) throw new Error('descriptor too large')
  const reader = res.body?.getReader?.()
  if (!reader) {
    const text = await res.text()
    if (text.length > maxBytes) throw new Error('descriptor too large')
    return text
  }
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBytes) { await reader.cancel(); throw new Error('descriptor too large') }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// grantStore remembers the external port the router actually granted, so a later start can delete a
// mapping left by a crash even when the router chose a port other than the one requested (and a
// permanent-lease mapping, which never expires on its own). Device-local; never synced.
const NO_STORE = { load: () => null, save: () => {}, clear: () => {} }

export function createPortMapper({ localPort, portInUse = false, deps, log = () => {}, discoveryMs = DISCOVERY_MS, callMs = CALL_MS, onChange = () => {}, grantStore = NO_STORE }) {
  let current = null
  let refreshTimer = null

  const result = (status, extra = {}) => ({ status, lease: null, ...extra })
  const safeLoad = () => { try { return grantStore.load() } catch { return null } }
  const remember = (externalPort) => { try { grantStore.save({ externalPort }) } catch { log('portMapping: could not remember the granted port') } }
  const forget = () => { try { grantStore.clear() } catch { log('portMapping: could not forget the granted port') } }

  async function findUpnp(interfaces) {
    const signal = AbortSignal.timeout(discoveryMs)
    try {
      const iterator = deps.ssdpSearch({ signal })[Symbol.asyncIterator]()
      for (;;) {
        const { done, value } = await withTimeout(iterator.next(), discoveryMs)
        if (done) return null
        const host = locationHost(value.location, interfaces)
        if (!host) { log('portMapping: ignored an SSDP LOCATION that is not on the local subnet'); continue }
        try {
          const gateway = await withTimeout(deps.openUpnp(value.location, { signal, maxBytes: MAX_XML_BYTES }), callMs)
          return { gateway, lan: lanFor(host, interfaces) }
        } catch {
          log('portMapping: a UPnP device description could not be used')
        }
      }
    } catch {
      return null
    }
  }

  async function findPmp(interfaces) {
    try {
      const ip = await withTimeout(deps.defaultGatewayIp(), discoveryMs)
      const lan = ip && isIPv4(ip) ? lanFor(ip, interfaces) : null
      if (!lan) return null
      const gateway = deps.openPmp(ip)
      return gateway ? { gateway, lan } : null
    } catch {
      return null
    }
  }

  async function discover() {
    const interfaces = deps.lanInterfaces().filter((i) => isIPv4(i.address))
    if (interfaces.length === 0) return null
    return (await findUpnp(interfaces)) ?? (await findPmp(interfaces))
  }

  async function addTimedOrPermanent(gateway, lan) {
    const base = { internalPort: localPort, internalHost: lan.address, externalPort: localPort }
    try {
      const { externalPort } = await withTimeout(gateway.addMapping({ ...base, leaseSeconds: TIMED_LEASE_SECONDS }), callMs)
      return { externalPort, lease: TIMED_LEASE_SECONDS }
    } catch (err) {
      if (err?.code !== 'PERMANENT_ONLY') throw err
    }
    const { externalPort } = await withTimeout(gateway.addMapping({ ...base, leaseSeconds: 0 }), callMs)
    return { externalPort, lease: 0 }
  }

  const clearRefresh = () => {
    if (refreshTimer) deps.cancel(refreshTimer)
    refreshTimer = null
  }

  function scheduleRefresh() {
    clearRefresh()
    refreshTimer = deps.schedule(async () => {
      if (!current) return
      try {
        const { externalPort } = await withTimeout(current.gateway.addMapping({ internalPort: localPort, internalHost: current.lan.address, externalPort: current.externalPort, leaseSeconds: TIMED_LEASE_SECONDS }), callMs)
        if (externalPort !== current.externalPort) {
          current.externalPort = externalPort
          remember(externalPort)
          onChange(result('mapped', { externalIp: current.externalIp, externalPort, lease: TIMED_LEASE_SECONDS }))
        }
        scheduleRefresh()
      } catch {
        log('portMapping: refresh failed')
        onChange(result('error'))
      }
    }, REFRESH_MS)
  }

  async function map() {
    if (portInUse) return result('port-in-use')
    await unmap()
    try {
      const found = await discover()
      if (!found) return result('no-gateway')
      const externalIp = await withTimeout(found.gateway.externalIp(), callMs)
      if (typeof externalIp !== 'string' || !isIPv4(externalIp)) return result('error')
      if (!isPublicAddress('ip4', externalIp)) { found.gateway.close?.(); return result('double-nat') }
      let granted
      try {
        granted = await addTimedOrPermanent(found.gateway, found.lan)
      } catch (err) {
        found.gateway.close?.()
        return result(err?.code === 'REFUSED' ? 'refused' : 'error')
      }
      current = { gateway: found.gateway, lan: found.lan, externalIp, externalPort: granted.externalPort }
      remember(granted.externalPort)
      if (granted.lease === 0) return result('permanent-lease', { externalIp, externalPort: granted.externalPort, lease: 0, reason: PERMANENT_LEASE_REASON })
      scheduleRefresh()
      return result('mapped', { externalIp, externalPort: granted.externalPort, lease: granted.lease })
    } catch {
      return result('error')
    }
  }

  async function unmap() {
    clearRefresh()
    const mapping = current
    current = null
    if (!mapping) return
    try {
      await withTimeout(mapping.gateway.deleteMapping({ internalPort: localPort, externalPort: mapping.externalPort }), callMs)
      forget()
    } catch {
      log('portMapping: unmap did not complete')
    }
    try { await mapping.gateway.close?.() } catch { /* best effort */ }
  }

  async function cleanupStale() {
    try {
      const found = await discover()
      if (!found) return
      const ports = new Set([localPort])
      const remembered = safeLoad()?.externalPort
      if (Number.isInteger(remembered) && remembered > 0 && remembered < 65536) ports.add(remembered)
      let allRemoved = true
      for (const externalPort of ports) {
        try {
          await withTimeout(found.gateway.deleteMapping({ internalPort: localPort, externalPort }), callMs)
        } catch {
          allRemoved = false
          log('portMapping: no stale mapping removed')
        }
      }
      if (allRemoved) forget()
      await found.gateway.close?.()
    } catch { /* never throws */ }
  }

  async function start() {
    await cleanupStale()
    return map()
  }

  return { start, map, unmap, cleanupStale }
}

// Production collaborators over @achingbrain/nat-port-mapper, loaded on first use. The library fetches
// whatever LOCATION its own SSDP search hears, so SSDP is done here and only on-subnet LOCATIONs ever
// reach it; the descriptor is first read through fetchCapped (size cap, timeout). Library limits worth
// knowing: it speaks IGD:2 only (so 'permanent-lease' cannot arise from it), and its unmap only knows
// mappings it made itself, so deletes go straight to the UPnP DeletePortMapping action / NAT-PMP lifetime 0.
const WAN_IP_CONNECTION_2 = 'urn:schemas-upnp-org:service:WANIPConnection:2'
const SSDP_ADDRESS = '239.255.255.250'
const SSDP_PORT = 1900

function codedError(err) {
  const msg = String(err?.message ?? err)
  if (/Code 725\b/.test(msg)) return Object.assign(err, { code: 'PERMANENT_ONLY' })
  if (err?.name === 'UPnPError' || /Not Authorized|Out of Resources|Unsupported/.test(msg)) return Object.assign(err, { code: 'REFUSED' })
  return err
}

export async function createLibraryDeps() {
  const [{ upnpNat, pmpNat }, os, dgram, childProcess, fs] = await Promise.all([
    import('@achingbrain/nat-port-mapper'),
    import('node:os'),
    import('node:dgram'),
    import('node:child_process'),
    import('node:fs'),
  ])

  const wrap = (g, extra) => ({
    externalIp: ({ signal } = {}) => g.externalIp({ signal }),
    addMapping: async ({ internalPort, internalHost, externalPort, leaseSeconds }) => {
      if (leaseSeconds === 0) throw Object.assign(new Error('the library cannot request a permanent lease'), { code: 'REFUSED' })
      try {
        const m = await g.map(internalPort, internalHost, { protocol: 'tcp', externalPort, ttl: leaseSeconds * 1000, autoRefresh: false })
        return { externalPort: m.externalPort }
      } catch (err) { throw codedError(err) }
    },
    close: () => g.stop(),
    ...extra(g),
  })

  return {
    lanInterfaces: () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map((i) => ({ address: i.address, netmask: i.netmask })),

    async *ssdpSearch({ signal }) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      const found = []
      let wake = () => {}
      socket.on('message', (msg) => {
        const location = /^location:\s*(\S+)/im.exec(msg.toString('utf8').slice(0, 2048))?.[1]
        if (location) { found.push({ location }); wake() }
      })
      socket.on('error', () => wake())
      try {
        await new Promise((resolve) => socket.bind(0, resolve))
        const search = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:2\r\n\r\n`
        socket.send(search, SSDP_PORT, SSDP_ADDRESS)
        while (!signal.aborted) {
          if (found.length) { yield found.shift(); continue }
          await new Promise((resolve) => { wake = resolve; signal.addEventListener('abort', resolve, { once: true }) })
        }
      } finally {
        socket.close()
      }
    },

    async openUpnp(location, { signal, maxBytes }) {
      await fetchCapped(location, { maxBytes, signal })
      const g = await upnpNat({ autoRefresh: false }).getGateway(new URL(location), { signal })
      return wrap(g, (gw) => ({
        deleteMapping: async ({ externalPort }) => {
          const device = await gw.getGateway({ signal })
          await device.run(WAN_IP_CONNECTION_2, 'DeletePortMapping', [['NewRemoteHost', ''], ['NewExternalPort', externalPort], ['NewProtocol', 'TCP']], { signal })
        },
      }))
    },

    openPmp: (ip) => wrap(pmpNat(ip, { autoRefresh: false }), (gw) => ({
      deleteMapping: ({ internalPort }) => gw.unmap(internalPort),
    })),

    async defaultGatewayIp() {
      if (process.platform === 'linux') {
        const row = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).map((l) => l.split('\t')).find((c) => c[1] === '00000000')
        return row ? [3, 2, 1, 0].map((i) => parseInt(row[2].slice(i * 2, i * 2 + 2), 16)).join('.') : null
      }
      if (process.platform !== 'darwin') return null
      const out = await new Promise((resolve) => childProcess.execFile('/sbin/route', ['-n', 'get', 'default'], { timeout: 2000 }, (e, stdout) => resolve(e ? '' : stdout)))
      return /gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null
    },

    schedule: (fn, ms) => setTimeout(fn, ms).unref(),
    cancel: (t) => clearTimeout(t),
  }
}
