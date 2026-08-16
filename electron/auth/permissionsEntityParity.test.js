import { describe, it, expect } from 'vitest'
import { ENTITIES } from './permissions.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from '../ops/campScopedEntities.js'

// ---------------------------------------------------------------------------
// Drift guard: permissions.ENTITIES <-> the camp-scoped entity registries.
//
// permissions.ENTITIES is the list from which staffReadWrite (permissions.js)
// derives `<entity>.read`/`<entity>.write` for the staff role. authorize()
// (electron/auth/authorize.js) is default-deny by matrix lookup, so an entity
// that is registered as camp-scoped (in DIRECT_CAMP_ENTITIES or
// PARENT_SCOPED_ENTITIES) but MISSING from ENTITIES silently resolves to
// admin-only for staff — a staff user gets "forbidden" on its ordinary
// field writes with no error anywhere else in the stack.
//
// That is exactly how schedule_weeks / week_activity_exclusions /
// week_group_exclusions regressed: the multi-week slices (0cc0e97, 1f0bf97)
// added them to campScopedEntities.js and projections.js but never touched
// permissions.js, and no test connected the two registries. This is the
// missing sibling of the guarded pairs PROJECTIONS<->MOCK_WRITE_ALLOWLIST
// (ipcSurfaceParity.test.js) and PROJECTIONS<->BULK_REPLACE_ENTITIES
// (projectionsCoverage.test.js).
//
// Contract asserted here: permissions.ENTITIES == (DIRECT_CAMP_ENTITIES ∪
// keys(PARENT_SCOPED_ENTITIES)) minus PERMISSIONS_ADMIN_ONLY_EXCEPTIONS.
// ---------------------------------------------------------------------------

// Camp-scoped entities that are DELIBERATELY admin-only — i.e. registered as
// camp-scoped for sync/projection purposes but intentionally withheld from the
// staff read/write matrix. Every entry needs a written reason. This map is the
// escape hatch for a genuine future decision ("staff must never touch X"); it
// is NOT a place to silence this test for an accidental omission. If you are
// adding an entity here, an ADR should say why.
//
// main.js's "everything else -> '<entity>.write', staff+admin per the matrix"
// (electron/main.js, the generic write handler). Ordinary camp field writes
// are the shared staff+admin path; only delete/bulk_replace/rename/restore are
// admin-only, and those derive from admin:['*'] via action VERB, never by
// omitting an ENTITY here.
//
// camp_maps (M6, D6, docs/adr/2026-08-16-locations-optional-map.md) is the
// first genuine exception: staff need READ (Q7 — the map must be visible on
// staff tablets) but NOT write (replacing the whole camp's background image
// is a different blast radius than editing one place). ENTITIES derives
// read+write TOGETHER via staffReadWrite, so the only way to give staff read
// without write is to keep camp_maps out of ENTITIES entirely and grant
// 'camp_maps.read' explicitly in the staff array (permissions.js) — the same
// explicit-grant shape trash.read/conflicts.read already use.
const PERMISSIONS_ADMIN_ONLY_EXCEPTIONS = {
  camp_maps: {
    reason:
      'M6 D6: staff hold camp_maps.read explicitly (permissions.js) but never camp_maps.write — replacing the whole camp background image is admin-only, unlike locations.write (which staff keep, including map_geometry).',
  },
}

const registryUnion = [
  ...DIRECT_CAMP_ENTITIES,
  ...Object.keys(PARENT_SCOPED_ENTITIES),
]

describe('permissions.ENTITIES stays in sync with the camp-scoped entity registries', () => {
  it('lists every camp-scoped entity except the documented admin-only exceptions', () => {
    const entitySet = new Set(ENTITIES)
    const missing = registryUnion.filter(
      (entity) => !entitySet.has(entity) && !(entity in PERMISSIONS_ADMIN_ONLY_EXCEPTIONS),
    )
    expect(
      missing,
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} registered as camp-scoped ` +
        `(DIRECT_CAMP_ENTITIES / PARENT_SCOPED_ENTITIES in electron/ops/campScopedEntities.js) ` +
        `but MISSING from permissions.ENTITIES — so staff.read/staff.write on ${missing.length === 1 ? 'it' : 'them'} ` +
        `resolves to admin-only via authorize()'s default-deny. Add ${missing.length === 1 ? 'it' : 'them'} to ENTITIES ` +
        `in electron/auth/permissions.js, or add ${missing.length === 1 ? 'it' : 'them'} to ` +
        `PERMISSIONS_ADMIN_ONLY_EXCEPTIONS with a written reason if admin-only is intended.`,
    ).toEqual([])
  })

  it('does not list any entity that is not a registered camp-scoped entity', () => {
    const registrySet = new Set(registryUnion)
    const phantom = ENTITIES.filter((entity) => !registrySet.has(entity))
    expect(
      phantom,
      `${phantom.join(', ')} ${phantom.length === 1 ? 'is' : 'are'} in permissions.ENTITIES but ` +
        `not registered as camp-scoped in electron/ops/campScopedEntities.js. Either register ` +
        `${phantom.length === 1 ? 'it' : 'them'} there or remove ${phantom.length === 1 ? 'it' : 'them'} from ENTITIES.`,
    ).toEqual([])
  })

  it('has no duplicate entries in ENTITIES', () => {
    const dupes = ENTITIES.filter((entity, i) => ENTITIES.indexOf(entity) !== i)
    expect(dupes, `duplicate entries in permissions.ENTITIES: ${dupes.join(', ')}`).toEqual([])
  })

  describe('PERMISSIONS_ADMIN_ONLY_EXCEPTIONS is well-formed', () => {
    const exceptions = Object.entries(PERMISSIONS_ADMIN_ONLY_EXCEPTIONS)

    it('references only real camp-scoped entities (no stale exceptions)', () => {
      const registrySet = new Set(registryUnion)
      const stale = exceptions.map(([entity]) => entity).filter((entity) => !registrySet.has(entity))
      expect(stale, `stale admin-only exception(s) for non-existent camp entity: ${stale.join(', ')}`).toEqual([])
    })

    it('excepts only entities actually absent from ENTITIES (no dead exceptions)', () => {
      const entitySet = new Set(ENTITIES)
      const contradictory = exceptions.map(([entity]) => entity).filter((entity) => entitySet.has(entity))
      expect(
        contradictory,
        `admin-only exception(s) for entities that ARE in ENTITIES (so staff can already write them — ` +
          `the exception is a lie): ${contradictory.join(', ')}`,
      ).toEqual([])
    })

    it('gives every exception a non-empty written reason', () => {
      const unreasoned = exceptions
        .filter(([, meta]) => !meta || typeof meta.reason !== 'string' || meta.reason.trim() === '')
        .map(([entity]) => entity)
      expect(unreasoned, `admin-only exception(s) missing a written reason: ${unreasoned.join(', ')}`).toEqual([])
    })
  })
})
