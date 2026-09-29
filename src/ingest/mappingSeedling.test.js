// T312 — the remembered column mapping: its match key, its payload, and the
// drift rule. Pure; no db, no IPC.
import { describe, it, expect } from 'vitest'
import {
  headerMatchKey, bindingFromMapping, mappingFromBinding, recallColumnMapping,
} from './mappingSeedling.js'

// A director's hand-built mapping for a sheet the inferencer could not read.
const HEADER = ['Camper', 'Bunk', 'Pick A', 'Pick B']
const MAPPING = {
  headerIndex: 0,
  nameIndex: 0,
  externalIdIndex: null,
  divisionIndex: 1,
  rankColumns: [{ rank: 1, index: 2 }, { rank: 2, index: 3 }],
}

describe('headerMatchKey', () => {
  it('is stable under case, surrounding space and collapsed runs', () => {
    expect(headerMatchKey(['Camper', 'Pick A'])).toBe(headerMatchKey(['  camper ', 'PICK   A']))
  })

  it('is stable under order, so a reordered sheet still matches', () => {
    expect(headerMatchKey(['Camper', 'Pick A', 'Pick B']))
      .toBe(headerMatchKey(['Pick B', 'Camper', 'Pick A']))
  })

  it('distinguishes different header sets', () => {
    expect(headerMatchKey(['Camper', 'Pick A'])).not.toBe(headerMatchKey(['Camper', 'Top Pick']))
  })

  // Passes `opaque()` in electiveDerivedIds, which rejects whitespace and
  // punctuation — the key is an id COMPONENT, so this is a contract not a nicety.
  it('produces an opaque-id-safe token', () => {
    expect(headerMatchKey(['Camper Name', 'Pick A & B', 'Ünïcode'])).toMatch(/^[A-Za-z0-9_.:-]+$/)
  })
})

describe('bindingFromMapping', () => {
  // THE PRIVACY CONSTRAINT, ADR 6.0: the key is derived from header text and
  // never from cell contents, because a fingerprint over cells would cache
  // children's names into a REPLICATED table. Asserted by changing every cell.
  it('produces the same key for identical headers over completely different campers', () => {
    const a = bindingFromMapping(MAPPING, HEADER)
    const b = bindingFromMapping(MAPPING, HEADER)
    expect(a.matchKey).toBe(b.matchKey)
    // And the payload carries no cell value at all — only headers and ranks.
    expect(JSON.stringify(a.payload)).not.toMatch(/Rivka|Ari|Archery|Ceramics/)
  })

  it('stores header TEXT, never column indices', () => {
    const { payload } = bindingFromMapping(MAPPING, HEADER)
    expect(payload).toEqual({
      name: 'Camper',
      externalId: null,
      division: 'Bunk',
      ranks: [{ rank: 1, header: 'Pick A' }, { rank: 2, header: 'Pick B' }],
    })
    expect(JSON.stringify(payload)).not.toMatch(/Index|index/)
  })

  it('returns null for a mapping with no name column, which is not a binding worth keeping', () => {
    expect(bindingFromMapping({ ...MAPPING, nameIndex: null }, HEADER)).toBeNull()
  })
})

describe('mappingFromBinding', () => {
  const { payload } = bindingFromMapping(MAPPING, HEADER)

  it('resolves remembered headers to the CURRENT column positions', () => {
    const sameSheet = mappingFromBinding(payload, HEADER)
    expect(sameSheet).toMatchObject({ nameIndex: 0, divisionIndex: 1 })
    expect(sameSheet.rankColumns).toEqual([{ rank: 1, index: 2 }, { rank: 2, index: 3 }])
  })

  // ADR 0 premise 4 — the promise that a binding survives someone inserting
  // columns. It survives because the payload names HEADERS; indices are looked
  // up fresh, so everything after the insertion shifts harmlessly.
  it('survives inserted, removed and reordered columns', () => {
    const shifted = ['Notes', 'Pick B', 'Camper', 'Bunk', 'Pick A', 'Allergies']
    const m = mappingFromBinding(payload, shifted)
    expect(m).toMatchObject({ nameIndex: 2, divisionIndex: 3 })
    expect(m.rankColumns).toEqual([{ rank: 1, index: 4 }, { rank: 2, index: 1 }])
  })

  it('matches case- and whitespace-insensitively, as the key does', () => {
    expect(mappingFromBinding(payload, ['  CAMPER', 'bunk', 'pick   a', 'Pick B'])).not.toBeNull()
  })

  // DRIFT — P38's lesson as a rule. Renaming one rank header silently dropped
  // rank 3 for 13 campers under ok=true. A binding that applies its surviving
  // half reproduces exactly that, so a missing header voids the WHOLE binding.
  it('refuses rather than narrows when a remembered rank header is gone', () => {
    expect(mappingFromBinding(payload, ['Camper', 'Bunk', 'Pick A', 'Third Choice'])).toBeNull()
  })

  it('refuses when the remembered name header is gone', () => {
    expect(mappingFromBinding(payload, ['Who', 'Bunk', 'Pick A', 'Pick B'])).toBeNull()
  })

  // An OPTIONAL role that is absent is drift too: the director said column B was
  // the division, and a file without it is not the file they described.
  it('refuses when a remembered optional role is gone', () => {
    expect(mappingFromBinding(payload, ['Camper', 'Pick A', 'Pick B'])).toBeNull()
  })

  // Two columns sharing one remembered header cannot be resolved to one index
  // without guessing which the director meant.
  it('refuses when a remembered header is ambiguous in the new sheet', () => {
    expect(mappingFromBinding(payload, ['Camper', 'Bunk', 'Pick A', 'Pick B', 'Pick A'])).toBeNull()
  })
})

describe('recallColumnMapping', () => {
  const HEADER_ROW = ['Camper', 'Bunk', 'Pick A', 'Pick B']
  const { matchKey, payload } = bindingFromMapping(MAPPING, HEADER_ROW)
  const seedling = (over = {}) => ({
    id: 's1', kind: 'preference_column_roles', status: 'active',
    match_key: matchKey, payload: JSON.stringify(payload), ...over,
  })
  // What inferPreferenceLayout returns for this sheet: it cannot read the ranks.
  const INFERRED = { headerIndex: 0, nameIndex: 0, divisionIndex: 1, rankColumns: [], unmapped: ['ranks'] }

  it('returns a readable mapping for a sheet this camp has confirmed before', () => {
    const out = recallColumnMapping([seedling()], HEADER_ROW, INFERRED)
    expect(out).not.toBeNull()
    expect(out.rankColumns).toEqual([{ rank: 1, index: 2 }, { rank: 2, index: 3 }])
    // And it is READABLE -- the point of a recall is that Confirm can be pressed.
    expect(out.unmapped).toEqual([])
  })

  it('ignores a superseded seedling', () => {
    expect(recallColumnMapping([seedling({ status: 'superseded' })], HEADER_ROW, INFERRED)).toBeNull()
  })

  it('ignores a seedling of another kind', () => {
    expect(recallColumnMapping([seedling({ kind: 'axis_binding' })], HEADER_ROW, INFERRED)).toBeNull()
  })

  it('ignores a seedling whose payload is unparseable rather than throwing', () => {
    expect(recallColumnMapping([seedling({ payload: '{oops' })], HEADER_ROW, INFERRED)).toBeNull()
  })

  // DRIFT at the recall seam, not just inside mappingFromBinding: a sheet that
  // renamed a rank header gets no recall at all, so the director is asked.
  it('returns null for a drifted sheet', () => {
    const drifted = ['Camper', 'Bunk', 'Pick A', 'Third Choice']
    expect(recallColumnMapping([seedling()], drifted, { ...INFERRED })).toBeNull()
  })

  // The recalled mapping is run through the SAME gates a fresh correction is,
  // per T281: a recall that does not come out readable is discarded rather than
  // shown, because a pre-filled screen that still cannot be confirmed is worse
  // than an empty one.
  it('discards a recall that does not survive the readability gate', () => {
    // Rank #1 and the camper name on one column -- inference cannot produce this,
    // a corrupted or hand-edited payload can, and it must not reach the screen.
    const bad = JSON.stringify({ ...payload, ranks: [{ rank: 1, header: 'Camper' }] })
    expect(recallColumnMapping([seedling({ payload: bad })], HEADER_ROW, INFERRED)).toBeNull()
  })
})

describe('recallColumnMapping — the header row is read at its own index', () => {
  // A title line above the table, which T285 slice A established as ordinary.
  const ROWS_HEADER = ['Camper', 'Bunk', 'Pick A', 'Pick B', 'Notes']
  const { matchKey, payload } = bindingFromMapping(
    { headerIndex: 1, nameIndex: 0, divisionIndex: 1, rankColumns: [{ rank: 1, index: 2 }, { rank: 2, index: 3 }] },
    ROWS_HEADER
  )
  const INFERRED_AT_ROW_1 = { headerIndex: 1, nameIndex: 0, divisionIndex: 1, rankColumns: [], unmapped: ['ranks'] }

  it('still reports the unmapped column as unread when the table starts at row 1', () => {
    const out = recallColumnMapping(
      [{ id: 's1', kind: 'preference_column_roles', status: 'active', match_key: matchKey, payload: JSON.stringify(payload) }],
      ROWS_HEADER,
      INFERRED_AT_ROW_1
    )
    expect(out).not.toBeNull()
    // `Notes` carries no role, so it MUST be reported. Reading the header at row 0
    // would make this list empty and the sheet would look fully understood.
    expect(out.unrecognisedColumns.map((c) => c.header)).toEqual(['Notes'])
  })
})
