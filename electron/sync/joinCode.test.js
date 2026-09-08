// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  joinCode,
  formatJoinCode,
  normalizeJoinCode,
  joinDiscoveryTag,
  joinDiscoveryTagForCamp,
} from './joinCode.js'
import { campIdHash } from './campIdHash.js'

describe('joinCode', () => {
  // Wire-compatibility tripwire, the same kind campIdHash.test.js carries and
  // for the same reason: a Host advertising a tag derived one way and a Client
  // searching for a tag derived another way fail SILENTLY — the director just
  // sees "no camps found" and is told their correctly-typed code is wrong.
  // These vectors are frozen. If one fails, the change under review breaks
  // joining against every already-installed copy of the app, and updating the
  // expectation hides that rather than fixing it.
  it('produces its frozen value for a known input', () => {
    expect(joinCode('shoresh-fixed-test-vector')).toBe('GGGH4XX6')
    expect(joinCode('camp-1')).toBe('H7KB9WCE')
  })

  it('produces its frozen discovery tag for a known input', () => {
    expect(joinDiscoveryTagForCamp('camp-1')).toBe('_shoresh-join-3d15b9f7e241bc22._udp.local')
  })

  it('is deterministic', () => {
    expect(joinCode('camp-1')).toBe(joinCode('camp-1'))
  })

  it('separates camps', () => {
    expect(joinCode('camp-1')).not.toBe(joinCode('camp-2'))
    expect(joinDiscoveryTagForCamp('camp-1')).not.toBe(joinDiscoveryTagForCamp('camp-2'))
  })

  it('is 8 characters of Crockford base32', () => {
    expect(joinCode('camp-1')).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/)
  })

  // The alphabet's whole purpose. A code containing I, L, O or U cannot be
  // generated, so a reader who sees one of those has misread a 1 or a 0 — which
  // normalizeJoinCode then corrects rather than rejecting.
  it('never emits the ambiguous letters I, L, O or U', () => {
    for (let i = 0; i < 500; i++) {
      expect(joinCode(`camp-${i}`)).not.toMatch(/[ILOU]/)
    }
  })

  it('does not leak the input', () => {
    expect(joinCode('camp-ohalo-2026')).not.toContain('OHALO')
  })

  // The camp id must not be recoverable from what goes on the LAN, and the two
  // LAN identifiers must not be the same string — a device searching the join
  // tag must not match a Host's ordinary camp tag or vice versa.
  it('is unrelated to the camp tag campIdHash produces', () => {
    expect(joinDiscoveryTagForCamp('camp-1')).not.toContain(campIdHash('camp-1'))
    expect(joinCode('camp-1').toLowerCase()).not.toBe(campIdHash('camp-1').slice(0, 8))
  })

  it('refuses a missing or non-string camp id', () => {
    expect(() => joinCode('')).toThrow()
    expect(() => joinCode(undefined)).toThrow()
    expect(() => joinCode(null)).toThrow()
    expect(() => joinCode(123)).toThrow()
  })
})

describe('formatJoinCode', () => {
  it('groups the code for display', () => {
    expect(formatJoinCode('H7KB9WCE')).toBe('H7KB-9WCE')
    expect(formatJoinCode(joinCode('camp-1'))).toBe('H7KB-9WCE')
  })

  it('returns null rather than a malformed display string', () => {
    expect(formatJoinCode('nope')).toBeNull()
    expect(formatJoinCode(undefined)).toBeNull()
  })
})

describe('normalizeJoinCode', () => {
  // Forgiving in exactly the ways a person copying eight characters off a
  // screen is wrong.
  it('accepts the forms a director will actually type', () => {
    const canonical = 'H7KB9WCE'
    for (const typed of [
      'H7KB9WCE',
      'h7kb9wce',
      'H7KB-9WCE',
      'h7kb-9wce',
      ' H7KB 9WCE ',
      'H7KB — 9WCE'.replace('—', '-'),
    ]) {
      expect(normalizeJoinCode(typed)).toBe(canonical)
    }
  })

  it('corrects the substitutions a reader makes for 1 and 0', () => {
    // 'I', 'l' and 'O' cannot appear in a real code, so seeing one means the
    // reader mistook a 1 or a 0. Telling them their code is wrong would be the
    // app's fault, not theirs.
    expect(normalizeJoinCode('H7KBIWCE')).toBe('H7KB1WCE')
    expect(normalizeJoinCode('h7kblwce')).toBe('H7KB1WCE')
    expect(normalizeJoinCode('H7KBOWCE')).toBe('H7KB0WCE')
  })

  // The other half of that bargain: a genuine typo must be reported as a typo.
  // Deriving a tag from nonsense would surface to the director as "no camps
  // found" — sending them to check their Wi-Fi over a mistyped character.
  it('rejects input that is not a code', () => {
    expect(normalizeJoinCode('H7KB9WC')).toBeNull() // too short
    expect(normalizeJoinCode('H7KB9WCEE')).toBeNull() // too long
    expect(normalizeJoinCode('H7KB9WC!')).toBeNull() // outside the alphabet
    expect(normalizeJoinCode('H7KB9WCU')).toBeNull() // U is not in the alphabet
    expect(normalizeJoinCode('')).toBeNull()
    expect(normalizeJoinCode(null)).toBeNull()
    expect(normalizeJoinCode(12345678)).toBeNull()
  })
})

describe('joinDiscoveryTag', () => {
  it('is a single DNS label well inside the 63-character limit', () => {
    const tag = joinDiscoveryTagForCamp('camp-1')
    expect(tag.split('.')[0].length).toBeLessThan(63)
  })

  // The Host derives its tag from a campId and the Client derives its tag from
  // a typed string. If those two ever disagree, joining silently never works —
  // which is why joinDiscoveryTagForCamp routes through joinCode rather than
  // hashing the campId itself.
  it('agrees whichever side derives it, in any form the code was typed', () => {
    const hostTag = joinDiscoveryTagForCamp('camp-1')
    for (const typed of ['H7KB9WCE', 'h7kb-9wce', ' H7KB 9WCE ', 'h7kbgwce'.replace('g', '9')]) {
      expect(joinDiscoveryTag(typed)).toBe(hostTag)
    }
  })

  it('refuses input that is not a code', () => {
    expect(() => joinDiscoveryTag('nope')).toThrow()
    expect(() => joinDiscoveryTag(null)).toThrow()
  })
})
