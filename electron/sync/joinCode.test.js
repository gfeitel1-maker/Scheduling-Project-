// @vitest-environment node
//
// T286 (Slice A) rewrite: the code is no longer deterministic (mintJoinSecret
// draws from crypto.randomBytes), so the old fixed-vector tests
// ("produces its frozen value for a known input") no longer apply — pinning a
// fixed vector for a function that must never return the same thing twice
// would be pinning a bug. These are property tests instead: random/unique,
// round-trips through the scrypt tag, and the proof/normalize invariants
// carried over unchanged from the pre-T286 suite.
import crypto from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  mintJoinSecret,
  formatJoinCode,
  normalizeJoinCode,
  joinDiscoveryTag,
  joinProof,
  verifyJoinProof,
  newJoinNonce,
  JOIN_TAG_SCRYPT_PARAMS,
} from './joinCode.js'

describe('mintJoinSecret', () => {
  it('is 10 characters of Crockford base32', () => {
    for (let i = 0; i < 200; i++) {
      expect(mintJoinSecret()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/)
    }
  })

  // The alphabet's whole purpose. A code containing I, L, O or U cannot be
  // generated, so a reader who sees one of those has misread a 1 or a 0.
  it('never emits the ambiguous letters I, L, O or U', () => {
    for (let i = 0; i < 500; i++) {
      expect(mintJoinSecret()).not.toMatch(/[ILOU]/)
    }
  })

  // The whole point of T286: this must be random, not derived from anything.
  // 500 draws colliding would be astronomically unlikely (50 bits of entropy)
  // and would mean the RNG path was broken, not unlucky.
  it('is random and effectively unique across draws', () => {
    const seen = new Set()
    for (let i = 0; i < 500; i++) seen.add(mintJoinSecret())
    expect(seen.size).toBe(500)
  })

  it('is not deterministic — two mints never produce the same secret twice in a row', () => {
    // Not a hard guarantee (50 bits could theoretically repeat), but a repeat
    // in two draws would mean something is badly wrong (e.g. an unseeded or
    // reused source), which is exactly what this catches in CI over many runs.
    const a = mintJoinSecret()
    const b = mintJoinSecret()
    expect(a).not.toBe(b)
  })
})

describe('formatJoinCode', () => {
  it('groups a 10-char code 5-5 for display', () => {
    expect(formatJoinCode('K4P72MRQ7B')).toBe('K4P72-MRQ7B')
  })

  it('round-trips a freshly minted secret', () => {
    const secret = mintJoinSecret()
    const formatted = formatJoinCode(secret)
    expect(formatted).toBe(`${secret.slice(0, 5)}-${secret.slice(5)}`)
    expect(normalizeJoinCode(formatted)).toBe(secret)
  })

  it('returns null rather than a malformed display string', () => {
    expect(formatJoinCode('nope')).toBeNull()
    expect(formatJoinCode(undefined)).toBeNull()
  })
})

describe('normalizeJoinCode', () => {
  it('accepts the forms a director will actually type', () => {
    const canonical = 'K4P72MRQ7B'
    for (const typed of [
      'K4P72MRQ7B',
      'k4p72mrq7b',
      'K4P72-MRQ7B',
      'k4p72-mrq7b',
      ' K4P72 MRQ7B ',
    ]) {
      expect(normalizeJoinCode(typed)).toBe(canonical)
    }
  })

  it('corrects the substitutions a reader makes for 1 and 0', () => {
    expect(normalizeJoinCode('K4P72MRQIB')).toBe('K4P72MRQ1B')
    expect(normalizeJoinCode('k4p72mrqlb')).toBe('K4P72MRQ1B')
    expect(normalizeJoinCode('K4P72MRQOB')).toBe('K4P72MRQ0B')
  })

  it('rejects input that is not a code', () => {
    expect(normalizeJoinCode('K4P72MRQ7')).toBeNull() // too short (9)
    expect(normalizeJoinCode('K4P72MRQ7BB')).toBeNull() // too long (11)
    expect(normalizeJoinCode('K4P72MRQ7!')).toBeNull() // outside the alphabet
    expect(normalizeJoinCode('K4P72MRQ7U')).toBeNull() // U is not in the alphabet
    expect(normalizeJoinCode('')).toBeNull()
    expect(normalizeJoinCode(null)).toBeNull()
    expect(normalizeJoinCode(1234567890)).toBeNull()
  })
})

describe('joinDiscoveryTag', () => {
  it('is a single DNS label well inside the 63-character limit', () => {
    const tag = joinDiscoveryTag(mintJoinSecret())
    expect(tag.split('.')[0].length).toBeLessThan(63)
  })

  // The KDF round-trip: the same secret always yields the same tag, however
  // it was typed — otherwise a director's own device and the joiner's would
  // silently disagree.
  it('round-trips: the same secret always yields the same tag, in any form it was typed', () => {
    const secret = mintJoinSecret()
    const hostTag = joinDiscoveryTag(secret)
    for (const typed of [secret, secret.toLowerCase(), formatJoinCode(secret), ` ${secret} `]) {
      expect(joinDiscoveryTag(typed)).toBe(hostTag)
    }
  })

  it('is unique per secret (different secrets do not collide in practice)', () => {
    const tags = new Set()
    for (let i = 0; i < 50; i++) tags.add(joinDiscoveryTag(mintJoinSecret()))
    expect(tags.size).toBe(50)
  })

  it('does not leak the secret', () => {
    const secret = mintJoinSecret()
    expect(joinDiscoveryTag(secret)).not.toContain(secret)
  })

  it('refuses input that is not a code', () => {
    expect(() => joinDiscoveryTag('nope')).toThrow()
    expect(() => joinDiscoveryTag(null)).toThrow()
  })
})

// The offline-brute-force argument (2026-09-27 ADR §4 attack 1) only holds if
// the KDF's REAL cost is in the intended band — this is the "measured, not
// assumed" verification the ADR requires as part of this ticket's own
// done-definition. A regression that silently made scrypt cheap (a params
// typo, a Node/libuv change) would erode the whole margin without this test
// ever noticing via any other means.
describe('join-tag KDF cost — measured, not assumed', () => {
  it('costs a bounded, non-trivial amount of work per derivation (defends the offline-brute-force argument)', () => {
    // T339: a wall-clock floor (was >50ms) flaked on fast or loaded CI runners
    // (45-47ms measured). Assert the WORK FACTOR instead: time the real
    // derivation against a same-machine scrypt baseline at N=1024 (32x less
    // work at the same r/p), so runner speed and load cancel out. scrypt is
    // linear in N, so the real derivation must cost well over the baseline; a
    // params regression that made it cheap (N=1024, or a bare hash) collapses
    // the ratio to ~1 and fails. Median of several runs absorbs scheduler noise.
    const median = (fn, reps) => {
      const xs = []
      for (let i = 0; i < reps; i++) {
        const t0 = process.hrtime.bigint()
        fn()
        xs.push(Number(process.hrtime.bigint() - t0))
      }
      return xs.sort((x, y) => x - y)[Math.floor(reps / 2)]
    }
    const secret = mintJoinSecret()
    const baseline = median(() => crypto.scryptSync(secret, 'baseline', 32, { N: 1024, r: 8, p: 1 }), 15)
    const real = median(() => joinDiscoveryTag(secret), 5)
    expect(real / baseline).toBeGreaterThan(8)
  })

  it('the chosen parameters are recorded, not silently changeable', () => {
    expect(JOIN_TAG_SCRYPT_PARAMS).toEqual({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  })
})

describe('joinProof / verifyJoinProof', () => {
  it('verifies a genuine proof and separates the joiner/host roles', () => {
    const secret = mintJoinSecret()
    const nonce = newJoinNonce()
    const joinerProof = joinProof(secret, nonce, 'joiner')
    const hostProofValue = joinProof(secret, nonce, 'host')
    expect(joinerProof).not.toBe(hostProofValue)
    expect(verifyJoinProof(secret, nonce, 'joiner', joinerProof)).toBe(true)
    expect(verifyJoinProof(secret, nonce, 'host', hostProofValue)).toBe(true)
    // A proof for one role must never verify against the other — the
    // reflection attack the role labels exist to close.
    expect(verifyJoinProof(secret, nonce, 'joiner', hostProofValue)).toBe(false)
    expect(verifyJoinProof(secret, nonce, 'host', joinerProof)).toBe(false)
  })

  it('an expired/rotated secret no longer verifies', () => {
    const secretA = mintJoinSecret()
    const secretB = mintJoinSecret()
    const nonce = newJoinNonce()
    const proof = joinProof(secretA, nonce, 'joiner')
    // The window closed and a new one opened (or the same window minted a
    // fresh secret) — the old proof must not verify against the new secret.
    expect(verifyJoinProof(secretB, nonce, 'joiner', proof)).toBe(false)
  })

  it('newJoinNonce produces distinct 128-bit nonces', () => {
    const nonces = new Set()
    for (let i = 0; i < 100; i++) nonces.add(newJoinNonce())
    expect(nonces.size).toBe(100)
    expect(newJoinNonce()).toMatch(/^[0-9a-f]{32}$/)
  })
})
