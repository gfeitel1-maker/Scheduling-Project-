// @vitest-environment node
//
// T314 — A DIRECTOR'S WORKBOOK IS READ WHICHEVER TAB THE TABLE IS ON.
//
// Owner ruling 2026-09-29: "a director who has two tabs on an import won't get their thing read.
// that is fucking absurd. and should be a fix."
//
// The panel's `readSheetRows` returned `sheets[0]?.rows` while the CLI classified every tab, so half
// of T313's choke point was still two rules. Two distinct failures came out of that, and the second
// is the worse one:
//
//   * notes on tab 1 -> `parsed: null`, and the director is told "That file does not read as a camper
//     preference sheet" about a file that plainly does;
//   * an offerings MENU on tab 1 -> read as one camper's own planner, so the import SUCCEEDS, mints a
//     phantom unattributed camper named after the FILE, and never touches the real table. Two real
//     children silently not imported, one row belonging to nobody created.
//
// These enter at WORKBOOK BYTES and assert on camper rows in the database, because the claim is about
// what a director ends up with, not about which function returned what.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'

import { openLocalDb } from '../electron/db/localDb.js'
import { commitElectiveRun } from '../electron/ops/commitElectiveRun.js'
import {
  buildPreferenceCatalog,
  readPreferenceSheet,
  selectPreferenceSheet,
} from '../src/ingest/preferenceImport.js'
import { readWorkbookRows } from '../src/utils/exportSanitize.js'

const ACTIVITIES = ['Swim', 'Archery', 'Ceramics', 'Nature']

// The real table: a row per camper, ranked columns. Two DIFFERENT children, so a merge or a miss is
// visible by name rather than only by count.
const TABLE = [
  ['Camper Name', 'Division', '#1', '#2'],
  ['Ari Feldspar', 'Upper Division', 'Swim', 'Archery'],
  ['Noa Quartzite', 'Upper Division', 'Ceramics', 'Nature'],
]

// An offerings MENU — what is ON OFFER, not what anyone chose. Same day x period shape as a camper's
// own planner, which is exactly why only the declared kind can separate them (ADR §3.3) and why
// reading tab 1 blindly mints a camper out of it.
const MENU = [
  ['Period', 'Monday', 'Tuesday'],
  ['Period 1', 'Swim', 'Archery'],
  ['Period 2', 'Ceramics', 'Nature'],
]

// A cover tab. Not a table at all — this is the plain "imports nothing" case.
const NOTES = [['Please return by June 1'], ['Questions? Call the camp office']]

let dir
let dbPath
let campId
let deviceId

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-tabs-'))
  dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  campId = randomUUID()
  deviceId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Host')
  const insert = db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)')
  for (const name of ACTIVITIES) insert.run(randomUUID(), campId, name)
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

/** A real .xlsx workbook, as a camp's export tool would produce it. */
function workbook(tabs) {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of tabs) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

const catalog = () =>
  buildPreferenceCatalog(
    withDb((db) => ({
      activities: db.prepare('SELECT id, name FROM activities WHERE camp_id = ?').all(campId),
      groups: [],
      tiers: [],
    }))
  )

/**
 * WORKBOOK BYTES -> the panel's read -> commit -> database.
 *
 * Mirrors `AssignmentPanel.onFileSelected` -> `confirmMapping`: read every sheet with the shared
 * reader, SELECT one with the shared rule, parse it, merge the unread-tab residue, commit.
 */
function importThroughPanel(bytes, { label = 'book' } = {}) {
  const sheets = readWorkbookRows(bytes, { type: 'buffer', byteLength: bytes.length })
  const cat = catalog()
  const { selected, unread } = selectPreferenceSheet({ sheets, catalog: cat })
  const { parsed } = readPreferenceSheet({
    rows: selected?.sheet.rows ?? [],
    campId,
    catalog: cat,
    sourceLabel: label,
    arrivalId: `arrive-${label}`,
  })
  if (!parsed) return { selected, unread, parsed: null, committed: null }
  const residue = [...unread, ...parsed.residue]
  const committed = withDb((db) =>
    commitElectiveRun(db, { campId, deviceId, name: 'Panel import', parsed, assignments: [], occurrences: [] })
  )
  return { selected, unread, parsed: { ...parsed, residue }, committed }
}

const camperNames = () =>
  withDb((db) =>
    db.prepare('SELECT display_name FROM campers WHERE camp_id = ? ORDER BY display_name').all(campId)
      .map((r) => r.display_name)
  )

describe('a preference table is read whichever tab it is on', () => {
  it('notes on tab 1, table on tab 2: the table imports', () => {
    // THE OWNER'S CASE. Before this, `parsed` was null and the director was told the file "does not
    // read as a camper preference sheet".
    const { committed } = importThroughPanel(workbook([['Read Me', NOTES], ['Preferences', TABLE]]))
    expect(committed.ok).toBe(true)
    expect(camperNames()).toEqual(['Ari Feldspar', 'Noa Quartzite'])
  })

  it('an offerings MENU on tab 1 does not become a phantom camper named after the file', () => {
    // THE WORSE CASE, and the reason this is a defect rather than an inconvenience: the menu is a
    // day x period grid, so tab 1 read as one camper's own planner. The import SUCCEEDED, created an
    // unattributed camper called `book`, and left both real children out.
    const { committed } = importThroughPanel(workbook([['Offerings', MENU], ['Preferences', TABLE]]))
    expect(committed.ok).toBe(true)

    const names = camperNames()
    expect(names).toEqual(['Ari Feldspar', 'Noa Quartzite'])
    // Stated separately from the equality above, because this is the assertion whose FAILURE is the
    // defect rather than a symptom of it.
    expect(names).not.toContain('book')
    expect(withDb((db) =>
      db.prepare('SELECT COUNT(*) AS n FROM campers WHERE is_unattributed = 1').get().n
    )).toBe(0)
  })

  it('NO REGRESSION: table on tab 1 still imports exactly as before', () => {
    const { committed } = importThroughPanel(workbook([['Preferences', TABLE], ['Notes', NOTES]]))
    expect(committed.ok).toBe(true)
    expect(camperNames()).toEqual(['Ari Feldspar', 'Noa Quartzite'])
  })

  it('the table is found on a LATER tab too, not just the second', () => {
    // Guards a fix that special-cases `sheets[1]` instead of classifying.
    const { committed, selected } = importThroughPanel(
      workbook([['Read Me', NOTES], ['Offerings', MENU], ['Signatures', NOTES], ['Preferences', TABLE]])
    )
    expect(committed.ok).toBe(true)
    expect(selected.sheet.name).toBe('Preferences')
    expect(camperNames()).toEqual(['Ari Feldspar', 'Noa Quartzite'])
  })
})

describe('the director is told which tabs were not read', () => {
  it('names every unread tab, with its row count', () => {
    const { parsed } = importThroughPanel(workbook([['Read Me', NOTES], ['Preferences', TABLE], ['Notes', NOTES]]))
    const unread = parsed.residue.filter((r) => r.kind === 'UNREAD_SHEET')
    expect(unread.map((r) => r.sheet).sort()).toEqual(['Notes', 'Read Me'])
    // The tab that WAS read is never reported as unread.
    expect(unread.map((r) => r.sheet)).not.toContain('Preferences')
    // A row count, so a director can tell a cover note from a second set of submissions.
    expect(unread.every((r) => typeof r.rows === 'number')).toBe(true)
    // And words, not a kind: `residueParts` fills head/why for the rendered list.
    expect(unread[0].head).toMatch(/Tab/)
    expect(unread[0].why).toMatch(/not read/i)
  })

  it('says nothing about unread tabs when there is only one tab', () => {
    // NON-VACUITY for the assertion above: it must be reporting the workbook's actual shape rather
    // than emitting a fixed item.
    const { parsed } = importThroughPanel(workbook([['Preferences', TABLE]]))
    expect(parsed.residue.filter((r) => r.kind === 'UNREAD_SHEET')).toEqual([])
  })
})

describe('selectPreferenceSheet — the one rule both doors use', () => {
  it('prefers a cleanly-mapping TABLE over a grid, wherever each sits', () => {
    const sheets = readWorkbookRows(workbook([['Offerings', MENU], ['Preferences', TABLE]]), { type: 'buffer' })
    const { selected, kind } = selectPreferenceSheet({ sheets, catalog: catalog() })
    expect(selected.sheet.name).toBe('Preferences')
    expect(kind).toBe('table')
  })

  it('falls back to a GRID when no tab names a camper — a lone planner still imports', () => {
    const sheets = readWorkbookRows(workbook([['Read Me', NOTES], ['Week', MENU]]), { type: 'buffer' })
    const { selected, kind } = selectPreferenceSheet({ sheets, catalog: catalog() })
    expect(selected.sheet.name).toBe('Week')
    expect(kind).toBe('grid')
  })

  it('selects nothing when no tab is readable, and reports no unread tabs', () => {
    // Selecting nothing is a first-class outcome: ADR §14.1 forbids refusing a readable file, and the
    // caller reports what it could not resolve instead. Reporting tabs as "unread" here would be
    // false — none was read, so there is no "instead".
    const sheets = readWorkbookRows(workbook([['Read Me', NOTES], ['Notes', NOTES]]), { type: 'buffer' })
    const { selected, kind, unread } = selectPreferenceSheet({ sheets, catalog: catalog() })
    expect(selected).toBeNull()
    expect(kind).toBeNull()
    expect(unread).toEqual([])
  })

  it('a tab that maps cleanly but has only a header is not chosen', () => {
    // The CLI's own `rows.length >= 2` guard, kept: a header with no body is not a submission.
    const sheets = readWorkbookRows(workbook([['Empty', [TABLE[0]]], ['Preferences', TABLE]]), { type: 'buffer' })
    expect(selectPreferenceSheet({ sheets, catalog: catalog() }).selected.sheet.name).toBe('Preferences')
  })
})
