// @vitest-environment node
//
// T285 — THE DIRECTOR'S IMPORT PATH, which none of this program's measurement ever
// touched.
//
// `AssignmentPanel.jsx` called `parsePreferenceSheet(rows, { campId, mapping })`
// with `inferPreferenceMapping(rows[0])` — no catalog, no grid, no subject, no
// header locator. So in the app a director actually uses:
//
//   * the header locator never ran (a title row above the table still broke it);
//   * `catalogAbsent` was always true, disabling the junk-row fix, making the
//     inverted-matrix adapter unreachable, and marking every division unmatched and
//     every label unverified;
//   * the planner-grid path — the headline "18 per-cell preferences" — could not
//     fire at all;
//   * and `residue` was rendered nowhere, so §3.4's loud half was invisible.
//
// **Every number this program produced described `scripts/preferenceSheetCli.js`,
// not the product.** These tests enter at FILE BYTES through the PANEL'S OWN call
// shape (`readPreferenceSheet`, the module both entry points now share) and assert
// at the DATABASE, so the numbers finally describe what a director gets.
//
// The shared call shape is the point. ADR §3.2: T224 happened because one path
// reached extraction without passing through the gate the other used — and a second
// set of ARGUMENTS is a second T224 even when the transform underneath is shared.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { openLocalDb } from '../electron/db/localDb.js'
import { commitElectiveRun } from '../electron/ops/commitElectiveRun.js'
import { buildPreferenceCatalog, readPreferenceSheet } from '../src/ingest/preferenceImport.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROBES = path.join(ROOT, 'test/fixtures/preference-corpus/probes')

const CORPUS_ACTIVITIES = [
  'Swim', 'Archery', 'Ceramics', 'Woodworking', 'Basketball', 'Drama', 'Nature',
  'Photography', 'Rock Climbing', 'Gaga', 'Dance', 'Cooking', 'Soccer', 'Tennis',
  'Arts And Crafts', 'Sailing', 'Yoga', 'Fishing', 'Hockey', 'Music',
]

let dir
let dbPath
let campId
let deviceId

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-panel-'))
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

function seed(table, names) {
  withDb((db) => {
    const insert = db.prepare(`INSERT INTO ${table} (id, camp_id, name) VALUES (?, ?, ?)`)
    for (const n of names) insert.run(randomUUID(), campId, n)
  })
}

/** What the panel holds as props, read the way the panel reads it. */
function collections() {
  return withDb((db) => ({
    activities: db.prepare('SELECT id, name FROM activities WHERE camp_id = ?').all(campId),
    groups: db.prepare('SELECT id, name FROM groups WHERE camp_id = ?').all(campId),
    tiers: db.prepare('SELECT id, name FROM tiers WHERE camp_id = ?').all(campId),
  }))
}

/**
 * FILE BYTES -> the panel's read -> commit -> database.
 *
 * `readRows` mirrors AssignmentPanel's own CSV branch (split on newline, then tab or
 * comma) rather than the CLI's SheetJS path, so this exercises the panel's reading
 * as well as its call shape.
 */
function importThroughPanelPath(bytes, { camperName = null, label = 'sheet', withCatalog = true } = {}) {
  const file = path.join(dir, `${label}.csv`)
  fs.writeFileSync(file, bytes)
  const rows = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((line) => line.split(/\t|,/).map((c) => c.trim()))

  const catalog = withCatalog ? buildPreferenceCatalog(collections()) : buildPreferenceCatalog({})
  const { mapping, parsed } = readPreferenceSheet({
    rows,
    campId,
    catalog,
    camperName,
    sourceLabel: label,
    submissionKey: `sub-${label}-${bytes.length}`,
    // T299 — WHICH IMPORT this is. Stable per label so one label is one import:
    // these cases each import once, and pinning it keeps them asserting about
    // resolution rather than about identity. Two arrivals of identical content are
    // covered where they belong, in
    // electron/ops/commitElectiveRun.identicalSubmissions.test.js.
    arrivalId: `arrive-${label}`,
  })
  if (!parsed) return { mapping, parsed: null, committed: null }

  const committed = withDb((db) =>
    commitElectiveRun(db, {
      campId,
      deviceId,
      name: 'Panel import',
      parsed,
      assignments: [],
      occurrences: [],
    })
  )
  return { mapping, parsed, committed }
}

const residueOf = (parsed, kind) => (parsed?.residue ?? []).filter((r) => r.kind === kind)

describe('the panel path locates a header that is not row 1', () => {
  const SHEET =
    'Activity Selection\n' +
    'Upper Division,Summer\n' +
    'Camper Name,Division,#1,#2\n' +
    'Ari Feldspar,Upper Division,Swim,Archery\n' +
    'Noa Quartzite,Lower Division,Ceramics,Nature\n'

  it('parses it — which the panel could not do at all before', () => {
    // `inferPreferenceMapping(rows[0])` took row 0 unconditionally, so row 0 here is
    // the title "Activity Selection": no name column, no ranks, and the whole file
    // was "not a camper preference sheet".
    seed('activities', CORPUS_ACTIVITIES)

    const { parsed, committed } = importThroughPanelPath(SHEET)
    expect(parsed).not.toBeNull()
    expect(committed.ok).toBe(true)

    const names = withDb((db) =>
      db.prepare('SELECT display_name FROM campers ORDER BY display_name').all().map((r) => r.display_name)
    )
    expect(names).toEqual(['Ari Feldspar', 'Noa Quartzite'])
    // The junk above the header did not become campers.
    expect(names).not.toContain('Activity Selection')
    expect(residueOf(parsed, 'SKIPPED_PREAMBLE')).toHaveLength(1)
  })
})

describe('the panel path resolves against the camp catalog', () => {
  it('a division that matches a group resolves, and one that does not is residue', () => {
    // Without a catalog every division was UNMATCHED and every label UNVERIFIED —
    // the resolvers were structurally disabled in the product.
    seed('activities', CORPUS_ACTIVITIES)
    seed('groups', ['Upper Division'])

    const { parsed, committed } = importThroughPanelPath(
      'Camper Name,Division,#1,#2\n' +
        'Ari Feldspar,Upper Division,Swim,Archery\n' +
        'Noa Quartzite,A Division Nobody Has,Ceramics,Nature\n'
    )
    expect(committed.ok).toBe(true)

    const rows = withDb((db) =>
      db.prepare('SELECT display_name, division_label, group_id FROM campers ORDER BY display_name').all()
    )
    expect(rows[0].group_id).not.toBeNull() // Ari, matched
    expect(rows[1].group_id).toBeNull() // Noa, unmatched
    expect(rows[1].division_label).toBe('A Division Nobody Has') // kept verbatim
    expect(residueOf(parsed, 'UNMATCHED_DIVISION')).toHaveLength(1)
    // And nothing was CREATED from the file.
    expect(withDb((db) => db.prepare('SELECT COUNT(*) c FROM groups').get().c)).toBe(1)
  })

  it('a junk footer row is skipped rather than made a camper', () => {
    seed('activities', CORPUS_ACTIVITIES)
    const { parsed, committed } = importThroughPanelPath(
      'Camper Name,#1,#2\nAri Feldspar,Swim,Archery\nTotal Campers,8,\n'
    )
    expect(committed.ok).toBe(true)
    const names = withDb((db) => db.prepare('SELECT display_name FROM campers').all().map((r) => r.display_name))
    expect(names).toEqual(['Ari Feldspar'])
    expect(parsed.skippedRows.some((s) => s.reason === 'no rank cell names a known activity')).toBe(true)
  })

  it('an unresolvable label is residue and is NOT written', () => {
    seed('activities', ['Swim'])
    const { parsed, committed } = importThroughPanelPath(
      'Camper Name,#1,#2\nAri Feldspar,Swim,Underwater Basket Weaving\n'
    )
    expect(committed.ok).toBe(true)
    const labels = withDb((db) => db.prepare('SELECT label FROM elective_choices').all().map((r) => r.label))
    expect(labels).toEqual(['Swim'])
    expect(residueOf(parsed, 'UNRESOLVED_CHOICE_LABEL').map((r) => r.label)).toContain(
      'Underwater Basket Weaving'
    )
  })

  it('NON-VACUITY: with no catalog the resolvers abstain and the fixes are disabled', () => {
    // This is exactly the pre-fix state of the panel, and it must be visibly
    // different — otherwise passing the catalog proves nothing.
    seed('activities', CORPUS_ACTIVITIES)
    const { parsed } = importThroughPanelPath(
      'Camper Name,#1,#2\nAri Feldspar,Swim,Archery\nTotal Campers,8,\n',
      { withCatalog: false }
    )
    // The junk row is NOT skipped for want of a catalog to resolve against...
    expect(parsed.skippedRows.some((s) => s.reason === 'no rank cell names a known activity')).toBe(false)
    // ...and every label comes back unverified.
    expect(residueOf(parsed, 'UNVERIFIED_CHOICE_LABEL').length).toBeGreaterThan(0)
  })
})

describe('the panel path reads a planner grid', () => {
  it('P19: lands one row per elective cell, with coordinates, for one subject', () => {
    // THE HEADLINE THE PRODUCT COULD NOT REACH. Without `grid` and `subject` the
    // panel had no planner path at all.
    seed('activities', CORPUS_ACTIVITIES)
    const bytes = fs.readFileSync(path.join(PROBES, 'P19-planner-grid.csv'), 'utf8')

    const { parsed, committed } = importThroughPanelPath(bytes, { label: 'P19-planner-grid' })
    expect(parsed).not.toBeNull()
    expect(committed.ok).toBe(true)

    expect(withDb((db) => db.prepare('SELECT COUNT(*) c FROM campers').get().c)).toBe(1)
    const rows = withDb((db) =>
      db
        .prepare(
          `SELECT p.coordinate_day_label AS day, p.coordinate_period_label AS period, ch.label
             FROM elective_preferences p JOIN elective_choices ch ON ch.id = p.choice_id`
        )
        .all()
    )
    expect(rows).toHaveLength(18)
    const at = (d, pd) => rows.find((r) => r.day === d && r.period === pd)
    expect(at('Monday', 'Period 4').label).toBe('Swim')
    expect(at('Friday', 'Period 3').label).toBe('Music')

    // And the subject is flagged, so it reaches the attention surface.
    expect(withDb((db) => db.prepare('SELECT is_unattributed FROM campers').get().is_unattributed)).toBe(1)
    expect(residueOf(parsed, 'UNATTRIBUTED_SUBJECT')).toHaveLength(1)
  })

  it('a caller-supplied camper name attributes the grid immediately', () => {
    seed('activities', CORPUS_ACTIVITIES)
    const bytes = fs.readFileSync(path.join(PROBES, 'P19-planner-grid.csv'), 'utf8')
    const { committed } = importThroughPanelPath(bytes, { camperName: 'Dalia Tuff' })
    expect(committed.ok).toBe(true)
    const camper = withDb((db) => db.prepare('SELECT display_name, is_unattributed FROM campers').get())
    expect(camper.display_name).toBe('Dalia Tuff')
    expect(camper.is_unattributed).toBeNull()
  })

  it('P23: BOTH the ranked block and the grid land through the panel', () => {
    seed('activities', CORPUS_ACTIVITIES)
    const bytes = fs.readFileSync(path.join(PROBES, 'P23-grid-plus-ranked-fallback.csv'), 'utf8')
    const { committed } = importThroughPanelPath(bytes, { label: 'P23' })
    expect(committed.ok).toBe(true)
    expect(committed.counts.preferences).toBe(38)
    expect(withDb((db) => db.prepare('SELECT COUNT(*) c FROM campers').get().c)).toBe(5)
  })
})

describe('the panel path never refuses a readable file', () => {
  it('an offerings menu is read, writes nothing, and says why', () => {
    seed('activities', CORPUS_ACTIVITIES)
    const bytes = fs.readFileSync(path.join(PROBES, 'P22-offerings-menu-pref.csv'), 'utf8')
    const { parsed } = importThroughPanelPath(bytes, { label: 'P22' })
    // Read as a grid, and held back on ARITY — several activities per period is a
    // menu of options, not one camper's choices.
    expect(parsed).not.toBeNull()
    expect(parsed.preferences).toHaveLength(0)
    expect(parsed.campers).toHaveLength(0)
    expect(residueOf(parsed, 'MULTIPLE_OPTIONS_PER_PERIOD')).toHaveLength(1)
  })

  it('a sheet with no camper column and no grid is reported, not thrown away', () => {
    seed('activities', CORPUS_ACTIVITIES)
    const out = importThroughPanelPath('Who,Thing A\nsomebody,something\n')
    // `parsed: null` means "no table here reads as a preference sheet" — the caller
    // reports it and writes nothing. It is NOT a refusal of the file.
    expect(out.parsed).toBeNull()
    expect(out.mapping.unmapped.length).toBeGreaterThan(0)
  })
})
