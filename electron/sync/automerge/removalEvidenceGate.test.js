// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { mayReceiveRevocationEvidence } from './removalEvidence.js'

const dbWith = (rows) => ({ prepare: () => ({ get: (peerId) => rows.find((r) => r.peer_id === peerId) }) })

describe('who may receive revocation evidence', () => {
  it('a peer the roster binds to the claimed device id', () => {
    expect(mayReceiveRevocationEvidence(dbWith([{ peer_id: 'p1', device_id: 'd1' }]), 'p1', 'd1')).toBe(true)
  })
  it('never an unrostered stranger claiming a revoked device id', () => {
    expect(mayReceiveRevocationEvidence(dbWith([{ peer_id: 'p1', device_id: 'd1' }]), 'stranger', 'd1')).toBe(false)
  })
  it('never a rostered peer claiming a different device id', () => {
    expect(mayReceiveRevocationEvidence(dbWith([{ peer_id: 'p2', device_id: 'd2' }]), 'p2', 'd1')).toBe(false)
  })
})
