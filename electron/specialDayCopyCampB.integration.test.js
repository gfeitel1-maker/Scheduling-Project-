// @vitest-environment node
//
// #903 follow-up: copyCampTimeBlocks driven by the fixed_events rows commitIngest really writes
// for docs/work/specs/samples/campB-by-day.txt with zero answers (one row per operating day,
// group-scoped lunch waves, camp-wide Busses/Carpool/Group Time/Mifkad).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb } from './db/testDbTemplate.js'
import { commitIngest } from './ops/ingest.js'
import { copySpecialDayBlocks } from './ops/copySpecialDayBlocks.js'
import { parseTextGrid } from '../src/ingest/textGrid.js'
import { extractEntities } from '../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../src/ingest/fixedEvents.js'
import { derivePinOnlyActivityNames } from '../src/ingest/pinOnlyActivityNames.js'
import { inferActivityRules } from '../src/ingest/activityRules.js'

vi.mock('../src/localClient', () => ({ localClient: { list: vi.fn(), copySpecialDayBlocks: vi.fn() } }))
import { localClient } from '../src/localClient'
import { copyCampTimeBlocks } from '../src/screens/specialDay/copyCampTimeBlocks'

const SD = 'sd1'
let db
let tables
let campId
let slots

beforeAll(() => {
  ;({ db } = openTemplatedDb())
  campId = randomUUID()
  const cohortId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp B', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'D')
  db.prepare('INSERT INTO cohorts (id, camp_id, name, sort_order) VALUES (?, ?, ?, 0)').run(cohortId, campId, 'Main')
  const parsed = parseTextGrid(fs.readFileSync('docs/work/specs/samples/campB-by-day.txt', 'utf8'))
  const proposal = extractEntities(parsed)
  const { fixedEvents, dualUseNames = [] } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
  const pinOnly = derivePinOnlyActivityNames(fixedEvents, dualUseNames)
  commitIngest(db, {
    approved: { groups: proposal.entities.groups, days_of_operation: proposal.entities.days_of_operation, time_blocks: proposal.entities.time_blocks, activities: proposal.entities.activities },
    activityRules: inferActivityRules(proposal.entities.activities, proposal.activityPages, proposal.seenCounts, proposal.entities.days_of_operation.length, proposal.entities.groups, pinOnly),
    camp_id: campId, cohort_id: cohortId, device_id: 'device-1', fixedEvents, pinOnlyActivityNames: [...pinOnly], seenCounts: proposal.seenCounts ?? null,
  })
  db.prepare('INSERT INTO special_days (id, camp_id, name) VALUES (?, ?, ?)').run(SD, campId, 'Color War')
  tables = {}
  for (const t of ['groups', 'days_of_operation', 'time_blocks', 'activities', 'fixed_events']) tables[t] = db.prepare(`SELECT * FROM ${t}`).all()
})

beforeEach(() => {
  slots = []
  vi.stubGlobal('localStorage', { getItem: () => 't' })
  localClient.list.mockReset().mockImplementation(async (e) => {
    if (e === 'special_day_slots') return slots
    if (e === 'special_day_placements') return []
    return tables[e] ?? []
  })
  db.prepare('DELETE FROM special_day_slots WHERE special_day_id = ?').run(SD)
  db.prepare('DELETE FROM special_day_time_blocks WHERE special_day_id = ?').run(SD)
  // The real main-process copy against the real committed rows, so the cells asserted below are
  // what the database holds after the single transaction.
  localClient.copySpecialDayBlocks.mockReset().mockImplementation(async (args) => {
    const r = copySpecialDayBlocks(db, args, { author_user_id: null, device_id: 'device-1' })
    slots = db.prepare('SELECT * FROM special_day_slots WHERE special_day_id = ?').all(SD)
    return r
  })
})

describe('copyCampTimeBlocks on campB committed rows', () => {
  it('carries each group\'s own lunch wave and Busses, and nothing into groups without that wave', async () => {
    const r = await copyCampTimeBlocks({ campId, specialDayId: SD })
    expect(r.varies).toBe(true)
    const actName = new Map(tables.activities.map((a) => [a.id, a.name]))
    const groupName = new Map(tables.groups.map((g) => [g.id, g.name]))
    const byAct = (name) => slots.filter((s) => actName.get(s.activity_id) === name)
    const groupsOf = (name) => byAct(name).map((s) => groupName.get(s.group_id)).sort()

    expect(groupsOf('Busses')).toHaveLength(tables.groups.length)
    expect(groupsOf('Carpool').length).toBeGreaterThan(0)

    const lunch1 = byAct('Lunch 1')
    expect(groupsOf('Lunch 1')).toEqual(['Badger 1', 'Badger 2', 'Badger 3', 'Beavers 1', 'Beavers 2'])
    expect(new Set(lunch1.map((s) => s.time_block_id)).size).toBe(1)
    // a wave's block holds only that group's wave: no group has two activities in one cell
    const cells = slots.map((s) => `${s.group_id}|${s.time_block_id}`)
    expect(new Set(cells).size).toBe(cells.length)
  })

  // Lunch 2/3 run Mon, Tue, Thu, Fri and Wednesday has Lunch 4/5, so no wave but Lunch 1 is
  // every-day: those are offered for the placed weekday rather than carried blindly.
  it('offers the placed weekday\'s other lunch waves into their own groups and blocks', async () => {
    const monday = tables.days_of_operation.find((d) => d.label === 'Monday')
    localClient.list.mockImplementation(async (e) => {
      if (e === 'special_day_slots') return slots
      if (e === 'special_days') return [{ id: SD }]
      if (e === 'special_day_placements') return [{ id: 'p', special_day_id: SD, day_id: monday.id }]
      return tables[e] ?? []
    })
    const r = await copyCampTimeBlocks({ campId, specialDayId: SD })
    const actName = new Map(tables.activities.map((a) => [a.id, a.name]))
    const groupName = new Map(tables.groups.map((g) => [g.id, g.name]))
    const lunch = (name) => slots.filter((s) => actName.get(s.activity_id) === name)
    expect(lunch('Lunch 1')).toHaveLength(5)
    expect(lunch('Lunch 2')).toHaveLength(0)
    expect(r.offer).not.toBeNull()
    await r.offer.apply()
    expect(lunch('Lunch 2').map((s) => groupName.get(s.group_id)).sort())
      .toEqual(['Muskrat 1', 'Muskrat 2', 'Porcupine 1', 'Porcupine 2', 'Porcupine 3'])
    expect(lunch('Lunch 3').map((s) => groupName.get(s.group_id)).sort()).toEqual(['Weasel 1', 'Weasel 2', 'Weasel 3'])
    expect(lunch('Menucha')).toHaveLength(0)
  })
})
