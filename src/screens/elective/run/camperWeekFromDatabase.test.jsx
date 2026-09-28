// @vitest-environment jsdom
//
// T296 — the archive_when clause, proved end to end:
//
//   "a test drives the real screen and asserts the rendered week matches the
//    assignment rows in the database for a camper with at least one unranked
//    placement"
//
// WHAT IS REAL HERE AND WHAT IS NOT, because the clause says "database" and a
// test that says database while reading a hand-written array proves nothing.
// The assignment rows under test are written to a real SQLite file by the real
// commitElectiveRun op, and the EXPECTATIONS below are derived by querying that
// file — not typed out. Reorder two occurrences in the projection, or drop the
// fallback indicator, and the expectation moves with the database while the
// render does not, so the assertion fails.
//
// localClient is stubbed, and that is the architecture rather than a shortcut:
// the renderer never touches SQLite (CLAUDE.md, "Renderer <-> Electron IPC"), so
// the IPC transport is the only seam a jsdom test can stand at. The stub carries
// db-derived rows across it verbatim, in the same shape getElectiveRunHandler
// returns (electron/main.js) — it invents no data.
//
// Fabricated names only: real camper data is refused at a tested gate until
// at-rest encryption ships (T249 / ADR 2026-09-23 Q4).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../../../../electron/db/localDb.js'
import { commitElectiveRun } from '../../../../electron/ops/commitElectiveRun.js'

vi.mock('../../../localClient', () => ({
  localClient: {
    listElectiveRuns: vi.fn(),
    getElectiveRun: vi.fn(),
    setElectiveAssignment: vi.fn(),
    getElectiveRunOuterSchedule: vi.fn(),
    list: vi.fn(),
  },
}))

import { localClient } from '../../../localClient'
import DraftRunView from './DraftRunView.jsx'
import FinalRunView from './FinalRunView.jsx'

// The expected label is spelled out HERE rather than imported from
// camperElectiveWeek.js on purpose. Calling the production function to build the
// expectation would move both sides of the assertion together, so a bug in the
// rank reading — the exact fact this ticket exists for — would render wrong and
// still pass. An independent statement of the mapping is the point of a test.
function expectedRankLabel(preferenceRank) {
  if (preferenceRank == null) return 'Not requested'
  return { 1: 'First choice', 2: 'Second choice', 3: 'Third choice' }[preferenceRank]
    ?? `Choice #${preferenceRank}`
}

const DAYS = [
  { id: 'day-1', label: 'Monday', sort_order: 1 },
  { id: 'day-2', label: 'Tuesday', sort_order: 2 },
]
const TIME_BLOCKS = [
  { id: 'tb-1', name: 'First Period', sort_order: 1 },
  { id: 'tb-2', name: 'Second Period', sort_order: 2 },
]
const ACTIVITIES = [
  { id: 'act-archery', name: 'Archery' },
  { id: 'act-pottery', name: 'Pottery' },
  { id: 'act-gaga', name: 'Gaga' },
]
// THE IDS ARE ADVERSARIAL TO THE ORDERING, deliberately, and the first draft of
// this file was not. getElectiveRunHandler returns rows `ORDER BY
// a.occurrence_id`, so ids whose alphabetical order happens to match the week's
// order make an ordering assertion vacuous — dropping the sort entirely still
// renders correctly and the test still passes. Verified by planting exactly that
// defect: the pure projection test caught it, this one did not.
//
// So: alphabetical id order is occ-a, occ-b, occ-c, while the week runs
// occ-c (Mon 1st), occ-b (Mon 2nd), occ-a (Tue 1st) — the exact reverse.
const OCCURRENCES = [
  { id: 'occ-a', elective_set_id: 'set-1', day_id: 'day-2', time_block_id: 'tb-1', tier_id: 'tier-1' },
  { id: 'occ-b', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-2', tier_id: 'tier-1' },
  { id: 'occ-c', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' },
]

const PARSED = {
  campers: [
    { id: 'cam-1', display_name: 'Testcamper Alpha', external_id: null, division: 'Arad' },
    { id: 'cam-2', display_name: 'Testcamper Bravo', external_id: null, division: 'Arad' },
  ],
  choices: [
    { label: 'Archery', labelKey: 'archery' },
    { label: 'Pottery', labelKey: 'pottery' },
    { label: 'Gaga', labelKey: 'gaga' },
  ],
  // Alpha never ranked Gaga anywhere — that is what makes the Tuesday placement
  // below an unranked one, which the archive_when requires this test to cover.
  preferences: [
    { camper_id: 'cam-1', occurrence_id: 'occ-c', label: 'Archery', labelKey: 'archery', rank: 1 },
    { camper_id: 'cam-1', occurrence_id: 'occ-b', label: 'Pottery', labelKey: 'pottery', rank: 3 },
    { camper_id: 'cam-2', occurrence_id: 'occ-c', label: 'Pottery', labelKey: 'pottery', rank: 1 },
  ],
  sameNameCampers: [],
  skippedRows: [],
}

const ASSIGNMENTS = [
  { camper_id: 'cam-1', occurrence_id: 'occ-c', labelKey: 'archery', activity_id: 'act-archery', preference_rank: 1, flags: [] },
  { camper_id: 'cam-1', occurrence_id: 'occ-b', labelKey: 'pottery', activity_id: 'act-pottery', preference_rank: 3, flags: [] },
  // THE UNRANKED PLACEMENT. The solver filled a period Alpha expressed nothing
  // for; preference_rank lands NULL in the db and the week must say so.
  { camper_id: 'cam-1', occurrence_id: 'occ-a', labelKey: 'gaga', activity_id: 'act-gaga', preference_rank: null, flags: ['NOT_REQUESTED'] },
  { camper_id: 'cam-2', occurrence_id: 'occ-c', labelKey: 'pottery', activity_id: 'act-pottery', preference_rank: 1, flags: [] },
]

const dirs = []
let db
let runId

/** The independent ground truth: one camper's week, straight out of SQLite. */
function weekFromDatabase(camperId) {
  return db
    .prepare(
      `SELECT a.id, a.preference_rank, act.name AS activity_name,
              d.label AS day_label, tb.name AS block_name
         FROM elective_assignments a
         JOIN elective_occurrences o ON o.id = a.occurrence_id
         LEFT JOIN activities act ON act.id = a.activity_id
         LEFT JOIN days_of_operation d ON d.id = o.day_id
         LEFT JOIN time_blocks tb ON tb.id = o.time_block_id
        WHERE a.run_id = ? AND a.camper_id = ?
        ORDER BY d.sort_order, tb.sort_order`
    )
    .all(runId, camperId)
}

/** The rows in the shape getElectiveRunHandler returns them to the renderer. */
function runStateFromDatabase() {
  const rows = db
    .prepare(
      `SELECT a.id, a.occurrence_id, a.camper_id, a.activity_id, a.preference_rank,
              a.source, a.is_locked, c.display_name AS camper_name
         FROM elective_assignments a
         LEFT JOIN campers c ON c.id = a.camper_id
        WHERE a.run_id = ?
        ORDER BY a.occurrence_id, c.display_name`
    )
    .all(runId)
  const occurrences = db
    .prepare('SELECT id, elective_set_id, day_id, time_block_id, tier_id FROM elective_occurrences WHERE run_id = ? ORDER BY id')
    .all(runId)
  return { rows, occurrences, staleCount: 0, finalizedAgainstStaleGeneration: false, overCapacityOccurrences: [] }
}

// `occurrences: []` IS THE PRODUCTION CASE, not a weakened fixture. A director
// reaches a camper's week by opening a saved run from the run list, and
// AssignmentPanel's `occurrences` are React state set only by a fresh solve — so
// the prop really is empty on that path. Every assertion below therefore proves
// the week resolves its days and periods from the run's own database rows
// (getElectiveRunHandler's `occurrences`), which is the only source that is there
// when the director actually looks.
function catalogs() {
  return {
    activities: ACTIVITIES, days: DAYS, timeBlocks: TIME_BLOCKS,
    groups: [], tiers: [{ id: 'tier-1', name: 'Juniors' }], occurrences: [],
    scheduleTemplates: [], scheduleWeeks: [],
  }
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-t296-'))
  dirs.push(dir)
  db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  for (const d of DAYS) {
    db.prepare('INSERT INTO days_of_operation (id, camp_id, label, sort_order) VALUES (?, ?, ?, ?)')
      .run(d.id, campId, d.label, d.sort_order)
  }
  for (const t of TIME_BLOCKS) {
    db.prepare('INSERT INTO time_blocks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .run(t.id, campId, t.name, t.sort_order)
  }
  for (const a of ACTIVITIES) {
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(a.id, campId, a.name)
  }

  const out = commitElectiveRun(db, {
    campId, deviceId: 'dev-1', name: 'Elective assignment — 2026-09-28',
    parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCES,
  })
  expect(out.ok).toBe(true)
  runId = out.runId

  // The fixture is only interesting if the db really holds an unranked row.
  const unranked = db
    .prepare('SELECT COUNT(*) c FROM elective_assignments WHERE run_id = ? AND camper_id = ? AND preference_rank IS NULL')
    .get(runId, 'cam-1').c
  expect(unranked).toBe(1)

  localClient.getElectiveRun.mockResolvedValue(runStateFromDatabase())
  localClient.list.mockResolvedValue([])
  localClient.getElectiveRunOuterSchedule.mockResolvedValue({ rows: [] })
})

afterEach(() => {
  db?.close()
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
  vi.clearAllMocks()
})

function runRow(status) {
  return {
    id: runId, name: 'Elective assignment — 2026-09-28', status,
    source_filename: 'fabricated-camper-preferences-a.csv', tier_id: 'tier-1',
  }
}

async function openCamperWeek(view, camperId) {
  render(view)
  const opener = await screen.findByTestId(`camper-week-open-${camperId}`)
  fireEvent.click(opener)
  return await screen.findByTestId('camper-week')
}

/**
 * The clause itself. Every expected value is read out of SQLite, in the order
 * SQLite says the week runs; nothing here is typed by hand.
 */
async function assertRenderedWeekMatchesDatabase(view, camperId) {
  const expected = weekFromDatabase(camperId)
  expect(expected.length).toBeGreaterThan(0)

  // THE ORDERING ASSERTION BELOW IS ONLY WORTH ANYTHING IF THESE TWO DISAGREE.
  // The rows reach the screen in getElectiveRunHandler's order (by occurrence
  // id); the week must come out in day/period order. If a later fixture edit
  // makes those coincide, the assertion silently stops testing ordering — so
  // fail here, loudly, rather than pass for the wrong reason.
  const asDelivered = runStateFromDatabase().rows.filter((r) => r.camper_id === camperId).map((r) => r.id)
  expect(asDelivered).not.toEqual(expected.map((r) => r.id))

  const week = await openCamperWeek(view, camperId)

  const rendered = within(week).getAllByTestId(/^camper-week-row-/)
  expect(rendered).toHaveLength(expected.length)

  rendered.forEach((node, i) => {
    const row = expected[i]
    expect(node.getAttribute('data-testid')).toBe(`camper-week-row-${row.id}`)

    const when = within(node).getByTestId(`camper-week-when-${row.id}`).textContent
    expect(when).toBe(`${row.day_label} · ${row.block_name}`)
    // Named separately from the equality above so the failure reads as what it
    // is: with no occurrence rows to resolve against, the week degrades to
    // printing ids, which is what the run-list path did before getElectiveRun
    // returned them.
    expect(when).not.toMatch(/^occ-/)

    expect(within(node).getByTestId(`camper-week-activity-${row.id}`).textContent)
      .toBe(row.activity_name)
    expect(within(node).getByTestId(`camper-week-rank-${row.id}`).textContent)
      .toBe(expectedRankLabel(row.preference_rank))
    // The row is MARKED as a fallback, not merely labelled — the chrome is what
    // a director reads at a glance, and it must track the database column.
    expect(node.getAttribute('data-fallback')).toBe(String(row.preference_rank == null))
  })
  return { week, expected }
}

describe('T296 — one camper’s elective week, on screen, from the database', () => {
  it('renders on the Final run screen the week the database holds, for a camper with an unranked placement', async () => {
    const { expected } = await assertRenderedWeekMatchesDatabase(
      <FinalRunView run={runRow('final')} campers={PARSED.campers} {...catalogs()} />,
      'cam-1'
    )
    // Guards the fixture, so this test cannot pass on a week with no fallback
    // in it — the case the archive_when singles out.
    expect(expected.filter((r) => r.preference_rank == null)).toHaveLength(1)
  })

  it('renders the same week on the Draft run screen', async () => {
    await assertRenderedWeekMatchesDatabase(
      <DraftRunView run={runRow('draft')} {...catalogs()} />,
      'cam-1'
    )
  })

  // The ticket's headline fact, asserted against a literal rather than through
  // expectedRankLabel, so the exact words a director reads are pinned in one
  // place that does not move with any helper.
  it('names the unranked placement “Not requested” and marks its row', async () => {
    const week = await openCamperWeek(<FinalRunView run={runRow('final')} campers={PARSED.campers} {...catalogs()} />, 'cam-1')
    const fallbackId = db
      .prepare('SELECT id FROM elective_assignments WHERE run_id = ? AND camper_id = ? AND preference_rank IS NULL')
      .get(runId, 'cam-1').id

    expect(within(week).getByTestId(`camper-week-rank-${fallbackId}`).textContent).toBe('Not requested')
    expect(within(week).getByTestId(`camper-week-row-${fallbackId}`).getAttribute('data-fallback')).toBe('true')
  })

  it('shows a camper whose whole week was ranked with no fallback row', async () => {
    const week = await openCamperWeek(<FinalRunView run={runRow('final')} campers={PARSED.campers} {...catalogs()} />, 'cam-2')
    const rows = within(week).getAllByTestId(/^camper-week-row-/)
    expect(rows).toHaveLength(weekFromDatabase('cam-2').length)
    expect(rows.every((r) => r.getAttribute('data-fallback') === 'false')).toBe(true)
  })

  it('offers every camper the run placed, and does not replace the screen it sits under', async () => {
    render(<DraftRunView run={runRow('draft')} {...catalogs()} />)
    await screen.findByTestId('camper-week-open-cam-1')
    expect(screen.getByTestId('camper-week-open-cam-2')).toBeTruthy()

    fireEvent.click(screen.getByTestId('camper-week-open-cam-1'))
    await screen.findByTestId('camper-week')
    // The Draft screen's own move/lock table is still there: this view sits
    // BESIDE the occurrence-shaped one, never over it (T296 notes).
    const dbRows = runStateFromDatabase().rows
    expect(screen.getByTestId(`placement-row-${dbRows[0].id}`)).toBeTruthy()
    expect(screen.getByTestId('run-satisfaction-summary')).toBeTruthy()
  })

  it('closes back to the camper list without unmounting the run screen', async () => {
    render(<FinalRunView run={runRow('final')} campers={PARSED.campers} {...catalogs()} />)
    fireEvent.click(await screen.findByTestId('camper-week-open-cam-1'))
    await screen.findByTestId('camper-week')
    fireEvent.click(screen.getByTestId('camper-week-close'))
    await waitFor(() => expect(screen.queryByTestId('camper-week')).toBeNull())
    expect(screen.getByTestId('camper-week-open-cam-1')).toBeTruthy()
    expect(screen.getByTestId('run-identity')).toBeTruthy()
  })
})
