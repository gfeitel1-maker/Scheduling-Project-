import { describe, it, expect } from 'vitest'
import { electiveChoiceLabelKey } from './electiveDerivedIds.js'
import { whitespaceInsensitiveName } from '../../src/ingest/preview.js'

// electiveChoiceLabelKey IS whitespaceInsensitiveName, wrapped under the name
// that says what the key is FOR. Round 1 kept a second copy of the rule under
// electron/ and justified it with a packaging claim that is false — src/ IS in
// electron-builder's `files` list, and electron/ops/ingest.js already imports
// from this very module in shipped code. The copy is gone; the import is the
// guarantee.
//
// This test is RETAINED rather than deleted, cheaply, for two reasons: it pins
// that the wrapper stays a pass-through (a future "small tweak" to the elective
// key would fork the repo-wide recognition rule silently), and its corpus is
// the documented label-shape corpus for this key.
//
// Precedent and form: src/engine/anchorActivityLink.keyParity.test.js.
describe('electiveChoiceLabelKey stays in step with the ingest recognition key', () => {
  const LABELS = [
    'Swim', 'swim', 'SWIM', '  Swim  ', 'Swim Advanced', 'SwimAdvanced',
    'Swim  Advanced', 'Swim\tAdvanced', 'Swim\nAdvanced', 'Arts & Crafts',
    'Tie-Dye', 'Free Play', 'Chug Aleph', 'chugaleph', '', '   ',
    'Café Art', 'Café Art', 'Еlective', 'Elective', 'Rock Climbing / Ropes',
    'Archery 2', 'Archery2', '1', 'a',
  ]

  it('agrees on every label shape a director or an import can produce', () => {
    for (const l of LABELS) {
      expect(electiveChoiceLabelKey(l), `disagreement on ${JSON.stringify(l)}`).toBe(
        whitespaceInsensitiveName(l)
      )
    }
  })

  it('agrees on the null and undefined shapes a DB row can carry', () => {
    expect(electiveChoiceLabelKey(null)).toBe(whitespaceInsensitiveName(null))
    expect(electiveChoiceLabelKey(undefined)).toBe(whitespaceInsensitiveName(undefined))
  })

  // Non-vacuity: a parity test whose corpus happens to be uniform passes for
  // two functions that disagree everywhere else. Prove the corpus discriminates.
  it('the corpus contains labels that map to DIFFERENT keys', () => {
    const keys = new Set(LABELS.map(electiveChoiceLabelKey))
    expect(keys.size).toBeGreaterThan(10)
  })
})
