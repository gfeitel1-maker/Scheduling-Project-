// T226 — reading a camper ranked-preference sheet.
//
// Fixtures here are the shape of a real blank form (camper name, division, a
// 1..N ranking, a swim opt-out), fabricated. No real camper data is in this
// repo, and none may be added.
import { describe, it, expect } from 'vitest'
import {
  hasContradictoryRanks,
  inferPreferenceLayout,
  inferPreferenceMapping,
  describeMappingReadiness,
  mappingWithDirectorOverride,
  parsePreferenceSheet,
} from './preferenceSheet.js'
import { buildPreferenceCatalog } from './preferenceImport.js'

const HEADER = ['Camper Name', 'Division', 'Swim Alternative (Y/N)', '#1', '#2', '#3', 'Additional Comments']
const ROWS = [
  HEADER,
  ['Ari Green', 'Arad', 'N', 'Archery', 'Gaga', 'Sailing', ''],
  ['Noa Katz', 'Bogrim', 'Y', 'Ceramics', 'Archery', 'Gaga', 'allergic to bees'],
]

describe('inferPreferenceMapping', () => {
  it('finds the name, division and rank columns in the Top-25 form shape', () => {
    const m = inferPreferenceMapping(HEADER)
    expect(m.nameIndex).toBe(0)
    expect(m.divisionIndex).toBe(1)
    // `coordinate: null` joins each entry in T285 slice B — a rank column may now
    // name its own cell ("Monday Period 3 - First Choice"), and a plain `#N`
    // header names none. Asserted explicitly rather than loosened away, because
    // which coordinate a rank column carries decides which period a child's
    // first choice lands in.
    expect(m.rankColumns).toEqual([
      { rank: 1, index: 3, coordinate: null },
      { rank: 2, index: 4, coordinate: null },
      { rank: 3, index: 5, coordinate: null },
    ])
    expect(m.externalIdIndex).toBeNull()
  })

  it('finds an external id column when the export carries one', () => {
    const m = inferPreferenceMapping(['Camper ID', 'Camper Name', '#1'])
    expect(m.externalIdIndex).toBe(0)
    expect(m.nameIndex).toBe(1)
  })

  // The inference is a proposal, never a decision — the director overrides it.
  it('reports what it could not find instead of guessing', () => {
    const m = inferPreferenceMapping(['Who', 'Thing A', 'Thing B'])
    expect(m.nameIndex).toBeNull()
    expect(m.rankColumns).toEqual([])
    expect(m.unmapped).toContain('name')
    expect(m.unmapped).toContain('ranks')
  })
})

describe('parsePreferenceSheet', () => {
  const mapping = inferPreferenceMapping(HEADER)

  it('reads campers, their distinct choices, and one preference per rank', () => {
    const out = parsePreferenceSheet(ROWS, { campId: 'camp-1', mapping })
    expect(out.campers.map((c) => c.display_name)).toEqual(['Ari Green', 'Noa Katz'])
    expect(out.choices.map((c) => c.label).sort()).toEqual(['Archery', 'Ceramics', 'Gaga', 'Sailing'])
    expect(out.preferences).toHaveLength(6)
    const ari = out.campers[0]
    expect(out.preferences.filter((p) => p.camper_id === ari.id).map((p) => p.rank)).toEqual([1, 2, 3])
  })

  it('gives every camper a derived id, so two devices reading one sheet converge', () => {
    const a = parsePreferenceSheet(ROWS, { campId: 'camp-1', mapping })
    const b = parsePreferenceSheet(ROWS, { campId: 'camp-1', mapping })
    expect(a.campers.map((c) => c.id)).toEqual(b.campers.map((c) => c.id))
  })

  // The owner-approved identity rule: surface the collision, never merge two
  // real children and never mint a third record behind the director's back.
  it('flags two campers with the same name instead of merging them', () => {
    const rows = [HEADER, ROWS[1], ['Ari Green', 'Bogrim', 'N', 'Gaga', 'Archery', 'Sailing', '']]
    const out = parsePreferenceSheet(rows, { campId: 'camp-1', mapping })
    // T279: `divisionLabels` joins the entry, in row order. The refusal sentence
    // has to name each row's division — it is the disambiguation evidence that
    // lets a director say "those are two different kids", and the message
    // carried nothing of the kind before (ADR 2026-09-27 §12.2a).
    expect(out.sameNameCampers).toEqual([
      { display_name: 'Ari Green', rowNumbers: [2, 3], divisionLabels: ['Arad', 'Bogrim'] },
    ])
    // Not merged, not silently split: one id, and a decision handed back.
    expect(new Set(out.campers.map((c) => c.id)).size).toBe(1)
  })

  // Observed against a 100-row fabricated sheet: three rows naming one child
  // collapse onto one camper holding 75 preferences with THREE rank-1 choices.
  // The flag is therefore not advisory — committing this would hand the solver
  // contradictory input it would resolve by silently picking one. Pinned so
  // nobody later reads sameNameCampers as a warning to click past.
  it('a same-name collision produces contradictory ranks, not merely a duplicate', () => {
    const rows = [
      HEADER,
      ['Ari Green', 'Arad', 'N', 'Archery', 'Gaga', 'Sailing', ''],
      ['Ari Green', 'Bogrim', 'N', 'Ceramics', 'Sailing', 'Gaga', ''],
    ]
    const out = parsePreferenceSheet(rows, { campId: 'camp-1', mapping })
    expect(out.sameNameCampers).toHaveLength(1)
    const rankOne = out.preferences.filter((p) => p.rank === 1).map((p) => p.label)
    expect(rankOne).toEqual(['Archery', 'Ceramics']) // one camper, two firsts
    expect(hasContradictoryRanks(out)).toBe(true)
  })

  it('reports no contradiction for a clean sheet', () => {
    expect(hasContradictoryRanks(parsePreferenceSheet(ROWS, { campId: 'camp-1', mapping }))).toBe(false)
  })

  // T265 ROUND 3 (round-1's "preferenceSheet.js is out of scope" ruling was
  // WRONG and is retracted). Two independent rank-1s in two DIFFERENT
  // occurrences are the NORMAL shape of a per-cell grid (ADR Decision 1) —
  // not a contradiction. Before this fix, the key had no occurrence
  // dimension, so this legitimate sheet was refused with a false claim
  // ("holds the same preference rank twice") that gave a director nothing
  // to fix.
  describe('occurrence-aware contradiction key (T265 round 3)', () => {
    it('does not flag rank 1 in two different occurrences as a contradiction', () => {
      expect(hasContradictoryRanks({
        preferences: [
          { camper_id: 'cam-1', occurrence_id: 'occ-mon-p3', rank: 1 },
          { camper_id: 'cam-1', occurrence_id: 'occ-mon-p6', rank: 1 },
        ],
      })).toBe(false)
    })

    // The real contradiction WITHIN a cell must still refuse — two rank-1s
    // for the same camper in the SAME occurrence is genuinely unreadable.
    it('still flags rank 1 twice within the SAME occurrence', () => {
      expect(hasContradictoryRanks({
        preferences: [
          { camper_id: 'cam-1', occurrence_id: 'occ-mon-p3', rank: 1, labelKey: 'archery' },
          { camper_id: 'cam-1', occurrence_id: 'occ-mon-p3', rank: 1, labelKey: 'gaga' },
        ],
      })).toBe(true)
    })

    // T226's ORIGINAL case, unweakened: a whole-run sheet (no occurrence_id
    // at all, exactly what today's parser produces) with a duplicate rank
    // must still refuse — every row shares the same empty occurrence
    // component, so this collapses to the pre-fix key exactly.
    it('still flags a duplicate rank on a whole-run sheet with no occurrence_id', () => {
      expect(hasContradictoryRanks({
        preferences: [
          { camper_id: 'cam-1', rank: 1, labelKey: 'archery' },
          { camper_id: 'cam-1', rank: 1, labelKey: 'ceramics' },
        ],
      })).toBe(true)
    })
  })

  it('does not flag same-name campers who carry distinct external ids', () => {
    const header = ['Camper ID', 'Camper Name', '#1']
    const m = inferPreferenceMapping(header)
    const out = parsePreferenceSheet(
      [header, ['CM-1', 'Ari Green', 'Gaga'], ['CM-2', 'Ari Green', 'Archery']],
      { campId: 'camp-1', mapping: m }
    )
    expect(out.sameNameCampers).toEqual([])
    expect(new Set(out.campers.map((c) => c.id)).size).toBe(2)
  })

  // Board item i-same-name-sheet-solves-silently-dropping-a-camper, seen live
  // 2026-09-30 on docs/work/specs/samples/fabricated-camper-preferences-same-name.csv.
  // With a CATALOGUED camp, a row whose cells name no known activity is skipped
  // as junk (P13). When that row shares a name with a KEPT camper, the collision
  // used to vanish: the sheet was NOT refused, the solver ran, and the second
  // child was placed nowhere with nothing saying who was dropped. Here the
  // catalog holds Archery/Ceramics but NOT the second Ari's Robotics/Soccer, so
  // row 3 is skipped — and must still be surfaced as a same-name collision.
  it('flags a same-name camper whose choices are outside the catalog instead of silently dropping them', () => {
    const catalog = buildPreferenceCatalog({ activities: ['Archery', 'Ceramics'] })
    const rows = [
      HEADER,
      ['Ari Green', 'Arad', 'N', 'Archery', 'Ceramics', '', ''],
      ['Ari Green', 'Bogrim', 'N', 'Robotics', 'Soccer', '', ''],
    ]
    const out = parsePreferenceSheet(rows, { campId: 'camp-1', mapping, catalog })
    expect(out.sameNameCampers).toEqual([
      { display_name: 'Ari Green', rowNumbers: [2, 3], divisionLabels: ['Arad', 'Bogrim'] },
    ])
    // The dropped row is still recorded as skipped (it is not a camper record),
    // but the collision is no longer invisible.
    expect(out.skippedRows.map((s) => s.rowNumber)).toContain(3)
  })

  // The other direction: the skip must still drop a genuine junk footer, and a
  // unique one that matches no camper must NOT become a false same-name refusal.
  it('still skips a junk footer row that shares no name with a camper', () => {
    const catalog = buildPreferenceCatalog({ activities: ['Archery', 'Ceramics'] })
    const rows = [
      HEADER,
      ['Ari Green', 'Arad', 'N', 'Archery', 'Ceramics', '', ''],
      ['Total Campers', '', '', '8', '', '', ''],
    ]
    const out = parsePreferenceSheet(rows, { campId: 'camp-1', mapping, catalog })
    expect(out.sameNameCampers).toEqual([])
    expect(out.campers.map((c) => c.display_name)).toEqual(['Ari Green'])
    expect(out.skippedRows.map((s) => s.rowNumber)).toContain(3)
  })

  // And two junk rows that happen to share a name (and match no camper) must not
  // block an import — they collapse onto one id but neither is a kept camper.
  it('does not refuse on two junk rows that share a name but match no camper', () => {
    const catalog = buildPreferenceCatalog({ activities: ['Archery'] })
    const rows = [
      HEADER,
      ['Archery', 'Ceramics', 'N', 'Archery', '', '', ''], // one real camper
      ['Subtotal', '', '', '8', '', '', ''],
      ['Subtotal', '', '', '9', '', '', ''],
    ]
    const out = parsePreferenceSheet(rows, { campId: 'camp-1', mapping, catalog })
    expect(out.sameNameCampers).toEqual([])
  })

  it('skips blank rank cells without shifting the ranks below them', () => {
    const out = parsePreferenceSheet(
      [HEADER, ['Ari Green', 'Arad', 'N', 'Archery', '', 'Sailing', '']],
      { campId: 'camp-1', mapping }
    )
    expect(out.preferences.map((p) => [p.rank, p.label])).toEqual([[1, 'Archery'], [3, 'Sailing']])
  })

  it('folds a spelling variant of one activity onto a single choice', () => {
    const out = parsePreferenceSheet(
      [HEADER, ['Ari Green', 'Arad', 'N', 'Water Ski', 'waterski', 'Gaga', '']],
      { campId: 'camp-1', mapping }
    )
    expect(out.choices).toHaveLength(2)
  })

  it('reports a row it cannot name rather than importing an anonymous camper', () => {
    const out = parsePreferenceSheet([HEADER, ['', 'Arad', 'N', 'Archery', '', '', '']], { campId: 'camp-1', mapping })
    expect(out.campers).toHaveLength(0)
    expect(out.skippedRows).toEqual([{ rowNumber: 2, reason: 'no camper name' }])
  })
})

// T307 — a director's corrected mapping, made into one the inferencer could itself
// have produced. The panel-level behaviour is covered in AssignmentPanel.test.jsx;
// these pin the normalisation rules directly, because they are the part that is easy
// to get subtly wrong and invisible when you do.
describe('mappingWithDirectorOverride', () => {
  const CATALOG = { activities: ['Archery', 'Gaga', 'Sailing', 'Ceramics'] }

  it('returns null for no override, so the caller falls back to inference', () => {
    expect(mappingWithDirectorOverride(null, ROWS)).toBeNull()
  })

  // THE CLAIM THE CALLER DEPENDS ON. The panel sends the mapping on every confirm
  // rather than trying to detect whether the director edited it, which is only safe
  // if an untouched mapping survives the trip unchanged.
  it('is identity on an un-edited inferred mapping', () => {
    const inferred = inferPreferenceLayout(ROWS, { catalog: CATALOG })
    expect(mappingWithDirectorOverride(inferred, ROWS)).toEqual(inferred)
  })

  it('recomputes what is unread from the roles the director actually assigned', () => {
    const inferred = inferPreferenceLayout(ROWS, { catalog: CATALOG })
    // The comments column, which inference could not place.
    expect(inferred.unrecognisedColumns.map((c) => c.header)).toContain('Additional Comments')

    const edited = mappingWithDirectorOverride({ ...inferred, divisionIndex: 6 }, ROWS)
    // Mapped now, so no longer reported unread...
    expect(edited.unrecognisedColumns.map((c) => c.header)).not.toContain('Additional Comments')
    // ...and the column it displaced is, which is the half a stale-field bug hides.
    expect(edited.unrecognisedColumns.map((c) => c.header)).toContain('Division')
  })

  it('clears "ranks" from unmapped once the director supplies a rank column', () => {
    const header = ['Camper', 'Pick A', 'Pick B']
    const inferred = inferPreferenceLayout([header], { catalog: CATALOG })
    expect(inferred.unmapped).toContain('ranks')

    const edited = mappingWithDirectorOverride(
      { ...inferred, rankColumns: [{ rank: 1, index: 1 }, { rank: 2, index: 2 }] },
      [header]
    )
    expect(edited.unmapped).toEqual([])
  })

  // THE SHAPE GATES, which inference enforces on itself and a hand edit walks past.
  // parsePreferenceSheet is additive across shapes, so a mapping carrying two of them
  // has the sheet read twice.
  it('drops an inverted matrix once the director supplies rank columns', () => {
    const header = ['Camper', 'Archery', 'Gaga', 'Top Pick']
    const inferred = inferPreferenceLayout([header], { catalog: CATALOG })
    expect(inferred.invertedMatrix).not.toBeNull()

    const edited = mappingWithDirectorOverride(
      { ...inferred, rankColumns: [{ rank: 1, index: 3 }] },
      [header]
    )
    expect(edited.invertedMatrix).toBeNull()
    expect(edited.rankColumns).toEqual([{ rank: 1, index: 3 }])
  })

  it('drops a split name once the director names a single name column', () => {
    const header = ['First Name', 'Last Name', '#1']
    const inferred = inferPreferenceLayout([header], { catalog: CATALOG })
    expect(inferred.splitName).toEqual({ firstNameIndex: 0, lastNameIndex: 1 })

    const edited = mappingWithDirectorOverride({ ...inferred, nameIndex: 1 }, [header])
    expect(edited.splitName).toBeNull()
    expect(edited.nameIndex).toBe(1)
  })

  // A rank the director added and never pointed anywhere states nothing. Kept, it
  // would reach `cell(row, null)` and read column A as every unassigned rank.
  it('drops a rank column with no column picked, and orders the rest', () => {
    const header = ['Camper', 'Pick A', 'Pick B']
    const edited = mappingWithDirectorOverride(
      {
        headerIndex: 0,
        nameIndex: 0,
        rankColumns: [{ rank: 3, index: null }, { rank: 2, index: 2 }, { rank: 1, index: 1 }],
      },
      [header]
    )
    expect(edited.rankColumns).toEqual([{ rank: 1, index: 1 }, { rank: 2, index: 2 }])
  })

  // The header is read at the mapping's OWN headerIndex, not row 0. A sheet with a
  // title line above the table would otherwise have every column named after the
  // title's cells — the same defect the panel hit when it fed row 0 to the corrector.
  it('reads the header row the located mapping points at', () => {
    const rows = [['Camp Shoresh 5786'], ['Camper', 'Bunk', '#1'], ['Ari Green', 'Arad', 'Archery']]
    const inferred = inferPreferenceLayout(rows, { catalog: CATALOG })
    expect(inferred.headerIndex).toBe(1)

    const edited = mappingWithDirectorOverride({ ...inferred, divisionIndex: null }, rows)
    expect(edited.unrecognisedColumns.map((c) => c.header)).toEqual(['Bunk'])
  })
})

describe('describeMappingReadiness', () => {
  it('reports a collision the director can fix', () => {
    const { collision } = describeMappingReadiness({
      headerIndex: 0, nameIndex: 0, rankColumns: [{ rank: 1, index: 0 }],
    })
    expect(collision).toEqual({ index: 0, roles: ['Camper name', 'Rank #1'] })
  })

  // A REFUSAL THE DIRECTOR CANNOT ACT ON IS A DEAD END, not a question. Inference can
  // double-assign a column by itself -- each role is found by its own independent
  // `findIndex`, so one header can satisfy two patterns -- and the corrector offers no
  // control for a day or period column. Reporting that would disable Confirm and name
  // two roles, neither of which has a dropdown.
  it('stays silent on a collision between two roles the corrector cannot move', () => {
    const { collision } = describeMappingReadiness({
      headerIndex: 0, nameIndex: 1, dayIndex: 0, periodIndex: 0,
      rankColumns: [{ rank: 1, index: 2 }],
    })
    expect(collision).toBeNull()
  })

  // ...but the same column ALSO carrying an editable role is actionable again.
  it('reports it once an editable role joins the same column', () => {
    const { collision } = describeMappingReadiness({
      headerIndex: 0, nameIndex: 0, dayIndex: 0, periodIndex: 0,
      rankColumns: [{ rank: 1, index: 2 }],
    })
    expect(collision?.index).toBe(0)
    expect(collision?.roles).toContain('Camper name')
  })

  // The gate is the transform's own readability test, so a sheet whose ranks live in
  // its CELLS is ready with no rank columns at all.
  it('calls an inverted matrix ready without any rank columns', () => {
    const header = ['Camper', 'Archery', 'Gaga']
    const inferred = inferPreferenceLayout([header], { catalog: { activities: ['Archery', 'Gaga'] } })
    expect(inferred.rankColumns).toEqual([])
    expect(describeMappingReadiness(inferred)).toEqual({ unmapped: [], collision: null })
  })

  it('treats no mapping at all as nothing mapped', () => {
    expect(describeMappingReadiness(null)).toEqual({ unmapped: ['name', 'ranks'], collision: null })
  })
})

// Board item 9b — A BUNDLE NAME IS A LABEL LIKE ANY OTHER, once the catalogue
// carries it (buildPreferenceCatalog merges bundles into `activities`; see its
// own note for why one list and not two).
//
// These drive `preferenceSheet.js` with a catalogue built the way
// `buildPreferenceCatalog` builds it, so the two facts asserted are the two the
// merge has to buy: a bundle-named COLUMN is inverted-matrix evidence, and a
// bundle-named CELL resolves instead of becoming UNRESOLVED_CHOICE_LABEL
// residue.
describe('a bundle name in the catalogue', () => {
  const CATALOG = buildPreferenceCatalog({
    activities: [{ name: 'Archery' }],
    bundles: [{ name: 'Ropes Intensive' }, { name: 'Lake Block' }],
  })

  it('two bundle-named columns are recognised as an inverted matrix', () => {
    const inferred = inferPreferenceLayout([['Camper', 'Ropes Intensive', 'Lake Block']], { catalog: CATALOG })
    expect(inferred.invertedMatrix?.map((c) => c.header)).toEqual(['Ropes Intensive', 'Lake Block'])
  })

  it('a bundle-named cell resolves rather than landing in residue', () => {
    const { preferences, residue } = parsePreferenceSheet(
      [['Camper Name', '#1'], ['Ari Green', 'Ropes Intensive']],
      { campId: 'camp-1', mapping: inferPreferenceMapping(['Camper Name', '#1']), catalog: CATALOG }
    )
    expect(residue.filter((r) => r.kind === 'UNRESOLVED_CHOICE_LABEL')).toEqual([])
    expect(preferences.map((p) => p.label)).toEqual(['Ropes Intensive'])
  })
})
