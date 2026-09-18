// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createConnectivityEmitter, classifyMultiaddr, classifyError, EVENTS } from './connectivityEvents.js'

const PUBLIC_ADDR = '/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWabc'
const PRIVATE_ADDR = '/ip4/192.168.1.5/tcp/4001/p2p/12D3KooWabc'
const LOOPBACK_ADDR = '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWabc'

describe('connectivityEvents: address classification (privacy boundary)', () => {
  it('classifies a public IPv4 multiaddr as public', () => {
    expect(classifyMultiaddr(PUBLIC_ADDR)).toBe('public')
  })

  it('classifies an RFC1918 address as private', () => {
    expect(classifyMultiaddr(PRIVATE_ADDR)).toBe('private')
  })

  it('classifies loopback as loopback', () => {
    expect(classifyMultiaddr(LOOPBACK_ADDR)).toBe('loopback')
  })
})

describe('connectivityEvents: literal multiaddr redaction (defect: leak the public IP)', () => {
  it('does NOT include the literal multiaddr in the emitted line at default verbosity', () => {
    const lines = []
    const { emit } = createConnectivityEmitter({ sink: (line) => lines.push(line) })

    emit(EVENTS.PEER_DISCOVERED, { peerId: 'peer-1', multiaddrs: [PUBLIC_ADDR] })

    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('203.0.113.7')
    const parsed = JSON.parse(lines[0])
    expect(parsed.multiaddrClasses).toEqual(['public'])
    expect(parsed.multiaddrCount).toBe(1)
  })

  it('DOES include the literal multiaddr when verboseAddrs is true (explicit opt-in)', () => {
    const lines = []
    const { emit } = createConnectivityEmitter({ sink: (line) => lines.push(line), verboseAddrs: true })

    emit(EVENTS.PEER_DISCOVERED, { peerId: 'peer-1', multiaddrs: [PUBLIC_ADDR] })

    expect(lines[0]).toContain('203.0.113.7')
  })
})

describe('connectivityEvents: allowlist drops unknown fields (defect: credential leak via extra field)', () => {
  it('drops a field not on the event allowlist, e.g. a bearer token', () => {
    const lines = []
    const { emit } = createConnectivityEmitter({ sink: (line) => lines.push(line) })

    emit(EVENTS.AUTH_OK, { peerId: 'peer-1', token: 'super-secret-token-value', pin: '1234' })

    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('super-secret-token-value')
    expect(lines[0]).not.toContain('1234')
  })
})

describe('connectivityEvents: emit never throws even if the sink is broken', () => {
  it('swallows a throwing sink and reports via console.error instead of propagating', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const brokenSink = () => {
      throw new Error('sink is on fire')
    }
    const { emit } = createConnectivityEmitter({ sink: brokenSink })

    expect(() => emit(EVENTS.AUTH_OK, { peerId: 'peer-1' })).not.toThrow()
    expect(consoleErrorSpy).toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })
})

describe('connectivityEvents: errorClass classification never carries the raw message', () => {
  it('classifies a connection-refused style error', () => {
    expect(classifyError({ code: 'ECONNREFUSED' })).toBe('refused')
  })

  it('classifies a timeout style error', () => {
    expect(classifyError({ code: 'ETIMEDOUT' })).toBe('timeout')
  })

  it('classifies a reset style error', () => {
    expect(classifyError({ code: 'ECONNRESET' })).toBe('reset')
  })

  it('classifies unreachable-host errors', () => {
    expect(classifyError({ code: 'EHOSTUNREACH' })).toBe('unreachable')
  })

  it('falls back to unknown for an unrecognized error, and never leaks err.message', () => {
    const lines = []
    const { emit } = createConnectivityEmitter({ sink: (line) => lines.push(line) })
    const err = new Error('secret internal detail 203.0.113.7:9999')
    const errorClass = classifyError(err)

    expect(errorClass).toBe('unknown')

    emit(EVENTS.DIAL_FAILED, { peerId: 'peer-1', reused: false, errorClass })
    expect(lines[0]).not.toContain('secret internal detail')
  })
})

describe('connectivityEvents: vocabulary-only reserved event', () => {
  it('RENDEZVOUS_UNAVAILABLE is a defined constant emittable by the module, per the ADR reservation', () => {
    expect(EVENTS.RENDEZVOUS_UNAVAILABLE).toBe('RENDEZVOUS_UNAVAILABLE')
    const lines = []
    const { emit } = createConnectivityEmitter({ sink: (line) => lines.push(line) })
    emit(EVENTS.RENDEZVOUS_UNAVAILABLE, { peerId: 'peer-1', reason: 'disabled' })
    expect(JSON.parse(lines[0]).reason).toBe('disabled')
  })
})

describe('connectivityEvents: shared fields and source discriminator', () => {
  it('defaults source to mdns (the only live discovery path today)', () => {
    const lines = []
    const { emit } = createConnectivityEmitter({ sink: (line) => lines.push(line) })
    emit(EVENTS.AUTH_OK, { peerId: 'peer-1' })
    const parsed = JSON.parse(lines[0])
    expect(parsed.source).toBe('mdns')
    expect(parsed.peerId).toBe('peer-1')
    expect(typeof parsed.ts).toBe('number')
    expect(parsed.event).toBe('AUTH_OK')
  })
})
