import { describe, it, expect } from 'vitest'
import { PARTICIPANT_ENTITIES } from './participantEntities.js'
import { PROJECTIONS } from './projections.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from './campScopedEntities.js'
import { ENTITIES as PERMISSIONS_ENTITIES } from '../auth/permissions.js'

// ---------------------------------------------------------------------------
// Drift guard: every camp-scoped PROJECTIONS entity must also be registered
// in campScopedEntities.js AND permissions.js.
//
// This is the missing cross-check the Events overlay Slice 1 review found:
// `events` was registered in PROJECTIONS, UNIQUE_FIELD_ENTITIES, and the mock
// allowlist, but NOT in DIRECT_CAMP_ENTITIES nor permissions.ENTITIES — so
// `list(token, 'events')` threw "Unrecognized entity: events" and staff could
// not create/edit events at all, with nothing else in the stack catching it.
// electron/auth/permissionsEntityParity.test.js already guards
// campScopedEntities.js <-> permissions.js; this file adds the third leg,
// PROJECTIONS -> campScopedEntities.js, so a new entity registered for
// sync/write purposes but never wired into the read/authorize path fails
// loudly here instead of shipping silently broken.
// ---------------------------------------------------------------------------

// PROJECTIONS entities that are deliberately NOT camp-scoped (system tables,
// not gated by camp_id/parent-scope at all) — every entry needs a reason.
const NON_CAMP_SCOPED_PROJECTIONS = {
  camps: 'The camp row itself — not scoped BY a camp, it IS the camp.',
  users: 'Scoped by camp_id at the auth layer, not via DIRECT_CAMP_ENTITIES/PARENT_SCOPED_ENTITIES or the generic list() IPC path.',
  conflicts: 'Read via a dedicated listPendingConflicts IPC seam, not the generic camp-scoped list() path.',
}

const registryUnion = new Set([...DIRECT_CAMP_ENTITIES, ...Object.keys(PARENT_SCOPED_ENTITIES)])
const permissionsSet = new Set(PERMISSIONS_ENTITIES)

// Mirrors permissions.js's own documented admin-only exceptions.
//
// camp_maps: staff get read but not write, so it's deliberately absent from
// ENTITIES (which derives read and write together).
//
// The seven participant entities (T194, ADR docs/adr/2026-09-17-individual-
// elective-scheduling.md D9): staff get NOTHING — no read, no write. The whole
// domain is admin-only, and staff consume the exported artifact instead. Kept
// out of ENTITIES for the same structural reason: permissions.js flatMaps every
// entry into BOTH `.read` and `.write` with no per-entity opt-in.
//
// This list and the one in permissionsEntityParity.test.js guard OMISSION and
// cannot catch an over-grant; the negative assertions live in
// electron/auth/participantEntitiesAdminOnly.test.js.
const PERMISSIONS_ADMIN_ONLY_EXCEPTIONS = new Set([
  'camp_maps',
  // Round 2, M2: spread from the single definition rather than re-typed.
  ...PARTICIPANT_ENTITIES,
])

describe('PROJECTIONS entities are fully registered in the camp-scope and permissions registries', () => {
  const campScopedProjectionEntities = Object.keys(PROJECTIONS).filter((e) => !(e in NON_CAMP_SCOPED_PROJECTIONS))

  it('every camp-scoped PROJECTIONS entity is in DIRECT_CAMP_ENTITIES or PARENT_SCOPED_ENTITIES', () => {
    const missing = campScopedProjectionEntities.filter((e) => !registryUnion.has(e))
    expect(
      missing,
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} registered in PROJECTIONS but missing from ` +
        `DIRECT_CAMP_ENTITIES/PARENT_SCOPED_ENTITIES (electron/ops/campScopedEntities.js) — list(token, entity) will throw ` +
        `"Unrecognized entity" for ${missing.length === 1 ? 'it' : 'them'}. Register ${missing.length === 1 ? 'it' : 'them'} there, ` +
        `or add ${missing.length === 1 ? 'it' : 'them'} to NON_CAMP_SCOPED_PROJECTIONS with a reason if that's intentional.`
    ).toEqual([])
  })

  it('every camp-scoped PROJECTIONS entity is in permissions.ENTITIES (or a documented admin-only exception)', () => {
    const missing = campScopedProjectionEntities.filter(
      (e) => !permissionsSet.has(e) && !PERMISSIONS_ADMIN_ONLY_EXCEPTIONS.has(e)
    )
    expect(
      missing,
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} registered in PROJECTIONS but missing from ` +
        `permissions.ENTITIES (electron/auth/permissions.js) — authorize() default-denies staff on ` +
        `${missing.length === 1 ? 'it' : 'them'}. Register ${missing.length === 1 ? 'it' : 'them'} there.`
    ).toEqual([])
  })

  it('every NON_CAMP_SCOPED_PROJECTIONS entry still exists in PROJECTIONS and carries a reason', () => {
    for (const [entity, reason] of Object.entries(NON_CAMP_SCOPED_PROJECTIONS)) {
      expect(entity in PROJECTIONS, `NON_CAMP_SCOPED_PROJECTIONS['${entity}'] is not in PROJECTIONS — stale entry.`).toBe(true)
      expect(typeof reason === 'string' && reason.trim().length > 0, `NON_CAMP_SCOPED_PROJECTIONS['${entity}'] needs a written reason.`).toBe(true)
    }
  })
})
