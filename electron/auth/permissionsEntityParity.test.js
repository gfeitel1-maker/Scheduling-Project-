import { describe, it, expect } from 'vitest'
import { ENTITIES } from './permissions.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from '../ops/campScopedEntities.js'
import { PARTICIPANT_ENTITIES } from '../ops/participantEntities.js'

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

  // T194 — the WHOLE participant domain, ADR docs/adr/2026-09-17-individual-
  // elective-scheduling.md D9 ("the export of this is what day-to-day staff
  // would see; camp admins are the people doing the behind-the-scenes work").
  //
  // Unlike camp_maps, these get NO explicit staff grant of any kind: staff hold
  // no read, no write, nothing. The distribution mechanism for staff is the
  // EXPORTED ARTIFACT — the activity roster and the child schedule a counsellor
  // holds — not a read grant on the entities.
  //
  // They are kept out of ENTITIES because permissions.js:74 derives
  // staffReadWrite by flatMapping every entry into BOTH `.read` and `.write`
  // with no per-entity opt-in. There is no partial registration.
  //
  // This test guards OMISSION and by construction cannot catch an OVER-GRANT,
  // so the negative assertions live in
  // electron/auth/participantEntitiesAdminOnly.test.js.
  campers: {
    reason:
      'ADR D9: the whole participant domain is admin-only. campers is PII (a child\'s name and group); staff consume the exported artifact, not the entity. No staff read and no staff write.',
  },
  elective_assignment_runs: {
    reason:
      'ADR D9: import, resolve, generate, override, finalize and export are all admin. A run is the director\'s workspace.',
  },
  elective_occurrences: {
    reason: 'ADR D9: admin-only, as part of the participant domain.',
  },
  elective_choices: {
    reason: 'ADR D9: admin-only, as part of the participant domain.',
  },
  elective_choice_offerings: {
    reason: 'ADR D9: admin-only, as part of the participant domain.',
  },
  elective_preferences: {
    reason:
      'ADR D9: admin-only, and PII-adjacent — a preference row plus a campers row is "this child wants this activity".',
  },
  elective_assignments: {
    reason:
      'ADR D9: admin-only, and PII-adjacent for the same reason as elective_preferences.',
  },
  elective_run_outer_snapshots: {
    reason:
      'T243 (docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md): admin-only, and ' +
      "PII-adjacent for the same reason as elective_assignments — it denormalizes a named child's " +
      'whole schedule.',
  },
}

// Round 2, M2. The dict above is per-entity PROSE, so it is written by hand on
// purpose — but its COMPLETENESS is derived, not trusted. An eighth participant
// entity with no documented reason here fails this rather than quietly
// inheriting a staff grant.
describe('every participant entity has a documented admin-only reason', () => {
  it('covers the registered participant domain', () => {
    for (const entity of PARTICIPANT_ENTITIES) {
      expect(
        PERMISSIONS_ADMIN_ONLY_EXCEPTIONS[entity]?.reason,
        `${entity} is a participant entity with no documented admin-only reason`
      ).toBeTruthy()
    }
  })
})

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
