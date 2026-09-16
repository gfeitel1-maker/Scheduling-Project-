import { describe, it, expect } from 'vitest'
import { anchorNameKey } from './anchorActivityLink.js'
import { whitespaceInsensitiveName } from '../ingest/preview.js'

// anchorActivityLink.js re-spells the ingest layer's recognition key rather
// than importing it, so the engine keeps its no-dependencies purity and the
// ingest layer stays downstream of it. That leaves a comment as the only thing
// holding the two in agreement — and a comment cannot fail a build.
//
// This test can. It is deliberately the ONE place the engine reaches into
// src/ingest/, and it does so in a test rather than in engine code. If the
// recognition key changes on either side, this goes red and names the seam.
//
// Suggested by the session working the ingest path, reviewing this change.
describe('anchor name key stays in step with the ingest recognition key', () => {
  const NAMES = [
    'Lunch', 'lunch', 'LUNCH', '  Lunch  ', 'Lunch + Leave',
    'Rest Hour', 'RestHour', 'rest  hour', 'Mifkad', 'Swim',
    'Arts & Crafts', 'Tie-Dye', 'Free Play', '', '   ',
    'Lunch\t1', 'Lunch\n2', 'Chug Aleph', 'chugaleph',
  ]

  it('agrees with whitespaceInsensitiveName on every name shape the importer produces', () => {
    for (const n of NAMES) {
      expect(anchorNameKey(n), `disagreement on ${JSON.stringify(n)}`)
        .toBe(whitespaceInsensitiveName(n))
    }
  })

  it('agrees on the null/undefined shapes a DB row can carry', () => {
    expect(anchorNameKey(null)).toBe(whitespaceInsensitiveName(null))
    expect(anchorNameKey(undefined)).toBe(whitespaceInsensitiveName(undefined))
  })
})
