import { describe, it, expect } from 'vitest'
import { electiveChoiceLabelKey } from './electiveDerivedIds.js'
import { whitespaceInsensitiveName } from '../../src/ingest/preview.js'

// electiveDerivedIds.js re-spells the ingest layer's `whitespaceInsensitiveName`
// rather than importing it, because that module must stay reachable from a
// PACKAGED build: electron-builder ships `electron/**` and `dist/**` but not
// `src/`, and the v66 migration loads it. An electron/ -> src/ import works in
// `npm run electron:dev` and fails in the installed app at migration time.
//
// That leaves a comment as the only thing holding the two spellings in
// agreement — and a comment cannot fail a build. This test can. It is
// deliberately the ONE place electron/ reaches into src/, and it does so in a
// test rather than in shipped code.
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
