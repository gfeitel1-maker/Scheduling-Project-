import { Bonjour } from 'bonjour-service'

export function advertiseHost({ campName, port }) {
  const bonjour = new Bonjour()
  const service = bonjour.publish({ name: campName, type: 'shoresh', port })
  return {
    stop: () => {
      service.stop(() => bonjour.destroy())
    },
  }
}

// Discovered services come from other devices on the LAN (a system boundary),
// so shape must be validated before use — a malformed broadcast (unrelated
// device, buggy/malicious peer) must be skipped, not trusted or thrown on.
export function toValidatedHost(service) {
  if (!service || typeof service !== 'object') return null
  const { name, host, port } = service
  if (typeof name !== 'string' || typeof host !== 'string' || typeof port !== 'number') {
    return null
  }
  return { name, host, port }
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
