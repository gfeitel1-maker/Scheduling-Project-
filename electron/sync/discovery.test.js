// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import { advertiseHost, discoverHosts, toValidatedHost } from './discovery.js'

let stopAdvertise

afterEach(() => {
  if (stopAdvertise) {
    stopAdvertise()
    stopAdvertise = undefined
  }
})

describe('advertiseHost + discoverHosts', () => {
  // Uses real LAN multicast (mDNS). May be flaky/fail in sandboxed CI
  // environments without multicast support — that's expected there; it
  // should time out with an empty/partial result rather than crash.
  it('finds an advertised host on the LAN', async () => {
    const port = 6300 + Math.floor(Math.random() * 1000)
    const { stop } = advertiseHost({ campName: 'Camp Test', port })
    stopAdvertise = stop
    const found = await discoverHosts({ timeoutMs: 2000 })
    expect(found.some((h) => h.port === port)).toBe(true)
  }, 5000)

  it('returns an empty array when nothing is advertised', async () => {
    const found = await discoverHosts({ timeoutMs: 300 })
    expect(found).toEqual([])
  }, 5000)
})

describe('toValidatedHost (defensive mapping of raw discovered services)', () => {
  it('maps a well-formed service', () => {
    const result = toValidatedHost({ name: 'Camp A', host: '192.168.1.5', port: 6300 })
    expect(result).toEqual({ name: 'Camp A', host: '192.168.1.5', port: 6300 })
  })

  it('skips a service missing port', () => {
    expect(toValidatedHost({ name: 'Camp A', host: '192.168.1.5' })).toBeNull()
  })

  it('skips a service with wrong-typed host', () => {
    expect(toValidatedHost({ name: 'Camp A', host: 12345, port: 6300 })).toBeNull()
  })

  it('skips a service with wrong-typed name', () => {
    expect(toValidatedHost({ name: null, host: '192.168.1.5', port: 6300 })).toBeNull()
  })

  it('skips a service with wrong-typed port', () => {
    expect(toValidatedHost({ name: 'Camp A', host: '192.168.1.5', port: '6300' })).toBeNull()
  })

  it('skips undefined/null input entirely', () => {
    expect(toValidatedHost(undefined)).toBeNull()
    expect(toValidatedHost(null)).toBeNull()
  })
})
