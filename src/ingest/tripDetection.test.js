// Slice 1 of docs/adr/2026-10-11-import-special-days-and-field-trips.md: the pure
// trip / special-day detector. Positive pins are per row on the synthetic corpus
// (manifest.json is the expected-facts source) plus a planted trip in a mutated
// copy of campB; negatives are the ADR's false-positive classes.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { detectTripsAndSpecialDays, lexicalCueOf } from './tripDetection.js'

const SYN = path.join(process.cwd(), 'docs/work/specs/samples/synthetic')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(SYN, 'manifest.json'), 'utf8'))

function detectParsed(parsed) {
  return detectTripsAndSpecialDays({ pages: parsed.pages }, extractEntities(parsed))
}
function detectFile(file) {
  return detectParsed(parseTextGrid(fs.readFileSync(file, 'utf8')))
}
const row = (d) => ({ kind: d.kind, day: d.day, name: d.name, groupIds: d.groupIds, blocks: d.blocks.length, lexicalCue: d.lexicalCue, confidence: d.confidence, defaultAnswer: d.defaultAnswer })

// Build a by-day parsed grid: days -> { groups, blocks, cells[blockIdx][groupIdx] }.
const LABELS = ['09:00-09:45', '09:50-10:35', '10:40-11:25', '11:30-12:15', '12:20-13:05']
function grid(days) {
  return {
    pages: Object.entries(days).map(([day, { groups, cells }]) => ({
      title: `${day} — All Camp`, columns: groups, timeColumnLabeled: true,
      rows: cells.map((c, i) => ({ label: LABELS[i], cells: c })),
    })),
  }
}

describe('detectTripsAndSpecialDays — synthetic corpus, per row', () => {
  const EXPECTED = {
    s04: [
      { kind: 'subset-day', day: 'Friday', name: 'Games Day', n: 8, blocks: 9, lexicalCue: 'day', confidence: 'high', defaultAnswer: 'event' },
      { kind: 'trip', day: 'Tuesday', name: 'Ropes Course', n: 8, blocks: 2, lexicalCue: null, confidence: 'low', defaultAnswer: 'activity' },
      { kind: 'trip', day: 'Wednesday', name: 'Aquarium Trip', n: 8, blocks: 2, lexicalCue: 'trip', confidence: 'medium', defaultAnswer: 'event' },
    ],
    s05: [
      { kind: 'all-camp-day', day: 'Friday', name: 'Games Day', n: 2, blocks: 8, lexicalCue: 'day', confidence: 'high', defaultAnswer: null },
      { kind: 'trip', day: 'Monday', name: 'Ropes Course', n: 2, blocks: 3, lexicalCue: null, confidence: 'low', defaultAnswer: 'activity' },
      { kind: 'trip', day: 'Thursday', name: 'Farm Trip', n: 1, blocks: 2, lexicalCue: 'trip', confidence: 'medium', defaultAnswer: 'event' },
    ],
    s08: [
      { kind: 'subset-day', day: 'Thursday', name: 'Games Day', n: 6, blocks: 8, lexicalCue: 'day', confidence: 'high', defaultAnswer: 'event' },
    ],
    s09: [
      { kind: 'subset-day', day: 'Saturday', name: 'Games Day', n: 20, blocks: 8, lexicalCue: 'day', confidence: 'high', defaultAnswer: 'event' },
      { kind: 'trip', day: 'Wednesday', name: 'Aquarium Trip', n: 4, blocks: 2, lexicalCue: 'trip', confidence: 'medium', defaultAnswer: 'event' },
    ],
    s12: [
      { kind: 'subset-day', day: 'Monday', name: 'Games Day', n: 6, blocks: 10, lexicalCue: 'day', confidence: 'high', defaultAnswer: 'event' },
      { kind: 'trip', day: 'Monday', name: 'Wilderness Skills', n: 4, blocks: 3, lexicalCue: null, confidence: 'low', defaultAnswer: 'activity' },
      { kind: 'trip', day: 'Tuesday', name: 'Aquarium Trip', n: 4, blocks: 2, lexicalCue: 'trip', confidence: 'medium', defaultAnswer: 'event' },
    ],
    s13: [
      { kind: 'subset-day', day: 'Tuesday', name: 'Games Day', n: 8, blocks: 9, lexicalCue: 'day', confidence: 'high', defaultAnswer: 'event' },
      { kind: 'trip', day: 'Wednesday', name: 'Aquarium Trip', n: 4, blocks: 2, lexicalCue: 'trip', confidence: 'medium', defaultAnswer: 'event' },
    ],
  }
  for (const [prefix, rows] of Object.entries(EXPECTED)) {
    const camp = MANIFEST.camps.find((c) => c.slug.startsWith(prefix))
    it(`${camp.slug}: exactly the expected detections`, () => {
      const got = detectFile(path.join(SYN, camp.file)).map(row)
      expect(got.map(({ groupIds, ...r }) => ({ ...r, n: groupIds.length }))).toEqual(
        rows.map(({ n, blocks, ...r }) => ({ ...r, blocks, n })).map(({ kind, day, name, blocks, lexicalCue, confidence, defaultAnswer, n }) => ({ kind, day, name, blocks, lexicalCue, confidence, defaultAnswer, n })),
      )
    })
  }

  // Every manifest trip / all-day day on all 15 camps is detected with the manifest's groups, day and blocks.
  for (const camp of MANIFEST.camps) {
    const expected = camp.events.filter((e) => e.kind === 'trip' || e.kind === 'allday')
    if (!expected.length) continue
    it(`${camp.slug}: manifest trips and all-day days match detections (groups, day, block count)`, () => {
      const got = detectFile(path.join(SYN, camp.file)).filter((d) => d.defaultAnswer !== 'activity')
      expect(got).toHaveLength(expected.length)
      for (const e of expected) {
        const d = got.find((x) => x.name === e.name && x.day === e.days[0])
        expect(d, e.name).toBeTruthy()
        expect(d.blocks).toHaveLength(e.blocks.length)
        expect(d.groupIds).toEqual(e.groups === 'all' ? [...camp.groups].sort() : [...e.groups].sort())
        expect(d.kind).toBe(e.kind === 'trip' ? (d.wholeDay ? 'subset-day' : 'trip') : e.groups === 'all' ? 'all-camp-day' : 'subset-day')
      }
    })
  }
})

describe('detectTripsAndSpecialDays — mutated campB (planted, uncorrelated)', () => {
  const file = path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt')
  const load = () => parseTextGrid(fs.readFileSync(file, 'utf8'))
  it('adds exactly the planted trip, minus the group whose cell was mutated', () => {
    const base = detectParsed(load())
    const parsed = load()
    const thu = parsed.pages.find((p) => p.title.startsWith('Thursday'))
    const cols = ['Badger 1', 'Badger 2', 'Badger 3'].map((g) => thu.columns.indexOf(g))
    const r1 = thu.rows.findIndex((r) => r.label.startsWith('12:55'))
    for (const c of cols) { thu.rows[r1].cells[c] = 'Zoo Trip'; thu.rows[r1 + 1].cells[c] = 'Zoo Trip' }
    thu.rows[r1 + 1].cells[cols[2]] = 'Music' // mutate one group's cell
    const after = detectParsed(parsed)
    const key = (d) => JSON.stringify([d.kind, d.day, d.name, d.groupIds, d.blocks])
    const added = after.filter((d) => !base.map(key).includes(key(d)))
    const removed = base.filter((d) => !after.map(key).includes(key(d)))
    expect(removed).toEqual([])
    expect(added.map(row)).toEqual([{
      kind: 'trip', day: 'Thursday', name: 'Zoo Trip', groupIds: ['Badger 1', 'Badger 2'], blocks: 2,
      lexicalCue: 'trip', confidence: 'medium', defaultAnswer: 'event',
    }])
  })
})

describe('detectTripsAndSpecialDays — negatives', () => {
  const G = ['G1', 'G2', 'G3', 'G4']
  const filler = (n, i) => `Act ${i}-${n}`

  it('a two-block catalogue activity on one day is shown with default activity, never event', () => {
    const d = detectParsed(grid({
      Monday: { groups: G, cells: [['Pottery', 'Swim', 'Archery', 'Music'], ['Pottery', 'Archery', 'Swim', 'Drama'], ['Lunch', 'Lunch', 'Lunch', 'Lunch']] },
    }))
    expect(d.map(row)).toEqual([{ kind: 'trip', day: 'Monday', name: 'Pottery', groupIds: ['G1'], blocks: 2, lexicalCue: null, confidence: 'low', defaultAnswer: 'activity' }])
  })

  it('a rotation of one name across groups and days is not a detection', () => {
    const day = (gi) => ({ groups: G, cells: [0, 1, 2].map((b) => G.map((_, i) => (i === gi && b < 2 ? 'Climbing' : filler(b, i)))) })
    expect(detectParsed(grid({ Monday: day(0), Tuesday: day(1), Wednesday: day(2) }))).toEqual([])
  })

  it('a rainy-day pair on the same (day, group-set, blocks) gets no default for either', () => {
    const d = detectParsed(grid({
      Tuesday: { groups: G, cells: [['Zoo Trip - Bowling', 'Zoo Trip - Bowling', 'Swim', 'Music'], ['Zoo Trip - Bowling', 'Zoo Trip - Bowling', 'Music', 'Swim'], ['Lunch', 'Lunch', 'Lunch', 'Lunch']] },
    }))
    expect(d.map((x) => [x.name, x.defaultAnswer, x.alternate])).toEqual([['Bowling', null, true], ['Zoo Trip', null, true]])
  })

  it('a rain-token name gets no default', () => {
    const d = detectParsed(grid({ Tuesday: { groups: G, cells: [['Rainy Day Movie', 'Swim', 'Music', 'Drama'], ['Rainy Day Movie', 'Music', 'Swim', 'Art']] } }))
    expect(d.map((x) => [x.name, x.defaultAnswer])).toEqual([['Rainy Day Movie', null]])
  })

  it('23 of 24 groups is subset-day naming the missing group, never all-camp-day', () => {
    const groups = Array.from({ length: 24 }, (_, i) => `Cabin ${i + 1}`)
    const d = detectParsed(grid({
      Monday: { groups, cells: [0, 1, 2, 3, 4].map((b) => groups.map((_, i) => (i === 23 ? filler(b, i) : 'Carnival Day'))) },
    }))
    expect(d.map((x) => [x.kind, x.groupIds.length, x.missingGroups, x.defaultAnswer])).toEqual([['subset-day', 23, ['Cabin 24'], 'event']])
  })

  it('24 of 24 groups is all-camp-day with no default (explicit answer only)', () => {
    const groups = Array.from({ length: 24 }, (_, i) => `Cabin ${i + 1}`)
    const d = detectParsed(grid({ Monday: { groups, cells: [0, 1, 2, 3, 4].map(() => groups.map(() => 'Carnival Day')) } }))
    expect(d.map((x) => [x.kind, x.groupIds.length, x.defaultAnswer])).toEqual([['all-camp-day', 24, null]])
  })

  it('a printed Lunch breaks the run: two detections, neither claims the Lunch block', () => {
    const d = detectParsed(grid({
      Wednesday: { groups: G, cells: [
        ['Zoo Trip', 'Zoo Trip', 'Swim', 'Music'], ['Zoo Trip', 'Zoo Trip', 'Music', 'Swim'],
        ['Lunch', 'Lunch', 'Lunch', 'Lunch'],
        ['Zoo Trip', 'Zoo Trip', 'Art', 'Drama'], ['Zoo Trip', 'Zoo Trip', 'Drama', 'Art'],
      ] },
    }))
    expect(d.map((x) => [x.name, x.blocks])).toEqual([['Zoo Trip', [LABELS[0], LABELS[1]]], ['Zoo Trip', [LABELS[3], LABELS[4]]]])
    expect(d.flatMap((x) => x.claims).some((c) => c.blockLabel === LABELS[2])).toBe(false)
  })

  it('two same-name trips for disjoint groups on different blocks are separate detections', () => {
    const d = detectParsed(grid({
      Wednesday: { groups: G, cells: [
        ['Zoo Trip', 'Zoo Trip', 'Swim', 'Music'], ['Zoo Trip', 'Zoo Trip', 'Music', 'Swim'],
        ['Swim', 'Music', 'Zoo Trip', 'Zoo Trip'], ['Music', 'Swim', 'Zoo Trip', 'Zoo Trip'],
      ] },
    }))
    expect(d.map((x) => [x.groupIds, x.blocks.length])).toEqual([[['G1', 'G2'], 2], [['G3', 'G4'], 2]])
  })

  it('same name, disjoint groups, SAME blocks is one detection with the union (slice 0 finding 2)', () => {
    const d = detectParsed(grid({
      Wednesday: { groups: G, cells: [['Zoo Trip', 'Swim', 'Zoo Trip', 'Music'], ['Zoo Trip', 'Music', 'Zoo Trip', 'Swim']] },
    }))
    expect(d.map((x) => x.groupIds)).toEqual([['G1', 'G3']])
  })

  it('a trip whose name equals a catalogue activity claims only its own run (no min_per_week inflation)', () => {
    const d = detectParsed(grid({
      Monday: { groups: G, cells: [['Field Games', 'Swim', 'Music', 'Art'], ['Swim', 'Field Games', 'Art', 'Music']] },
      Tuesday: { groups: G, cells: [['Music', 'Art', 'Field Games', 'Swim'], ['Art', 'Music', 'Swim', 'Field Games']] },
      Thursday: { groups: G, cells: [['Field Games', 'Field Games', 'Swim', 'Music'], ['Field Games', 'Field Games', 'Music', 'Swim']] },
    }))
    expect(d).toHaveLength(1)
    expect(d[0].claims).toEqual([
      { groupName: 'G1', dayName: 'Thursday', blockLabel: LABELS[0] }, { groupName: 'G1', dayName: 'Thursday', blockLabel: LABELS[1] },
      { groupName: 'G2', dayName: 'Thursday', blockLabel: LABELS[0] }, { groupName: 'G2', dayName: 'Thursday', blockLabel: LABELS[1] },
    ])
  })

  it('lexical cues match whole words only', () => {
    expect(lexicalCueOf('Aquarium Trip')).toBe('trip')
    expect(lexicalCueOf('Games Day')).toBe('day')
    expect(lexicalCueOf('Daydreaming')).toBe(null)
    expect(lexicalCueOf('Tripod Photography')).toBe(null)
  })
})
