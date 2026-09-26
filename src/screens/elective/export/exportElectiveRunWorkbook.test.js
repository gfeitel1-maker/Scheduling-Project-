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
})
