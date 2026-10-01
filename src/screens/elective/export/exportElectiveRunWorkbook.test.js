// T197 §5 — XLSX workbook. Every sheet MUST go through aoaToSanitizedSheet (src/utils/
// exportSanitize.js); camper names, activity names, and choice labels are user-controlled strings
// and must not bypass the formula-injection sanitizer.
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { buildElectiveRunWorkbook } from './exportElectiveRunWorkbook.js'

function fixture(camperName = 'Camper A') {
  const run = { id: 'run-1', name: 'Week 1', status: 'final', solver_generation: 'gen-1', source_sha256: 'abc' }
  const campers = [{ id: 'c1', display_name: camperName, group_id: 'g1' }]
  const groups = [{ id: 'g1', name: 'Bunk Alpha' }]
  const days = [{ id: 'd1', name: 'Monday' }]
  const timeBlocks = [{ id: 't1', name: 'Period 1' }]
  // No camperName/groupId on the outer row — real rows never carry them (F1, round 2); camper
  // display name comes from `campers` via camperId.
  const outerRows = [
    { camperId: 'c1', dayId: 'd1', timeBlockId: 't1', cellKind: 'elective', activityId: 'a1', activityName: 'Archery', spanBlocks: 1, isLinkedChoice: false },
  ]
  const preferences = [{ camper_id: 'c1', choice_id: 'ch1' }]
  const assignments = [{ camper_id: 'c1', occurrence_id: 'occ-1', preference_rank: 1 }]
  const occurrences = [{ id: 'occ-1', day_id: 'd1', time_block_id: 't1' }]
  return { run, campers, groups, days, timeBlocks, outerRows, preferences, assignments, occurrences, staleCount: 0, capacityRows: [] }
}

function cellsOf(sheet) {
  const values = []
  for (const key of Object.keys(sheet)) {
    if (key.startsWith('!')) continue
    values.push(sheet[key].v)
  }
  return values
}

describe('buildElectiveRunWorkbook', () => {
  it('builds Child Schedules, Activity Roster, Exceptions, Summary sheets', () => {
    const workbook = buildElectiveRunWorkbook(fixture())
    expect(workbook.SheetNames).toEqual(['Child Schedules', 'Activity Roster', 'Exceptions', 'Summary'])
  })

  it('a plain camper name appears unescaped in the Child Schedules sheet', () => {
    const workbook = buildElectiveRunWorkbook(fixture('Camper A'))
    const sheet = workbook.Sheets['Child Schedules']
    expect(cellsOf(sheet)).toContain('Camper A')
  })

  it('a formula-injection camper name is sanitized (escaped with a leading apostrophe), not written live', () => {
    const payload = "=cmd|'/c calc'!A1"
    const workbook = buildElectiveRunWorkbook(fixture(payload))
    const sheet = workbook.Sheets['Child Schedules']
    const values = cellsOf(sheet)
    // The raw payload must never appear as a live formula-triggering cell value.
    expect(values).not.toContain(payload)
    expect(values).toContain(`'${payload}`)
  })

  it('the Activity Roster sheet also sanitizes a formula-injection activity name', () => {
    const payload = '+SUM(A1:A9)'
    const fx = fixture()
    fx.outerRows[0].activityName = payload
    const workbook = buildElectiveRunWorkbook(fx)
    const sheet = workbook.Sheets['Activity Roster']
    const values = cellsOf(sheet)
    expect(values).not.toContain(payload)
    expect(values).toContain(`'${payload}`)
  })

  // T318 (c4) — the Summary sheet's "Rank N: count" rows must never include a
  // camper whose sheet was read as an unordered set; that camper's real, ETL-
  // written integer rank belongs in a separate "One of their choices" row,
  // shown only when there is at least one such camper.
  it('adds a "One of their choices" Summary row when unordered_count > 0, using the same words the screen uses', () => {
    const fx = fixture()
    fx.assignments = [{ camper_id: 'c1', choice_id: 'ch1', occurrence_id: 'occ-1', preference_rank: 1 }]
    fx.preferences = [{ camper_id: 'c1', choice_id: 'ch1', occurrence_id: 'occ-1', rank: 1, rank_kind: 'unordered-set' }]
    const workbook = buildElectiveRunWorkbook(fx)
    const sheet = workbook.Sheets['Summary']
    expect(cellsOf(sheet)).toContain('One of their choices')
  })

  it('omits the "One of their choices" row when unordered_count is 0', () => {
    const fx = fixture()
    fx.assignments = [{ camper_id: 'c1', choice_id: 'ch1', occurrence_id: 'occ-1', preference_rank: 1 }]
    fx.preferences = [{ camper_id: 'c1', choice_id: 'ch1', occurrence_id: 'occ-1', rank: 1, rank_kind: 'cell-choice' }]
    const workbook = buildElectiveRunWorkbook(fx)
    const sheet = workbook.Sheets['Summary']
    expect(cellsOf(sheet)).not.toContain('One of their choices')
  })

  it('every sheet is built via aoaToSanitizedSheet — plants a defect NOT named in the sanitizer description: a leading-tab injection payload', () => {
    // The sanitizer's own header comment names =, +, -, @ and control chars; this plants a
    // leading-CARRIAGE-RETURN payload (a control char the sanitizer's regex also covers) to prove
    // the guard catches more than just the headline '=' case.
    const payload = '\rNOTES'
    const fx = fixture(payload)
    const workbook = buildElectiveRunWorkbook(fx)
    const values = cellsOf(workbook.Sheets['Child Schedules'])
    expect(values).not.toContain(payload)
    expect(values).toContain(`'${payload}`)
  })

  // ORGANIZER RULING — count ONCE on the anchor row, each member row shows its
  // OWN day. Pins the actual rendered SHEET CELLS (not the intermediate JS
  // object), via sheet_to_json row access, so a reconciliation break between
  // the builder and the AOA writer would be caught here too.
  // Round 3 correction (F1, Verifier BLOCKING) — a clustered member contributes
  // ONE ROSTER ROW PER OCCURRENCE, each carrying that occurrence's own day/time
  // block; a joined cell ("Monday, Wednesday") broke the JSON<->XLSX parity
  // invariant (§6(11)'s acceptance test), since both artifacts are built from
  // this one export.
  it('Activity Roster: Count is populated on the FIRST physical row of the group only, and each bundle OCCURRENCE is its own row with its OWN day/time block', () => {
    const fx = fixture()
    fx.campers = [
      { id: 'c1', display_name: 'Camper A', group_id: 'g1' },
      { id: 'c2', display_name: 'Camper B', group_id: 'g1' },
    ]
    fx.days = [{ id: 'd1', name: 'Monday' }, { id: 'd2', name: 'Wednesday' }]
    fx.timeBlocks = [{ id: 't1', name: 'Period 1' }]
    // c1 attends BOTH bundle days; c2 attends only the first — a linked choice
    // cluster whose two members genuinely show different days.
    fx.outerRows = [
      { camperId: 'c1', dayId: 'd1', timeBlockId: 't1', cellKind: 'elective', activityId: 'a1', activityName: 'Ropes', isLinkedChoice: true, choiceId: 'ch-bundle', choiceLabel: 'Ropes' },
      { camperId: 'c1', dayId: 'd2', timeBlockId: 't1', cellKind: 'elective', activityId: 'a1', activityName: 'Ropes', isLinkedChoice: true, choiceId: 'ch-bundle', choiceLabel: 'Ropes' },
      { camperId: 'c2', dayId: 'd1', timeBlockId: 't1', cellKind: 'elective', activityId: 'a1', activityName: 'Ropes', isLinkedChoice: true, choiceId: 'ch-bundle', choiceLabel: 'Ropes' },
    ]
    const workbook = buildElectiveRunWorkbook(fx)
    const sheet = workbook.Sheets['Activity Roster']
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true })
    const header = rows[0]
    expect(header).toEqual(['Day', 'Time Block', 'Activity', 'Camper', 'Group', 'Count', 'Capacity'])

    const dayIdx = header.indexOf('Day')
    const camperIdx = header.indexOf('Camper')
    const countIdx = header.indexOf('Count')
    const body = rows.slice(1)
    const c1Rows = body.filter((r) => r[camperIdx] === 'Camper A')
    const c2Rows = body.filter((r) => r[camperIdx] === 'Camper B')

    // Camper A gets TWO rows (one per occurrence); Camper B gets one.
    expect(c1Rows).toHaveLength(2)
    expect(c2Rows).toHaveLength(1)

    // Count: the FIRST physical row of the whole group only — assignment
    // grain (3), not member/row count (3 rows, which happens to coincide
    // here, but the field is never printed on the other two rows).
    expect(c1Rows[0][countIdx]).toBe(3)
    expect(c1Rows[1][countIdx]).toBe('')
    expect(c2Rows[0][countIdx]).toBe('')

    // Each row carries ITS OWN day — never joined.
    expect(c1Rows[0][dayIdx]).toBe('Monday')
    expect(c1Rows[1][dayIdx]).toBe('Wednesday')
    expect(c2Rows[0][dayIdx]).toBe('Monday')
  })
})
