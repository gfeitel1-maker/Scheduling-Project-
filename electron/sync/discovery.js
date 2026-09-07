import { Bonjour } from 'bonjour-service'
import { campIdHash } from './campIdHash.js'

// The advertised mDNS instance name. PRIVACY: this string is broadcast in the
// clear to every device on the LAN, so it must never be the camp's
// human-readable name (which is what this used to publish). It is an opaque,
// non-reversible hash of the camp id — an observer sees `camp-3f9a...`, never
// "Camp Ohalo". Same precedent as the libp2p path's campDiscoveryTag
// (electron/sync/automerge/discovery.js); both derive from campIdHash.
export function campServiceName(campId) {
  return `camp-${campIdHash(campId)}`
}

// `campId` (not campName) is required: a Host with no camp row yet cannot be
// advertised, because there is no id to derive an opaque name from. Callers
// advertise once the camp exists (see electron/main.js).
export function advertiseHost({ campId, port }) {
  const bonjour = new Bonjour()
  const service = bonjour.publish({ name: campServiceName(campId), type: 'shoresh', port })
  return {
    stop: () => {
      service.stop(() => bonjour.destroy())
    },
  }
}

// Discovered services come from other devices on the LAN (a system boundary),
// so shape must be validated before use — a malformed broadcast (unrelated
// device, buggy/malicious peer) must be skipped, not trusted or thrown on.
//
// The mapped shape deliberately has no `name`: the broadcast no longer
// carries one. `campTag` is the opaque advertised identifier, useful only for
// (a) telling two Hosts on one LAN apart in the picker and (b) matching
// against a camp id this device already knows (see hostMatchesCamp).
export function toValidatedHost(service) {
  if (!service || typeof service !== 'object') return null
  const { name, host, port } = service
  if (typeof name !== 'string' || typeof host !== 'string' || typeof port !== 'number') {
    return null
  }
  return { campTag: name, host, port }
}

// For a device that already knows its camp id (a returning Client, or any
// future auto-reconnect path): recognize its own camp's Host among several
// broadcasts without any name ever crossing the wire. A fresh device joining
// for the first time has no camp id yet and cannot use this — it picks by
// address, and learns the camp's name only after authenticating.
export function hostMatchesCamp(discoveredHost, campId) {
  if (!discoveredHost || typeof discoveredHost.campTag !== 'string') return false
  if (typeof campId !== 'string' || campId.length === 0) return false
  return discoveredHost.campTag === campServiceName(campId)
}

export function discoverHosts({ timeoutMs }) {
  return new Promise((resolve) => {
    const bonjour = new Bonjour()
    const found = []
    const browser = bonjour.find({ type: 'shoresh' }, (service) => {
      const validated = toValidatedHost(service)
      if (validated) found.push(validated)
    })
    setTimeout(() => {
      browser.stop()
      bonjour.destroy()
      resolve(found)
    }, timeoutMs)
  })
}
