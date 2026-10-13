// A1 (UX copy/a11y audit, 2026-10-12): a recurring event only some groups showed in the file is held
// back as a question on Roots. "Add for all groups" adds it for every group, through the import commit
// path, so the import's undo removes it again.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest, undoImportRun, lastImportUndo } from './ingest.js'
import { listOpenReconciliationDecisions } from './openReconciliationDecisions.js'
import { addHeldEventForAllGroups } from './addHeldEventForAllGroups.js'
import { normalizeScheduleInputs, SCHEDULE_INPUT_ENTITIES } from './scheduleInputNormalization.js'
import { resolvePriorityForGeneration } from '../../src/ingest/resolvePriorityForGeneration.js'
import buildSchedule from '../../src/engine/buildSchedule.js'

afterAll(() => cleanupTemplatedDbs())
let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  tmpFile = t.file
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})
afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const FLAG = {
  name: 'Flag', time_block: '09:00-10:00', days: ['Monday', 'Tuesday'],
  scope: { is_all_groups: false, groups: ['Bunk 1'] }, confidence: 'low',
}
// The decision the renderer holds back when the director leaves the question open: the shape
// reconciliationReport's addFixedEventDecision builds, carrying the event it is about.
const heldFlag = {
  id: 'fixed_events:flag', kind: 'confirm_value', entity: 'fixed_events', entityId: null, entityName: 'Flag',
  reason: 'Only some groups have Flag in your file.', timeBlock: FLAG.time_block, days: FLAG.days, fixedEvent: FLAG,
}

function importHoldingFlagBack() {
  return commitIngest(db, {
    camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add',
    approved: { groups: ['Bunk 1', 'Bunk 2', 'Bunk 3'], days_of_operation: ['Monday', 'Tuesday'], time_blocks: ['09:00-10:00', '10:00-11:00'], activities: [] },
    fixedEvents: [],
    openDecisions: [heldFlag],
  })
}

describe('addHeldEventForAllGroups', () => {
  it('adds a held-back event for every group at its block and days, clears the question, and undo removes it', () => {
    importHoldingFlagBack()
    expect(listOpenReconciliationDecisions(db, campId).map((d) => d.id)).toEqual(['fixed_events:flag'])

    const outcome = addHeldEventForAllGroups(db, { campId, decisionId: 'fixed_events:flag', author_user_id: 'u1', device_id: deviceId })

    const rows = db.prepare(`
      SELECT fe.is_all_groups, d.day_of_week, tb.name AS block
        FROM fixed_events fe JOIN days_of_operation d ON d.id = fe.day_id JOIN time_blocks tb ON tb.id = fe.time_block_id
       WHERE fe.camp_id = ? AND fe.name = 'Flag' ORDER BY d.day_of_week`).all(campId)
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.is_all_groups === 1)).toBe(true)
    expect(new Set(rows.map((r) => r.block)).size).toBe(1)
    expect(listOpenReconciliationDecisions(db, campId)).toEqual([])

    undoImportRun(db, { importRunId: outcome.importRunId, author_user_id: 'u1', device_id: deviceId, client_write_id: 'undo-1' })
    expect(db.prepare("SELECT COUNT(*) c FROM fixed_events WHERE camp_id = ? AND name = 'Flag'").get(campId).c).toBe(0)
  })

  it('fails loudly when the question carries no event, and leaves the question in place', () => {
    importHoldingFlagBack()
    db.prepare('UPDATE open_reconciliation_decisions SET payload = NULL').run()
    expect(() => addHeldEventForAllGroups(db, { campId, decisionId: 'fixed_events:flag', author_user_id: 'u1', device_id: deviceId }))
      .toThrow(/no event/)
    expect(listOpenReconciliationDecisions(db, campId).map((d) => d.id)).toEqual(['fixed_events:flag'])
    expect(db.prepare("SELECT COUNT(*) c FROM fixed_events WHERE name = 'Flag'").get().c).toBe(0)
  })

  it('fails loudly, and keeps the question, when the event is already on the schedule there', () => {
    importHoldingFlagBack()
    commitIngest(db, {
      camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add', approved: {},
      fixedEvents: [{ ...FLAG, confidence: 'high' }], keepOpenDecisions: true,
    })
    expect(() => addHeldEventForAllGroups(db, { campId, decisionId: 'fixed_events:flag', author_user_id: 'u1', device_id: deviceId }))
      .toThrow(/Flag was not added/)
    expect(listOpenReconciliationDecisions(db, campId).map((d) => d.id)).toEqual(['fixed_events:flag'])
  })

  it('leaves every other open question alone', () => {
    commitIngest(db, {
      camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add',
      approved: { groups: ['Bunk 1', 'Bunk 2'], days_of_operation: ['Monday', 'Tuesday'], time_blocks: ['09:00-10:00'], activities: [] },
      fixedEvents: [],
      openDecisions: [heldFlag, { ...heldFlag, id: 'fixed_events:swim', entityName: 'Swim', fixedEvent: { ...FLAG, name: 'Swim' } }],
    })
    addHeldEventForAllGroups(db, { campId, decisionId: 'fixed_events:flag', author_user_id: 'u1', device_id: deviceId })
    expect(listOpenReconciliationDecisions(db, campId).map((d) => d.id)).toEqual(['fixed_events:swim'])
  })
})

describe('an added event is a real fixed event (keeper ruling 2026-10-13)', () => {
  it('gets its backing pinned_event activity, which undo removes with it', () => {
    importHoldingFlagBack()
    const outcome = addHeldEventForAllGroups(db, { campId, decisionId: 'fixed_events:flag', author_user_id: 'u1', device_id: deviceId })
    const links = db.prepare("SELECT DISTINCT activity_id FROM fixed_events WHERE camp_id = ? AND name = 'Flag'").all(campId)
    expect(links).toHaveLength(1)
    const act = db.prepare('SELECT name, catalog_role FROM activities WHERE id = ?').get(links[0].activity_id)
    expect(act).toEqual({ name: 'Flag', catalog_role: 'pinned_event' })
    undoImportRun(db, { importRunId: outcome.importRunId, author_user_id: 'u1', device_id: deviceId, client_write_id: 'undo-2' })
    expect(db.prepare("SELECT COUNT(*) c FROM activities WHERE camp_id = ? AND name = 'Flag'").get(campId).c).toBe(0)
  })

  it('Generate puts it in every group cell at its block and days, and asks for nothing more', () => {
    importHoldingFlagBack()
    addHeldEventForAllGroups(db, { campId, decisionId: 'fixed_events:flag', author_user_id: 'u1', device_id: deviceId })
    const rowsByEntity = {}
    for (const entity of SCHEDULE_INPUT_ENTITIES) rowsByEntity[entity] = db.prepare(`SELECT * FROM ${entity}`).all()
    const { cohorts: _c, ...flat } = normalizeScheduleInputs(rowsByEntity, campId)
    const input = { ...flat, activities: resolvePriorityForGeneration(flat.activities), campId, replacedDayIds: [] }
    const { slots, findings } = buildSchedule(input)

    expect(input.groups).toHaveLength(3)
    expect(input.days).toHaveLength(2)
    const block = input.timeBlocks.find((b) => b.name === '09:00-10:00')
    const flagEventIds = new Set(input.fixedEvents.filter((f) => f.name === 'Flag').map((f) => f.id))
    for (const g of input.groups) for (const d of input.days) {
      const slot = slots.find((s) => s.groupId === g.id && s.dayId === d.id && s.blockId === block.id)
      expect(slot && flagEventIds.has(slot.fixedEventId), `${g.name} ${d.day_of_week ?? d.name}`).toBe(true)
    }
    const flagAct = input.activities.find((a) => a.name === 'Flag')
    expect(flagAct.catalog_role).toBe('pinned_event')
    expect(flagAct.min_per_week ?? 0).toBe(0)
    expect((findings ?? []).filter((f) => JSON.stringify(f).includes('Flag'))).toEqual([])
  })
})

describe('the Add has its own undo, and leaves the last import\'s undo alone (keeper ruling 2026-10-13)', () => {
  it('keeps Roots\' "Undo last import" on the file import, and each undo removes only its own rows', () => {
    const imported = commitIngest(db, {
      camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add', captureInverse: true,
      approved: { groups: ['Bunk 1', 'Bunk 2'], days_of_operation: ['Monday', 'Tuesday'], time_blocks: ['09:00-10:00'], activities: [] },
      fixedEvents: [], openDecisions: [heldFlag],
    })
    const added = addHeldEventForAllGroups(db, { campId, decisionId: 'fixed_events:flag', author_user_id: 'u1', device_id: deviceId })
    expect(lastImportUndo(db)?.importRunId).toBe(imported.importRunId)

    undoImportRun(db, { importRunId: added.importRunId, author_user_id: 'u1', device_id: deviceId, client_write_id: 'undo-add' })
    expect(db.prepare("SELECT COUNT(*) c FROM fixed_events WHERE name = 'Flag'").get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM groups WHERE camp_id = ?').get(campId).c).toBe(2)
    expect(lastImportUndo(db)?.importRunId).toBe(imported.importRunId)

    undoImportRun(db, { importRunId: imported.importRunId, author_user_id: 'u1', device_id: deviceId, client_write_id: 'undo-import' })
    expect(db.prepare('SELECT COUNT(*) c FROM groups WHERE camp_id = ? AND id NOT IN (SELECT entity_id FROM operations WHERE field = \'__deleted__\')').get(campId).c).toBe(0)
  })
})
