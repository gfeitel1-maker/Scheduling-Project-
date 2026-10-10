// Audit E6 (2026-10-10) — "2 choices, 105 preferences" left the director to guess
// where the other ranked choices went. Count the ranked choices that named an
// activity this set does not offer.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { countRankedNotOffered } from './notOfferedChoices.js'
import { readPreferenceSheet, buildPreferenceCatalog } from '../../../ingest/preferenceImport.js'

describe('countRankedNotOffered', () => {
  it('counts preferences for camp activities outside this set, plus labels the camp does not have', () => {
    const parsed = {
      preferences: [
        { label: 'Archery', labelKey: 'archery', rank: 1 },
        { label: 'Swim', labelKey: 'swim', rank: 2 },
        { label: 'Drama', labelKey: 'drama', rank: 3 },
      ],
      residue: [
        { kind: 'UNRESOLVED_CHOICE_LABEL', label: 'Ceramics' },
        { kind: 'UNRESOLVED_CHOICE_LABEL', label: 'Woodworking' },
        { kind: 'UNMATCHED_DIVISION' },
      ],
    }
    expect(countRankedNotOffered(parsed, ['Archery', 'Drama'])).toBe(3)
  })

  it('matches offered names the way labels are keyed (case and spacing)', () => {
    const parsed = { preferences: [{ label: 'Arts and Crafts', labelKey: 'artsandcrafts', rank: 1 }], residue: [] }
    expect(countRankedNotOffered(parsed, ['arts  and crafts'])).toBe(0)
  })

  it('on the audit fixture against a 3-offering set: 1000 ranked cells, the rest not offered', () => {
    const file = path.resolve(__dirname, '../../../../docs/work/specs/samples/fabricated-camper-preferences-100.csv')
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => l.split(','))
    const offered = ['Drama', 'Archery', 'Art']
    const parsed = readPreferenceSheet({
      rows, campId: 'c1', catalog: buildPreferenceCatalog({ activities: offered.map((name) => ({ name })) }),
      sourceLabel: 'x', submissionKey: 'k', arrivalId: 'a',
    }).parsed
    const offeredPrefs = parsed.preferences.length
    expect(countRankedNotOffered(parsed, offered)).toBe(1000 - offeredPrefs)
  })

  it('is 0 for nothing', () => {
    expect(countRankedNotOffered(null, [])).toBe(0)
  })
})
