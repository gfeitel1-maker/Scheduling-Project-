// @vitest-environment node
//
// Parity guard: the renderer mock's UNIQUE_FIELD_ENTITIES (src/localClient.mock.js)
// must match the real registry (electron/ops/operations.js). If they drift, a
// concurrent same-name create is rejected with a structured {reason:'unique_field'}
// result in Electron but throws raw (or is silently accepted) in dev-mode/
// browser-mock — so the exact collision path (e.g. the two-rows split's minted
// "Swim (rec)") can't be reproduced or verified via `npm run dev`. This is the
// third registry Red Hat found unguarded when `activities` was registered
// (2026-08-23); this test closes the class the same way
// uniqueFirstFieldRegistryParity.test.js guards the operations↔setupCrud pair.
import { describe, it, expect } from 'vitest'
import { UNIQUE_FIELD_ENTITIES as REAL } from './ops/operations.js'
import { UNIQUE_FIELD_ENTITIES as MOCK } from '../src/localClient.mock.js'

describe('UNIQUE_FIELD_ENTITIES mock↔real parity', () => {
  it('every entity the mock lists is real and guards the same field (no mock-side drift)', () => {
    for (const entity of Object.keys(MOCK)) {
      expect(REAL[entity], `mock lists "${entity}" but the real registry does not`).toBeDefined()
      // real values are { table, field, scopeColumn }; the mock stores just the field string
      expect(MOCK[entity]).toBe(REAL[entity].field)
    }
  })

  it('activities is mirrored — dev-mode must reproduce its concurrent-create rejection (two-rows split)', () => {
    expect(MOCK.activities).toBe(REAL.activities.field)
  })

  // NOTE: full key-set equality is intentionally NOT asserted. elective_sets/
  // events are structured-rejected by the real registry but not yet mirrored in
  // the mock (their dev-mode create callers were built against raw-throw; see the
  // mock's own comment). That is pre-existing, caller-audit-gated drift, tracked
  // as known debt — this test guards against NEW mock-side drift, not that older
  // gap.
})
