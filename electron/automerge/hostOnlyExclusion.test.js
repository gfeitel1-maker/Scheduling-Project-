// @vitest-environment node
//
// Stage 3 (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md): the
// host-only-table exclusion as a STRUCTURAL guarantee. Under the op-log these
// tables were kept out of sync by allowlist-by-omission (campScopedEntities.js
// never lists them). Under Automerge the equivalent — and stronger — guarantee
// is that they are NEVER modeled as document fields at all, so they cannot leak
// reconciliation-provenance or the host signing key into shared CRDT history,
// where there'd be no full-sync payload to grep for them after the fact.
//
// This is a security invariant. If a future widening of MODELED_ENTITIES ever
// pulls one of these tables into the document, this test fails loudly.
import { describe, it, expect } from 'vitest'
import {
  MODELED_ENTITIES,
  DEFERRED_ENTITIES,
  createEmptyDoc,
  applyWrite,
} from './campDocument.js'
import { projectEntity } from './projector.js'
import { seedDocFromSqlite } from './seed.js'
import { DIRECT_CAMP_ENTITIES } from '../ops/campScopedEntities.js'

// The host-only tables (schema.sql: "Host-only table ... NEVER included in any
// full-sync SELECT/payload"). Reconciliation provenance + the Ed25519 signing
// key. None of these may ever become an Automerge document field.
const HOST_ONLY_TABLES = [
  'host_signing_key',
  'source_aliases',
  'compound_cell_decisions',
  'location_word_decisions',
  'declined_two_row_splits',
  'import_evidence',
]

// Infrastructure / never-replicated-as-document tables. `devices` is the
// special case (never replicated but stub-seeded on receipt, per
// docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md) — it still
// must not be a shared document field. camps/users/operations/conflicts are
// device-local infrastructure, not camp domain data.
const NON_DOCUMENT_TABLES = ['devices', 'camps', 'users', 'operations', 'conflicts']

describe('host-only + infrastructure tables are structurally excluded from the Automerge document', () => {
  const excluded = [...HOST_ONLY_TABLES, ...NON_DOCUMENT_TABLES]

  it('none of them are in MODELED_ENTITIES', () => {
    for (const t of excluded) expect(MODELED_ENTITIES.has(t)).toBe(false)
  })

  it('none of them are a top-level collection in a fresh document', () => {
    const doc = createEmptyDoc()
    for (const t of excluded) expect(doc[t]).toBeUndefined()
  })

  it('applyWrite refuses every host-only table (loud throw, not silent no-op)', () => {
    const doc = createEmptyDoc()
    for (const t of HOST_ONLY_TABLES) {
      expect(() => applyWrite(doc, { entity: t, entity_id: 'x', field: 'anything', value: 'v' })).toThrow()
    }
  })

  it('projectEntity refuses every host-only table', () => {
    const doc = createEmptyDoc()
    // assertModeled runs before any db access, so a null db never gets touched.
    for (const t of HOST_ONLY_TABLES) {
      expect(() => projectEntity(null, doc, t)).toThrow()
    }
  })

  it('seedDocFromSqlite refuses every host-only table', () => {
    const doc = createEmptyDoc()
    for (const t of HOST_ONLY_TABLES) {
      expect(() => seedDocFromSqlite(null, doc, t)).toThrow()
    }
  })

  it('host-only tables are not silently hiding in DIRECT_CAMP_ENTITIES either (defense in depth)', () => {
    // The modeled set is derived from DIRECT_CAMP_ENTITIES; prove the registry
    // it derives from never listed a host-only table in the first place.
    for (const t of HOST_ONLY_TABLES) expect(DIRECT_CAMP_ENTITIES.has(t)).toBe(false)
  })

  it('DEFERRED_ENTITIES is empty (day_overrides was un-deferred; a modeling gap, NOT a host-only exclusion, would be the only legitimate reason to add one back)', () => {
    // Guards against someone "deferring" a host-only table through the wrong
    // mechanism — deferral is for modelable-but-not-yet entities only.
    expect([...DEFERRED_ENTITIES]).toEqual([])
    for (const t of excluded) expect(DEFERRED_ENTITIES.has(t)).toBe(false)
  })
})
