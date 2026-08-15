// T9 (docs/adr/2026-08-15-locations-concurrent-create-collision.md addendum,
// Decision B): UNIQUE_FIRST_FIELD (src/data/setupCrudRepository.js) is a
// hand-maintained, independent transcription of UNIQUE_FIELD_ENTITIES
// (electron/ops/operations.js) — src/ must never import electron/ (that
// module pulls in better-sqlite3/node:crypto and cannot cross into the
// renderer bundle), so nothing else keeps the two in sync.
//
// Lives in electron/ (never bundled) because it is the one place allowed to
// read both src/ and electron/, same reasoning as electron/ipcSurfaceParity.test.js
// and restore.js's own RESTORE_DECISIONS-must-cover-every-PROJECTIONS-key
// guard.
//
// ANTI-VACUITY: a parity check's worst failure mode is silently passing on
// two empty registries. The floor assertion below makes that loud.
import { describe, it, expect } from 'vitest'
import { UNIQUE_FIELD_ENTITIES } from './ops/operations.js'
import { UNIQUE_FIRST_FIELD } from '../src/data/setupCrudRepository.js'

describe('UNIQUE_FIRST_FIELD / UNIQUE_FIELD_ENTITIES registry parity', () => {
  it('floor: at least one entity is registered on the Electron side (anti-vacuity)', () => {
    expect(Object.keys(UNIQUE_FIELD_ENTITIES).length).toBeGreaterThan(0)
  })

  it('every UNIQUE_FIELD_ENTITIES entity has a matching UNIQUE_FIRST_FIELD entry naming the SAME field', () => {
    for (const [entity, config] of Object.entries(UNIQUE_FIELD_ENTITIES)) {
      expect(UNIQUE_FIRST_FIELD[entity]).toBe(config.field)
    }
  })

  it('UNIQUE_FIRST_FIELD has no entity absent from UNIQUE_FIELD_ENTITIES (no stale/orphaned entry)', () => {
    for (const entity of Object.keys(UNIQUE_FIRST_FIELD)) {
      expect(UNIQUE_FIELD_ENTITIES[entity]).toBeTruthy()
    }
  })
})
