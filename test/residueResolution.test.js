// @vitest-environment node
//
// T298 — THE TWO RESOLUTIONS SLICE 1 LEFT OUT, asserted at the DATABASE.
//
// The premise these tests hold, and the one a bucket-counting test would miss:
// "the director settled it" is not a fact about the residue list, it is a fact
// about what landed. A test that asserts `residue.length` fell, or that a row now
// reads "Read as …", proves the UI changed its mind. What has to be true is that
// forty rows naming "Arts and Crafts" end up attached to the "Arts & Crafts" the
// camp ALREADY HAS — one activity, one choice, forty preferences — and that is a
// claim only the database can settle.
//
// Modelled on test/panelImportPath.test.js, whose harness this extends with the
// one new argument (`resolutions`). Same reason it exists: the panel's own call
// shape, so the numbers describe the product rather than the CLI.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { openLocalDb } from '../electron/db/localDb.js'
import { commitElectiveRun } from '../electron/ops/commitElectiveRun.js'
import { buildPreferenceCatalog, readPreferenceSheet } from '../src/ingest/preferenceImport.js'
import { resolutionMap, RESOLUTION, proposeActivityMatch } from '../src/ingest/labelResolutions.js'
import { journalEntriesFor, OUTCOMES } from '../src/ingest/decisionJournal.js'

let dir
let dbPath
let campId
let deviceId

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-residue-'))
  dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  campId = randomUUID()
  deviceId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Host')
  db.close()
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const withDb = (fn) => {
  const db = openLocalDb(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function seedActivities(names) {
  withDb((db) => {
    const insert = db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)')
    for (const n of names) insert.run(randomUUID(), campId, n)
  })
}

const collections = () =>
  withDb((db) => ({
    activities: db.prepare('SELECT id, name FROM activities WHERE camp_id = ?').all(campId),
    groups: [],
    tiers: [],
  }))

/** FILE BYTES -> the panel's read (with the director's resolutions) -> commit -> database. */
function importThroughPanelPath(bytes, { resolutions = [], label = 'sheet' } = {}) {
  const file = path.join(dir, `${label}.csv`)
  fs.writeFileSync(file, bytes)
  const rows = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((line) => line.split(/\t|,/).map((c) => c.trim()))

  const { parsed } = readPreferenceSheet({
    rows,
    campId,
    catalog: buildPreferenceCatalog(collections()),
    sourceLabel: label,
    submissionKey: `sub-${label}-${bytes.length}`,
    resolutions: resolutionMap(resolutions),
  })
  if (!parsed) return { parsed: null, committed: null }
  const committed = withDb((db) =>
    commitElectiveRun(db, { campId, deviceId, name: 'Residue import', parsed, assignments: [], occurrences: [] })
  )
  return { parsed, committed }
}

const residueOf = (parsed, kind) => (parsed?.residue ?? []).filter((r) => r.kind === kind)

const dbState = () =>
  withDb((db) => ({
    activityNames: db.prepare('SELECT name FROM activities WHERE camp_id = ? ORDER BY name').all(campId).map((r) => r.name),
    choiceLabels: db.prepare('SELECT label FROM elective_choices ORDER BY label').all().map((r) => r.label),
    preferences: db
      .prepare(
        `SELECT c.label AS label, COUNT(*) AS n
           FROM elective_preferences p JOIN elective_choices c ON c.id = p.choice_id
          GROUP BY c.label ORDER BY c.label`
      )
      .all(),
  }))

// ── 1. MAP TO AN EXISTING ACTIVITY ───────────────────────────────────────────
//
// The owner's own example: the file says "Arts and Crafts", the camp has
// "Arts & Crafts". A second activity is the wrong answer, and so is refusing.
describe('map an unresolved label to an activity the camp already has', () => {
  // Forty rows, one label, so "the mapping applies to the whole group" is a claim
  // about forty things rather than a nice property of one.
  const FORTY = (labelInFile) =>
    'Camper Name,#1,#2\n' +
    Array.from({ length: 40 }, (_, i) => `Camper ${String(i + 1).padStart(2, '0')},Swim,${labelInFile}`).join('\n') +
    '\n'

  beforeEach(() => seedActivities(['Swim', 'Arts & Crafts']))

  it('PROPOSES the camp’s own spelling, without applying it', () => {
    const { parsed } = importThroughPanelPath(FORTY('Arts and Crafts'))
    const unresolved = residueOf(parsed, 'UNRESOLVED_CHOICE_LABEL')
    // One decision, forty cells. And it is STILL residue: proposing is not applying.
    expect(new Set(unresolved.map((r) => r.label))).toEqual(new Set(['Arts and Crafts']))
    expect(unresolved).toHaveLength(40)
    expect(proposeActivityMatch('Arts and Crafts', ['Swim', 'Arts & Crafts'])).toEqual({
      name: 'Arts & Crafts',
      rule: 'connector',
    })
    // Nothing landed under the file's spelling, and no second activity appeared.
    expect(dbState().activityNames).toEqual(['Arts & Crafts', 'Swim'])
    expect(dbState().choiceLabels).toEqual(['Swim'])
  })

  it('once confirmed, all FORTY rows attach to the EXISTING activity', () => {
    const { parsed, committed } = importThroughPanelPath(FORTY('Arts and Crafts'), {
      resolutions: [
        { label: 'Arts and Crafts', action: RESOLUTION.MAP_TO_EXISTING, activityName: 'Arts & Crafts' },
      ],
    })
    expect(committed.ok).toBe(true)

    const state = dbState()
    // THE CLAIM. No second activity was minted...
    expect(state.activityNames).toEqual(['Arts & Crafts', 'Swim'])
    // ...there is exactly ONE choice for it, under the CAMP's spelling and not the
    // file's, which is what makes its labelKey match the offering's...
    expect(state.choiceLabels).toEqual(['Arts & Crafts', 'Swim'])
    expect(state.choiceLabels).not.toContain('Arts and Crafts')
    // ...and all forty rows hang off it.
    expect(state.preferences).toEqual([
      { label: 'Arts & Crafts', n: 40 },
      { label: 'Swim', n: 40 },
    ])
    // The question is settled, so it is no longer asked.
    expect(residueOf(parsed, 'UNRESOLVED_CHOICE_LABEL')).toHaveLength(0)
  })

  it('maps a word-form variant too, which is the other rule', () => {
    seedActivities(['Swim Returning'])
    const { committed } = importThroughPanelPath('Camper Name,#1\nAri,Swim Return\n', {
      resolutions: [
        { label: 'Swim Return', action: RESOLUTION.MAP_TO_EXISTING, activityName: 'Swim Returning' },
      ],
    })
    expect(committed.ok).toBe(true)
    expect(dbState().choiceLabels).toEqual(['Swim Returning'])
    expect(proposeActivityMatch('Swim Return', ['Swim Returning'])?.rule).toBe('word-form')
  })

  it('a mapping with no target is not a mapping, and changes nothing', () => {
    // `resolutionMap` drops it, so the resolver never sees a half-finished answer.
    const { parsed } = importThroughPanelPath(FORTY('Arts and Crafts'), {
      resolutions: [{ label: 'Arts and Crafts', action: RESOLUTION.MAP_TO_EXISTING }],
    })
    expect(residueOf(parsed, 'UNRESOLVED_CHOICE_LABEL')).toHaveLength(40)
    expect(dbState().choiceLabels).toEqual(['Swim'])
  })
})

// ── 2. A PACKED CELL, READ TWO WAYS ──────────────────────────────────────────
describe('a packed cell is a decision with two readings, and both land', () => {
  const SHEET = 'Camper Name,#1,#2\nAri Feldspar,Swim,"Archery, Ceramics, Drama"\n'
  // The panel's CSV branch splits on commas, so a quoted cell is not how this
  // arrives — it arrives as a cell whose own value contains the delimiters. Built
  // with semicolons, which `PACKED_CELL_SPLIT` treats identically and a
  // comma-splitting reader leaves in one cell.
  const PACKED = 'Camper Name,#1,#2\nAri Feldspar,Swim,Archery; Ceramics; Drama\n'

  beforeEach(() => seedActivities(['Swim', 'Archery', 'Ceramics', 'Drama']))

  it('is reported as a decision naming its parts, and nothing is read from it', () => {
    const { parsed } = importThroughPanelPath(PACKED)
    const packed = residueOf(parsed, 'AMBIGUOUS_PACKED_CELL')
    expect(packed).toHaveLength(1)
    expect(packed[0].label).toBe('Archery; Ceramics; Drama')
    expect(packed[0].parts).toEqual(['Archery', 'Ceramics', 'Drama'])
    // Nothing was read from the cell: only the #1 column landed.
    expect(dbState().choiceLabels).toEqual(['Swim'])
    // And SHEET (the quoted form) is not the case under test — stated so a reader
    // does not take the constant above for dead weight.
    expect(SHEET).toContain('"Archery, Ceramics, Drama"')
  })

  it('resolved as SEVERAL, it produces those choices — three, at rank NULL', () => {
    const { parsed, committed } = importThroughPanelPath(PACKED, {
      resolutions: [{ label: 'Archery; Ceramics; Drama', action: RESOLUTION.SPLIT_PACKED }],
    })
    expect(committed.ok).toBe(true)
    const state = dbState()
    expect(state.choiceLabels).toEqual(['Archery', 'Ceramics', 'Drama', 'Swim'])
    expect(state.preferences).toEqual([
      { label: 'Archery', n: 1 },
      { label: 'Ceramics', n: 1 },
      { label: 'Drama', n: 1 },
      { label: 'Swim', n: 1 },
    ])
    // §4.1 — cell order is NOT ordering evidence, so the three are a tie among
    // equals and not a second, third and fourth choice. Reading them as ranked
    // would fabricate a preference the child never stated.
    const ranks = withDb((db) =>
      db
        .prepare(
          `SELECT c.label AS label, p.rank AS rank FROM elective_preferences p
             JOIN elective_choices c ON c.id = p.choice_id ORDER BY c.label`
        )
        .all()
    )
    expect(ranks.filter((r) => r.label !== 'Swim').map((r) => r.rank)).toEqual([null, null, null])
    // Nothing was minted: the parts were activities the camp already had.
    expect(state.activityNames).toEqual(['Archery', 'Ceramics', 'Drama', 'Swim'])
    expect(residueOf(parsed, 'AMBIGUOUS_PACKED_CELL')).toHaveLength(0)
  })

  it('resolved as ONE, it produces one choice — the whole cell, named as written', () => {
    // The "oddly-named single activity" reading. The director says it is one name,
    // and the app has it: the catalog gains that exact string, so the re-parse
    // matches the whole cell rather than splitting it.
    seedActivities(['Archery; Ceramics; Drama'])
    const { parsed, committed } = importThroughPanelPath(PACKED)
    expect(committed.ok).toBe(true)
    const state = dbState()
    // ONE choice for that cell, not three. The packed detection never fires,
    // because the whole cell now matches.
    expect(state.choiceLabels).toEqual(['Archery; Ceramics; Drama', 'Swim'])
    expect(state.preferences).toEqual([
      { label: 'Archery; Ceramics; Drama', n: 1 },
      { label: 'Swim', n: 1 },
    ])
    expect(residueOf(parsed, 'AMBIGUOUS_PACKED_CELL')).toHaveLength(0)
  })

  it('a packed cell can also be MAPPED, as one name the camp spells differently', () => {
    seedActivities(['Archery, Ceramics & Drama'])
    const { committed } = importThroughPanelPath(PACKED, {
      resolutions: [
        {
          label: 'Archery; Ceramics; Drama',
          action: RESOLUTION.MAP_TO_EXISTING,
          activityName: 'Archery, Ceramics & Drama',
        },
      ],
    })
    expect(committed.ok).toBe(true)
    // The director's answer beat the packed detection, which is the precedence the
    // resolver states: a director's answer is not evidence to be weighed.
    expect(dbState().choiceLabels).toEqual(['Archery, Ceramics & Drama', 'Swim'])
  })
})

// ── 3. THE JOURNAL ───────────────────────────────────────────────────────────
describe('the journal records what was PRESENTED, answered or not', () => {
  beforeEach(() => seedActivities(['Swim', 'Archery', 'Ceramics', 'Arts & Crafts']))

  // The panel's own derivation, restated here rather than imported: AssignmentPanel
  // is a .jsx module and this is a node-environment test. Kept deliberately thin —
  // it asserts the JOURNAL's behaviour over presented decisions, and the panel's
  // wiring of it is covered by the panel's own render tests.
  const present = (parsed, activityNames) => {
    const kinds = { UNRESOLVED_CHOICE_LABEL: 'resolve_unknown_label', AMBIGUOUS_PACKED_CELL: 'resolve_packed_cell' }
    const byLabel = new Map()
    for (const item of parsed.residue ?? []) {
      const kind = kinds[item.kind]
      if (!kind || !item.label || byLabel.has(item.label)) continue
      byLabel.set(item.label, {
        id: `${kind}:${item.label}`,
        kind,
        entityName: item.label,
        proposal: proposeActivityMatch(item.label, activityNames)?.name ?? null,
      })
    }
    return [...byLabel.values()]
  }

  it('records an UNANSWERED row for a decision the director never touched', () => {
    const { parsed } = importThroughPanelPath(
      'Camper Name,#1,#2,#3\nAri,Swim,Quidditch,Archery; Ceramics\n'
    )
    const presented = present(parsed, ['Swim', 'Archery', 'Ceramics', 'Arts & Crafts'])
    const entries = journalEntriesFor(presented, {}, 'import-1')

    // BOTH kinds were presented, and neither was answered. This is the row the
    // deferred learning layer most needs: a question nobody ever answers is a
    // question not worth asking, and nothing else in the app records it.
    expect(entries.map((e) => e.kind).sort()).toEqual(['resolve_packed_cell', 'resolve_unknown_label'])
    expect(entries.every((e) => e.outcome === OUTCOMES.UNANSWERED)).toBe(true)
    expect(entries.every((e) => e.chosen === null)).toBe(true)
  })

  it('records WHICH resolution was taken, and what we had proposed', () => {
    const { parsed } = importThroughPanelPath('Camper Name,#1,#2\nAri,Swim,Arts and Crafts\n')
    const names = ['Swim', 'Archery', 'Ceramics', 'Arts & Crafts']
    const presented = present(parsed, names)
    const entries = journalEntriesFor(
      presented,
      { 'resolve_unknown_label:Arts and Crafts': { action: 'mapped_to_existing', activityName: 'Arts & Crafts' } },
      'import-2'
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].outcome).toBe(OUTCOMES.CHANGED)
    // WAS THE PROPOSAL RIGHT is the first question the learning layer asks, and it
    // is answerable only because both halves are on the row.
    expect(JSON.parse(entries[0].proposed).proposal).toBe('Arts & Crafts')
    expect(JSON.parse(entries[0].chosen)).toMatchObject({
      action: 'mapped_to_existing',
      activityName: 'Arts & Crafts',
    })
  })

  it('distinguishes the three readings of a packed cell, which the outcome alone cannot', () => {
    const { parsed } = importThroughPanelPath('Camper Name,#1,#2\nAri,Swim,Archery; Ceramics\n')
    const presented = present(parsed, ['Swim', 'Archery', 'Ceramics'])
    const id = 'resolve_packed_cell:Archery; Ceramics'
    const split = journalEntriesFor(presented, { [id]: { action: 'split_packed' } }, 'i')[0]
    const added = journalEntriesFor(presented, { [id]: { action: 'added_activity' } }, 'i')[0]
    // Both are CHANGED, because in neither case was there a proposal to accept...
    expect([split.outcome, added.outcome]).toEqual([OUTCOMES.CHANGED, OUTCOMES.CHANGED])
    // ...so the outcome cannot tell them apart, and `chosen.action` is the whole
    // reason a later slice can tell whether camps prefer splitting or naming.
    expect(JSON.parse(split.chosen).action).toBe('split_packed')
    expect(JSON.parse(added.chosen).action).toBe('added_activity')
  })
})

// A PLANNER GRID IS A SECOND CALL SITE, and it went unguarded until a planted
// defect proved it. Reading a mapped cell as the FILE's spelling instead of the
// camp's — the exact defect section 1 above catches on the ranked path — passed 78
// tests, because every test in this file and in panelImportPath.test.js entered
// through the ranked table. The two paths resolve labels with the same resolver and
// then do their own thing with the verdict, which is precisely where two code paths
// drift, so both need a test that cares about the answer.
describe('the planner-grid path resolves the same way the ranked path does', () => {
  // One camper's own sheet: day columns, period rows, no name column. The identity
  // comes from the submission, so this lands against a provisional subject.
  const GRID =
    'Period,Monday,Tuesday\n' +
    'Period 1,Swim,Arts and Crafts\n' +
    'Period 2,Arts and Crafts,Archery; Ceramics\n'

  beforeEach(() => seedActivities(['Swim', 'Archery', 'Ceramics', 'Arts & Crafts']))

  it('a mapped label lands under the CAMP\u2019s spelling, on every cell that named it', () => {
    const { parsed, committed } = importThroughPanelPath(GRID, {
      label: 'planner',
      resolutions: [
        { label: 'Arts and Crafts', action: RESOLUTION.MAP_TO_EXISTING, activityName: 'Arts & Crafts' },
      ],
    })
    expect(parsed).not.toBeNull()
    expect(committed.ok).toBe(true)
    const state = dbState()
    expect(state.choiceLabels).toContain('Arts & Crafts')
    expect(state.choiceLabels).not.toContain('Arts and Crafts')
    // BOTH cells that named it, not just the first — one choice, two preferences.
    expect(state.preferences.find((r) => r.label === 'Arts & Crafts')).toEqual({
      label: 'Arts & Crafts',
      n: 2,
    })
    expect(state.activityNames).toEqual(['Archery', 'Arts & Crafts', 'Ceramics', 'Swim'])
  })

  it('a split packed cell lands as its parts, unordered, WITHOUT refusing the sheet', () => {
    const { committed } = importThroughPanelPath(GRID, {
      label: 'planner-split',
      resolutions: [{ label: 'Archery; Ceramics', action: RESOLUTION.SPLIT_PACKED }],
    })
    expect(committed.ok).toBe(true)
    const state = dbState()
    expect(state.choiceLabels).toContain('Archery')
    expect(state.choiceLabels).toContain('Ceramics')
    // RANK NULL, and this test is why the code says so. An ordinary grid cell is
    // CHOSEN at rank 1 (section 4.2), and a first draft gave split parts that same
    // rank — which made two names sit at rank 1 for one camper, tripped the
    // same-rank refusal, and REFUSED THE WHOLE SHEET the director had just resolved.
    // The parts of a packed cell are an unordered set on both paths.
    const ranks = withDb((db) =>
      db
        .prepare(
          `SELECT c.label AS label, p.rank AS rank FROM elective_preferences p
             JOIN elective_choices c ON c.id = p.choice_id
            WHERE c.label IN ('Archery','Ceramics') ORDER BY c.label`
        )
        .all()
    )
    expect(ranks).toEqual([
      { label: 'Archery', rank: null },
      { label: 'Ceramics', rank: null },
    ])
  })
})
