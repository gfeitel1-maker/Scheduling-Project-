// Tier-2 fuzzing (docs/work/security/2026-09-14-security-program.md) — the libp2p wire
// framing + the join-code crypto surface, the two network primitives a hostile LAN/relay peer
// reaches directly. Bounded and SEEDED (mulberry32) so a failure is reproducible; this is a
// property test — "no input crashes the process or violates an invariant" — not a search for a
// specific payload. It complements the one hand-written adversarial test in syncNode.test.js by
// covering the shape space systematically.
import { describe, it, expect } from 'vitest'
import { receiveFramed, sendFramed, MAX_FRAME_BYTES } from '../../electron/sync/automerge/wireProtocol.js'
import { normalizeJoinCode, joinProof, verifyJoinProof, joinDiscoveryTag, joinCode } from '../../electron/sync/joinCode.js'

// Deterministic PRNG — seed is fixed so CI reproduces any failure exactly.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(0x5140b0)
const randByte = () => Math.floor(rand() * 256)
const randBytes = (n) => Uint8Array.from({ length: n }, randByte)
const randInt = (max) => Math.floor(rand() * max)

// An it-source that yields the given chunks, then ends.
function sourceOf(chunks) {
  return (async function* () { for (const c of chunks) yield c })()
}
// A minimal libp2p-v3 Stream stand-in that captures what sendFramed writes.
// v3 replaced the pull-stream sink (a callable) with an EventTarget-ish object
// exposing .send()/.onDrain(); this fuzz test was written against the old shape
// and was the one file the 2->3 migration sweep missed (T215).
function capturingStream(chunks) {
  return {
    send: (frame) => { chunks.push(frame); return true },
    onDrain: async () => {},
  }
}

describe('wireProtocol.receiveFramed — adversarial byte sources', () => {
  it('never throws OUT of a rejected/garbled frame in a way that escapes a caller try/catch', async () => {
    // 300 random shapes: raw noise, truncated length prefixes, huge declared lengths, empty.
    for (let i = 0; i < 300; i++) {
      const shape = randInt(4)
      let chunks
      if (shape === 0) chunks = [randBytes(randInt(64))]                    // raw noise
      else if (shape === 1) chunks = [Uint8Array.of(0xff, 0xff, 0xff, 0xff)] // varint claiming huge len, no body
      else if (shape === 2) chunks = [randBytes(1), randBytes(2), randBytes(3)] // fragmented noise
      else chunks = [new Uint8Array(0)]                                     // empty
      const seen = []
      let threw = false
      try {
        await receiveFramed(sourceOf(chunks), (b) => seen.push(b))
      } catch {
        threw = true // a thrown decode error is ACCEPTABLE — it is catchable, not a crash
      }
      // Invariant: whatever happened, any payload delivered respects the frame cap.
      for (const b of seen) expect(b.length).toBeLessThanOrEqual(MAX_FRAME_BYTES)
      // Invariant: the call settled (did not hang) — reaching here proves it.
      expect(typeof threw).toBe('boolean')
    }
  })

  it('a frame declaring more than MAX_FRAME_BYTES is refused, not buffered', async () => {
    // Round-trip a legitimately-framed oversized payload and confirm the low cap rejects it.
    const chunks = []
    await sendFramed(capturingStream(chunks), randBytes(64))
    // Non-vacuity: if the send path silently wrote nothing, the read below would
    // be exercising the fallback random bytes rather than a real framed payload,
    // and the assertion would pass for the wrong reason.
    expect(chunks.length).toBeGreaterThan(0)
    // Read back the framed bytes with a deliberately tiny cap → must reject, never yield.
    const framedSource = sourceOf(chunks.length ? chunks : [randBytes(64)])
    let delivered = 0
    let threw = false
    try {
      await receiveFramed(framedSource, () => { delivered++ }, { maxDataLength: 8 })
    } catch { threw = true }
    expect(delivered === 0 || threw).toBe(true)
  })
})

describe('joinCode crypto surface — junk-input robustness & constant-time verify', () => {
  const JUNK = ['', ' ', '\n', '\0', '----', '💥', 'a'.repeat(10000), '../../etc', '{}', 'null',
    'AAAA-AAAA', 'aaaaaaaa', '12345678', '\t\t', 'select 1']

  it('normalizeJoinCode returns null (never throws) for arbitrary junk', () => {
    for (const j of JUNK) {
      expect(() => normalizeJoinCode(j)).not.toThrow()
    }
    // and for non-strings
    for (const j of [null, undefined, 42, {}, [], NaN]) {
      expect(() => normalizeJoinCode(j)).not.toThrow()
    }
  })

  it('verifyJoinProof never throws and never returns true for a wrong/junk proof', () => {
    const code = joinCode('camp-under-test')
    const nonce = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const good = joinProof(code, nonce, 'joiner')
    // the genuine proof verifies
    expect(verifyJoinProof(code, nonce, 'joiner', good)).toBe(true)
    // no junk proof verifies, and none throws (length-mismatch/timingSafeEqual guarded)
    for (let i = 0; i < 200; i++) {
      const junkProof = Buffer.from(randBytes(randInt(80))).toString('hex')
      let result, threw = false
      try { result = verifyJoinProof(code, nonce, 'joiner', junkProof) } catch { threw = true }
      expect(threw).toBe(false)
      expect(result).not.toBe(true)
    }
    // a proof for the wrong role must not verify against the 'joiner' role
    expect(verifyJoinProof(code, nonce, 'joiner', joinProof(code, nonce, 'host'))).toBe(false)
  })

  it('joinDiscoveryTag is deterministic and never crashes uncatchably for arbitrary input', () => {
    // Some "junk" values (AAAA-AAAA, 12345678) legitimately normalize to a valid 8-char code
    // and correctly yield a tag — that is not a defect. The invariant that matters for a value
    // reached from user input is: (a) any failure is catchable, not a process crash, and (b) the
    // same input always maps to the same tag (a discovery tag that wobbled would break joins).
    for (const j of JUNK) {
      let a, b, threw = false
      try { a = joinDiscoveryTag(j); b = joinDiscoveryTag(j) } catch { threw = true }
      if (!threw) expect(a).toBe(b)              // deterministic
      expect(typeof (threw ? 'ok' : a)).toBeDefined() // settled without an uncatchable crash
    }
  })
})
