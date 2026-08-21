// T101 (docs/work/tickets/T101-locations-deterministic-id-rename-recollide.md):
// resolveLocationCandidateId is the single-sourced disambiguation used by
// every deterministic location-create site (ingest.js, ActivitiesScreen's
// T81 importer) so a rename-then-recollide never silently overwrites the
// renamed row. Pure — no db, just an in-memory {id,name} list — so both the
// db-backed and array-backed callers can wrap it identically.
import { describe, it, expect } from 'vitest'
import { deriveLocationId, resolveLocationCandidateId } from './locationId.js'

const campId = 'camp1'

describe('resolveLocationCandidateId', () => {
  it('no collision: returns the base id unchanged', () => {
    const result = resolveLocationCandidateId(campId, 'Pool', [])
    expect(result).toEqual({ id: deriveLocationId(campId, 'Pool'), isNew: true })
  })

  it('same-name collision: reuses the base id (normal resolve-by-name)', () => {
    const base = deriveLocationId(campId, 'Pool')
    const result = resolveLocationCandidateId(campId, 'Pool', [{ id: base, name: 'Pool' }])
    expect(result).toEqual({ id: base, isNew: false })
  })

  it('rename-recollide: base id holds a different name, mints :2', () => {
    const base = deriveLocationId(campId, 'Pool')
    const result = resolveLocationCandidateId(campId, 'Pool', [{ id: base, name: 'Swimming Pool' }])
    expect(result).toEqual({ id: `${base}:2`, isNew: true })
  })

  it('chained rename-recollide: :2 also renamed, mints :3', () => {
    const base = deriveLocationId(campId, 'Pool')
    const existing = [
      { id: base, name: 'Swimming Pool' },
      { id: `${base}:2`, name: 'Indoor Pool' },
    ]
    const result = resolveLocationCandidateId(campId, 'Pool', existing)
    expect(result).toEqual({ id: `${base}:3`, isNew: true })
  })

  it('reuses an existing disambiguated row when its name matches', () => {
    const base = deriveLocationId(campId, 'Pool')
    const existing = [
      { id: base, name: 'Swimming Pool' },
      { id: `${base}:2`, name: 'Pool' },
    ]
    const result = resolveLocationCandidateId(campId, 'Pool', existing)
    expect(result).toEqual({ id: `${base}:2`, isNew: false })
  })

  it('is case-sensitive, matching deriveLocationId\'s own contract', () => {
    const base = deriveLocationId(campId, 'Pool')
    const result = resolveLocationCandidateId(campId, 'pool', [{ id: base, name: 'Pool' }])
    // 'pool' derives its own distinct base id, unrelated to 'Pool'
    expect(result).toEqual({ id: deriveLocationId(campId, 'pool'), isNew: true })
  })

  it('two independent scans of the same state converge on the same id (cross-device)', () => {
    const base = deriveLocationId(campId, 'Pool')
    const existing = [{ id: base, name: 'Swimming Pool' }]
    const a = resolveLocationCandidateId(campId, 'Pool', existing)
    const b = resolveLocationCandidateId(campId, 'Pool', existing.slice())
    expect(a).toEqual(b)
  })
})
