import { describe, it, expect } from 'vitest'
import { findFreeSuffix, DEFAULT_SUFFIX_LIMIT } from './findFreeSuffix.js'

const format = (n) => `base:${n}`

describe('findFreeSuffix (T104 — the shared scan)', () => {
  it('returns the first free candidate', () => {
    const r = findFreeSuffix({ format, probe: (c) => (c === 'base:2' ? 'free' : 'taken') })
    expect(r).toEqual({ candidate: 'base:2', n: 2, reused: false })
  })

  it('skips taken candidates and keeps counting', () => {
    const taken = new Set(['base:2', 'base:3', 'base:4'])
    const r = findFreeSuffix({ format, probe: (c) => (taken.has(c) ? 'taken' : 'free') })
    expect(r.candidate).toBe('base:5')
    expect(r.n).toBe(5)
  })

  it('stops on a reusable candidate and flags it as a reuse, not a mint', () => {
    const r = findFreeSuffix({
      format,
      probe: (c) => (c === 'base:2' ? 'taken' : c === 'base:3' ? 'reuse' : 'free'),
    })
    expect(r).toEqual({ candidate: 'base:3', n: 3, reused: true })
  })

  it('honours a custom start', () => {
    const r = findFreeSuffix({ format, probe: () => 'free', start: 7 })
    expect(r.n).toBe(7)
  })

  it('is deterministic — same world, same answer, every time', () => {
    const taken = new Set(['base:2', 'base:3'])
    const probe = (c) => (taken.has(c) ? 'taken' : 'free')
    const runs = Array.from({ length: 5 }, () => findFreeSuffix({ format, probe }).candidate)
    expect(new Set(runs).size).toBe(1)
  })
})

// T103 — the real defect behind the ticket. The reported collision does not
// occur (measured; see the module header), but the scan was unbounded: a state
// that occupies every candidate span spins forever inside a synchronous write
// path. It must fail loudly instead of hanging, and must never return a
// degraded id that would then be written to the op log.
describe('findFreeSuffix bound (T103)', () => {
  it('throws rather than looping forever when everything is taken', () => {
    expect(() => findFreeSuffix({ format, probe: () => 'taken', limit: 50, label: 'location "Field"' }))
      .toThrow(/no free suffix for location "Field" after 50 attempts/)
  })

  it('names T103 in the error so the next reader finds the reasoning', () => {
    expect(() => findFreeSuffix({ format, probe: () => 'taken', limit: 3 })).toThrow(/T103/)
  })

  it('tries exactly `limit` candidates before giving up', () => {
    const seen = []
    expect(() => findFreeSuffix({
      format, limit: 4, probe: (c) => { seen.push(c); return 'taken' },
    })).toThrow()
    expect(seen).toEqual(['base:2', 'base:3', 'base:4', 'base:5'])
  })

  it('the default ceiling is far above any real camp', () => {
    expect(DEFAULT_SUFFIX_LIMIT).toBeGreaterThanOrEqual(1000)
  })

  it('does not throw when a free slot exists just inside the limit', () => {
    const r = findFreeSuffix({ format, limit: 3, probe: (c) => (c === 'base:4' ? 'free' : 'taken') })
    expect(r.candidate).toBe('base:4')
  })
})
