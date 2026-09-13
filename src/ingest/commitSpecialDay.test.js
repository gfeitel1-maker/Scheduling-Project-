import { describe, it, expect, vi } from 'vitest'
import { commitSpecialDayPlan } from './commitSpecialDay'

// T40 slice 3b — writing the plan.
//
// There is no transactional IPC for this: a special day is a parent row, N
// period rows and N*M cell rows, each its own write. That is the partial-write
// class T109 is about, and the existing author screen
// (SpecialEventsScreen.seedFromCampTimeBlocks) already faces it and answers the
// same way — write in order, count what landed, and tell the director exactly
// where it stopped. This follows that precedent rather than inventing a
// transaction that the IPC surface cannot honour.
//
// ORDER IS THE DESIGN. The day row is written FIRST so that any later failure
// leaves something the director can see on the Special Events screen and delete,
// rather than orphan periods and cells pointing at a parent that does not exist.

const plan = () => ({
  name: 'Maccabiah',
  columns: [{ columnName: 'Red', groupId: 'g1' }, { columnName: 'Blue', groupId: 'g2' }],
  timeBlocks: [
    { name: '9:15-9:45', sort_order: 0, start_time: '9:15', end_time: '9:45' },
    { name: '10:15', sort_order: 1, start_time: '10:15', end_time: null },
  ],
  activities: [{ name: 'Relay', activityId: 'a1' }, { name: 'Tug', activityId: null }],
  newActivityNames: ['Tug'],
  slots: [
    { columnName: 'Red', blockName: '9:15-9:45', activityName: 'Relay' },
    { columnName: 'Blue', blockName: '10:15', activityName: 'Tug' },
  ],
  notes: 'From the imported file — cells that named a person:\nRed 10:15: Pool - Unit Heads',
  ready: true,
  blockedBy: [],
})

function harness(failOn = null) {
  const writes = []
  let n = 0
  const writeField = vi.fn(async (entity, id, field, value) => {
    writes.push({ entity, id, field, value })
    if (failOn && writes.length === failOn) throw new Error('write refused')
  })
  const newId = () => `id-${++n}`
  return { writes, writeField, newId }
}

describe('commitSpecialDayPlan', () => {
  it('refuses a plan that is not ready, without writing anything', async () => {
    const h = harness()
    const notReady = { ...plan(), ready: false, blockedBy: ['unmatched_columns'] }
    await expect(commitSpecialDayPlan(notReady, h)).rejects.toThrow(/not ready/i)
    expect(h.writeField).not.toHaveBeenCalled()
  })

  it('writes the day row FIRST, so a later failure leaves something deletable', async () => {
    const h = harness()
    await commitSpecialDayPlan(plan(), h)
    expect(h.writes[0]).toMatchObject({ entity: 'special_days', field: 'name', value: 'Maccabiah' })
  })

  it('carries the notes onto the day, so the staff names survive the import', async () => {
    const h = harness()
    await commitSpecialDayPlan(plan(), h)
    const note = h.writes.find(w => w.entity === 'special_days' && w.field === 'notes')
    expect(note.value).toMatch(/Unit Heads/)
  })

  it('creates only the activities the camp is missing', async () => {
    const h = harness()
    await commitSpecialDayPlan(plan(), h)
    const made = h.writes.filter(w => w.entity === 'activities' && w.field === 'name').map(w => w.value)
    expect(made).toEqual(['Tug'])
  })

  it('writes each period with its order and both ends when the file had them', async () => {
    const h = harness()
    await commitSpecialDayPlan(plan(), h)
    const blocks = h.writes.filter(w => w.entity === 'special_day_time_blocks')
    expect(blocks.filter(w => w.field === 'name').map(w => w.value)).toEqual(['9:15-9:45', '10:15'])
    expect(blocks.some(w => w.field === 'end_time' && w.value === '9:45')).toBe(true)
    // The open-ended period writes no end_time at all rather than a null one.
    expect(blocks.filter(w => w.field === 'end_time')).toHaveLength(1)
  })

  it('binds each cell to the real group, period and activity ids', async () => {
    const h = harness()
    const out = await commitSpecialDayPlan(plan(), h)
    const slotIds = [...new Set(h.writes.filter(w => w.entity === 'special_day_slots').map(w => w.id))]
    expect(slotIds).toHaveLength(2)
    const first = h.writes.filter(w => w.entity === 'special_day_slots' && w.id === slotIds[0])
    expect(first.find(w => w.field === 'group_id').value).toBe('g1')
    expect(first.find(w => w.field === 'activity_id').value).toBe('a1')
    // The period id is this day's OWN row, never a camp time_block.
    const blockId = h.writes.find(w => w.entity === 'special_day_time_blocks' && w.field === 'name' && w.value === '9:15-9:45').id
    expect(first.find(w => w.field === 'time_block_id').value).toBe(blockId)
    expect(out.specialDayId).toBeTruthy()
  })

  it('binds a cell to the activity this same commit just created', async () => {
    const h = harness()
    await commitSpecialDayPlan(plan(), h)
    const tugId = h.writes.find(w => w.entity === 'activities' && w.field === 'name' && w.value === 'Tug').id
    const slotWrites = h.writes.filter(w => w.entity === 'special_day_slots')
    expect(slotWrites.some(w => w.field === 'activity_id' && w.value === tugId)).toBe(true)
  })

  it('reports where it stopped, and what had already landed', async () => {
    // No transaction exists, so the honest answer is a precise account — not a
    // claim that nothing happened, which would be a lie the director acts on.
    const h = harness(6)
    await expect(commitSpecialDayPlan(plan(), h)).rejects.toMatchObject({
      specialDayId: expect.any(String),
    })
  })

  it('names the day in the failure, so it can be found and deleted', async () => {
    const h = harness(6)
    await expect(commitSpecialDayPlan(plan(), h)).rejects.toThrow(/Maccabiah/)
  })

  it('counts what it built on success', async () => {
    const h = harness()
    const out = await commitSpecialDayPlan(plan(), h)
    expect(out).toMatchObject({ periods: 2, cells: 2, activitiesCreated: 1 })
  })
})

// Red Hat (T40 3b review) — the id is minted before the first write, and
// attaching it unconditionally told the director to "find it under Special
// Events and delete it" even when the very first write failed and nothing had
// been created. That is the same class of lie as claiming nothing happened,
// pointed the other way.
describe('commitSpecialDayPlan — a failure on the FIRST write', () => {
  it('does not claim a day exists', async () => {
    const err = await commitSpecialDayPlan(plan(), harness(1)).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    // The screen keys its "go find and delete it" message on this property.
    expect(err.specialDayId).toBeUndefined()
  })

  it('says plainly that nothing was written', async () => {
    const h = harness(1)
    await expect(commitSpecialDayPlan(plan(), h)).rejects.toThrow(/Nothing was written/i)
  })

  it('still says which day it was', async () => {
    await expect(commitSpecialDayPlan(plan(), harness(1))).rejects.toThrow(/Maccabiah/)
  })

  it('DOES claim a day once the parent row has landed', async () => {
    // The distinction is the whole point: write #2 onward, the day is real.
    const h = harness(3)
    await expect(commitSpecialDayPlan(plan(), h)).rejects.toMatchObject({
      specialDayId: expect.any(String),
    })
  })
})
