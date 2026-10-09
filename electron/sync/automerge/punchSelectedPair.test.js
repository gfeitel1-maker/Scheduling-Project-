// @vitest-environment node
//
// T348: what a punched session remembers is the ICE-SELECTED pair only - never every candidate that
// was signaled - and our own reflexive address is read from the selected local candidate.
import { describe, it, expect } from 'vitest'
import { createPunchSessionForTest } from './punchTransport.js'

const ANSWER = ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=ice-ufrag:abcd', 'a=ice-pwd:' + 'p'.repeat(22), 'a=fingerprint:sha-256 AA:BB', 'a=mid:0', ''].join('\r\n')

function fakeNdc(pair) {
  class PeerConnection {
    onLocalDescription() {}
    onLocalCandidate() {}
    onStateChange() {}
    onDataChannel() {}
    createDataChannel() { return { onOpen() {}, onClosed() {}, close() {} } }
    setLocalDescription() {}
    setRemoteDescription() {}
    addRemoteCandidate() {}
    getSelectedCandidatePair() { return pair }
    close() {}
  }
  return { PeerConnection }
}

const cand = (addr, port, type) => `candidate:1 1 UDP 2122252543 ${addr} ${port} typ ${type}`

function offererWith(pair) {
  const s = createPunchSessionForTest({ ndc: fakeNdc(pair), role: 'offerer', sid: 'a'.repeat(32), sendSignal: () => {} })
  s.startOffer()
  s.acceptAnswer(ANSWER)
  s.addCandidate(cand('192.168.1.5', 5000, 'host'), '0')
  s.addCandidate(cand('203.0.113.7', 6000, 'srflx'), '0')
  s.addCandidate(cand('198.51.100.9', 7000, 'srflx'), '0')
  return s
}

describe('memorySnapshot - selected pair only', () => {
  const pair = {
    local: { address: '203.0.113.1', port: 4000, type: 'srflx', candidate: cand('203.0.113.1', 4000, 'srflx') + ' raddr 10.0.0.2 rport 4000', mid: '0' },
    remote: { address: '203.0.113.7', port: 6000, type: 'srflx', candidate: cand('203.0.113.7', 6000, 'srflx'), mid: '0' },
  }

  it('keeps only the remote candidate ICE selected, not every signaled one', () => {
    const snap = offererWith(pair).memorySnapshot()
    expect(snap.candidates).toEqual([{ candidate: cand('203.0.113.7', 6000, 'srflx'), mid: '0' }])
  })

  it('reports our own srflx from the selected LOCAL candidate only', () => {
    expect(offererWith(pair).memorySnapshot().localCandidates).toEqual([pair.local.candidate])
  })

  it('a selected local host candidate yields no own-reflexive candidate', () => {
    const hostLocal = { ...pair, local: { ...pair.local, type: 'host', candidate: cand('10.0.0.2', 4000, 'host') } }
    expect(offererWith(hostLocal).memorySnapshot().localCandidates).toEqual([])
  })

  it('no selected pair means nothing is remembered', () => {
    expect(offererWith(null).memorySnapshot()).toBeNull()
  })
})
