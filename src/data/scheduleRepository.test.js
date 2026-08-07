// Drives the persistence seam with a FAKE localClient (a plain object that
// captures every call) and a fake getToken — no React render, no Electron.
// The whole point of the injected seam (ADR 2026-08-01 §3): the repository IS
// the test surface, so the exact rows/fields handed to write/bulkReplace are
// directly assertable.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createScheduleRepository } from './scheduleRepository'

// A fake localClient: records calls, returns a settable result for the write
// verbs. list() answers from a per-entity store.
// Scope key per entity, mirroring PARENT_SCOPED_ENTITIES's parentKey for the
// five entities C4 targets — used only to make the fake's listByScope filter
// realistically; it is not the thing under test (the real handler/mock's
// registry-driven filtering is covered in main.test.js and localClient.mock.test.js).
const FAKE_SCOPE_KEYS = {
  template_slots: 'template_id',
  template_overlays: 'template_id',
  week_activity_exclusions: 'week_id',
  week_group_exclusions: 'week_id',
}

function makeFakeClient({ writeResult = { status: 'applied' } } = {}) {
  const calls = { write: [], bulkReplace: [], deleteEntity: [], list: [], listByScope: [] }
  const listStore = {}
  return {
    calls,
    listStore,
    setListStore(store) { Object.assign(listStore, store) },
    write: vi.fn((token, entity, id, field, value) => {
      calls.write.push([token, entity, id, field, value])
      return Promise.resolve(writeResult)
    }),
    bulkReplace: vi.fn((token, entity, scope, rows) => {
      calls.bulkReplace.push([token, entity, scope, rows])
      return Promise.resolve({ status: 'applied' })
    }),
    deleteEntity: vi.fn((token, entity, id) => {
      calls.deleteEntity.push([token, entity, id])
      return Promise.resolve({ status: 'applied' })
    }),
    list: vi.fn((entity) => {
      calls.list.push(entity)
      return Promise.resolve(listStore[entity] ?? [])
    }),
    listByScope: vi.fn((entity, scopeId) => {
      calls.listByScope.push([entity, scopeId])
      const key = FAKE_SCOPE_KEYS[entity]
      return Promise.resolve((listStore[entity] ?? []).filter((row) => row[key] === scopeId))
    }),
  }
}

// Deterministic ids so mapped rows can be asserted with toEqual.
let uuidCounter
beforeEach(() => {
  uuidCounter = 0
  vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++uuidCounter}` })
})

const getToken = () => 'tok'

describe('createScheduleRepository — token acquisition', () => {
  it('every write verb uses the injected getToken, never localStorage', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    await repo.writeSlotFields('slot-1', { activity_id: 'act-1' })
    expect(client.calls.write[0][0]).toBe('tok')
  })

  it('defaults getToken to reading the shoresh-token from localStorage', async () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'ls-token') })
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client })
    await repo.writeSlotFields('slot-1', { activity_id: 'act-1' })
    expect(globalThis.localStorage.getItem).toHaveBeenCalledWith('shoresh-token')
    expect(client.calls.write[0][0]).toBe('ls-token')
  })
})

describe('field writes — one write() per field, in insertion order', () => {
  it('writeSlotFields fires write(token, template_slots, id, field, value) per field', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    await repo.writeSlotFields('slot-1', { activity_id: 'act-2', flags: {} })
    expect(client.calls.write).toEqual([
      ['tok', 'template_slots', 'slot-1', 'activity_id', 'act-2'],
      ['tok', 'template_slots', 'slot-1', 'flags', {}],
    ])
  })

  it('writeActivityFields targets the activities entity', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    await repo.writeActivityFields('act-1', { is_locked: true })
    expect(client.calls.write).toEqual([['tok', 'activities', 'act-1', 'is_locked', true]])
  })

  it('writeSnapshotFields writes each schedule_snapshots field with its exact value', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    await repo.writeSnapshotFields('snap-1', {
      template_id: 'tid', name: 'My Version', is_auto: false,
      created_at: '2026-01-01T00:00:00.000Z',
      slots: JSON.stringify([{ a: 1 }]), overlays: JSON.stringify([]),
    })
    expect(client.calls.write).toEqual([
      ['tok', 'schedule_snapshots', 'snap-1', 'template_id', 'tid'],
      ['tok', 'schedule_snapshots', 'snap-1', 'name', 'My Version'],
      ['tok', 'schedule_snapshots', 'snap-1', 'is_auto', false],
      ['tok', 'schedule_snapshots', 'snap-1', 'created_at', '2026-01-01T00:00:00.000Z'],
      ['tok', 'schedule_snapshots', 'snap-1', 'slots', JSON.stringify([{ a: 1 }])],
      ['tok', 'schedule_snapshots', 'snap-1', 'overlays', JSON.stringify([])],
    ])
  })

  it('throws when any write result is not applied/queued, and stops at the first failure', async () => {
    const client = makeFakeClient({ writeResult: { status: 'rejected' } })
    const repo = createScheduleRepository({ localClient: client, getToken })
    await expect(repo.writeSlotFields('slot-1', { activity_id: 'x', flags: {} }))
      .rejects.toThrow(/write failed for field "activity_id"/)
    // Stopped at the first field — flags never attempted.
    expect(client.calls.write).toHaveLength(1)
  })

  it('accepts a queued result as success', async () => {
    const client = makeFakeClient({ writeResult: { status: 'queued' } })
    const repo = createScheduleRepository({ localClient: client, getToken })
    await expect(repo.writeSlotFields('slot-1', { activity_id: 'x' })).resolves.toBeUndefined()
  })
})

describe('createScheduleTemplate — kind is written FIRST (projections write-ordering contract)', () => {
  it('writes kind first, then camp_id, week_id, name', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    await repo.createScheduleTemplate('tid', { kind: 'manual', campId: 'camp-1', weekId: 'week-1', name: 'Manual' })
    // week_id (docs/adr/2026-08-02-schedule-weeks-first-class.md) is written
    // AFTER kind — the per-week conflict backstop is caught on the week_id
    // write, so kind must still land first (projections write-ordering contract).
    expect(client.calls.write).toEqual([
      ['tok', 'schedule_templates', 'tid', 'kind', 'manual'],
      ['tok', 'schedule_templates', 'tid', 'camp_id', 'camp-1'],
      ['tok', 'schedule_templates', 'tid', 'week_id', 'week-1'],
      ['tok', 'schedule_templates', 'tid', 'name', 'Manual'],
    ])
    // kind must be the very first field written.
    expect(client.calls.write[0][3]).toBe('kind')
  })
})

describe('the single slot->row mapper — one mapper, three call-site shapes', () => {
  // Engine-slot shape used by BOTH generate() and placeAnchors() (identical).
  const engineOpenSlot = {
    groupId: 'g1', dayId: 'd1', blockId: 'b1', cohort_id: 'coh',
    type: 'open', activityId: 'act-1', anchorId: null, is_span_head: true, flags: { UNFILLABLE: true },
  }
  const engineAnchorSlot = {
    groupId: 'g1', dayId: 'd2', blockId: 'b2', cohort_id: 'coh',
    type: 'anchor', activityId: null, anchorId: 'anc-1', is_span_head: false, flags: {},
  }

  it('replaceWeek: clears overlays FIRST, then bulkReplaces slots mapped from engine slots (is_span_head emitted)', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    await repo.replaceWeek('tid', [engineOpenSlot, engineAnchorSlot])

    // Order is load-bearing: overlays cleared before slots land.
    expect(client.calls.bulkReplace[0]).toEqual(['tok', 'template_overlays', 'tid', []])
    expect(client.calls.bulkReplace[1][0]).toBe('tok')
    expect(client.calls.bulkReplace[1][1]).toBe('template_slots')
    expect(client.calls.bulkReplace[1][2]).toBe('tid')

    const rows = client.calls.bulkReplace[1][3]
    // Pins the exact mapped row for an engine OPEN slot.
    expect(rows[0]).toEqual({
      id: 'uuid-1', template_id: 'tid',
      group_id: 'g1', day_id: 'd1', time_block_id: 'b1',
      activity_id: 'act-1', anchor_id: null,
      is_anchor: '0', is_span_head: '1',
      flags: JSON.stringify({ UNFILLABLE: true }),
    })
    // Pins the exact mapped row for an engine ANCHOR slot (is_anchor from type,
    // is_span_head:false -> '0').
    expect(rows[1]).toEqual({
      id: 'uuid-2', template_id: 'tid',
      group_id: 'g1', day_id: 'd2', time_block_id: 'b2',
      activity_id: null, anchor_id: 'anc-1',
      is_anchor: '1', is_span_head: '0',
      flags: JSON.stringify({}),
    })
  })

  it('replaceWeek drops "unavailable"-typed engine slots instead of persisting them (T65 — they would inflate the Placed denominator)', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    const unavailableSlot = {
      groupId: 'g1', dayId: 'd3', blockId: 'b3', cohort_id: 'coh',
      type: 'unavailable', activityId: null, anchorId: null, is_span_head: true, flags: {},
    }
    await repo.replaceWeek('tid', [engineOpenSlot, unavailableSlot, engineAnchorSlot])

    const rows = client.calls.bulkReplace[1][3]
    expect(rows).toHaveLength(2)
    expect(rows.some(r => r.day_id === 'd3')).toBe(false)
    expect(rows.map(r => r.day_id)).toEqual(['d1', 'd2'])
  })

  it('replaceWeek maps a slot missing is_span_head as span-head "1" (undefined !== false)', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    const noSpanHead = { groupId: 'g1', dayId: 'd1', blockId: 'b1', type: 'open', activityId: 'a', anchorId: null, flags: {} }
    await repo.replaceWeek('tid', [noSpanHead])
    expect(client.calls.bulkReplace[1][3][0].is_span_head).toBe('1')
  })

  it('restoreSnapshotRows: maps snapshot slots WITHOUT is_span_head (column default preserved), slots then overlays', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    const snapSlot = { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-r', anchor_id: null, is_anchor: false, flags: {} }
    const snapAnchor = { group_id: 'g1', day_id: 'd2', time_block_id: 'b2', activity_id: null, anchor_id: 'anc-1', is_anchor: true, flags: {} }
    const snapOverlay = { unit_id: 't1', day_id: 'd1', from_block_order: 1, to_block_order: 3, label: 'Trip' }

    await repo.restoreSnapshotRows('tid', [snapSlot, snapAnchor], [snapOverlay])

    // Slots first, then overlays (opposite order from replaceWeek — preserved).
    expect(client.calls.bulkReplace[0][1]).toBe('template_slots')
    expect(client.calls.bulkReplace[1][1]).toBe('template_overlays')

    const slotRows = client.calls.bulkReplace[0][3]
    // The span-head field must be ABSENT so the DB column keeps its default —
    // this is the byte-for-byte drift guard (generate emits it, restore omits it).
    expect(slotRows[0]).not.toHaveProperty('is_span_head')
    expect(slotRows[0]).toEqual({
      id: 'uuid-1', template_id: 'tid',
      group_id: 'g1', day_id: 'd1', time_block_id: 'b1',
      activity_id: 'act-r', anchor_id: null,
      is_anchor: '0', flags: JSON.stringify({}),
    })
    // is_anchor derived from the truthy snapshot value.
    expect(slotRows[1].is_anchor).toBe('1')
    expect(slotRows[1]).not.toHaveProperty('is_span_head')

    // Overlay rows: block orders coerced to strings, fresh ids stamped.
    expect(client.calls.bulkReplace[1][3]).toEqual([{
      id: 'uuid-3', template_id: 'tid',
      unit_id: 't1', day_id: 'd1',
      from_block_order: '1', to_block_order: '3', label: 'Trip',
    }])
  })

  it('restoreSnapshotRows: null block orders stay null (no String(null))', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    await repo.restoreSnapshotRows('tid', [], [{ unit_id: 't1', day_id: 'd1', from_block_order: null, to_block_order: null, label: 'X' }])
    const overlayRow = client.calls.bulkReplace[1][3][0]
    expect(overlayRow.from_block_order).toBeNull()
    expect(overlayRow.to_block_order).toBeNull()
  })
})

describe('overlay field writes', () => {
  it('writeOverlayFields writes template_overlays fields in order', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    await repo.writeOverlayFields('ov-1', { to_block_order: 4 })
    expect(client.calls.write).toEqual([['tok', 'template_overlays', 'ov-1', 'to_block_order', 4]])
  })
})

describe('deletes — repo owns the call + token, screen keeps the status decision', () => {
  it('deleteEntity forwards to localClient with the token and RETURNS the raw result (no throw on bad status)', async () => {
    const client = makeFakeClient()
    client.deleteEntity = vi.fn(() => Promise.resolve({ status: 'rejected' }))
    const repo = createScheduleRepository({ localClient: client, getToken })
    const result = await repo.deleteEntity('template_overlays', 'ov-1')
    expect(client.deleteEntity).toHaveBeenCalledWith('tok', 'template_overlays', 'ov-1')
    // Must not throw — deleteSnapshot needs the raw status to pick its message.
    expect(result).toEqual({ status: 'rejected' })
  })
})

describe('reads — fetch + normalize', () => {
  it('loadTemplateData returns templates + normalized slots (flags parsed, booleans coerced) + raw overlays/snapshots', async () => {
    const client = makeFakeClient()
    client.setListStore({
      schedule_templates: [{ id: 'tid', camp_id: 'camp-1' }],
      template_slots: [{ id: 's1', template_id: 'tid', is_anchor: 0, is_span_head: 1, flags: '{"UNFILLABLE":true}' }],
      template_overlays: [{ id: 'ov1', template_id: 'tid' }],
      schedule_snapshots: [{ id: 'snap1', template_id: 'tid' }],
    })
    const repo = createScheduleRepository({ localClient: client, getToken })
    const data = await repo.loadTemplateData()
    expect(data.templates).toEqual([{ id: 'tid', camp_id: 'camp-1' }])
    expect(data.slots[0].is_anchor).toBe(false)
    expect(data.slots[0].is_span_head).toBe(true)
    expect(data.slots[0].flags).toEqual({ UNFILLABLE: true })
    expect(data.overlays).toEqual([{ id: 'ov1', template_id: 'tid' }])
    expect(data.snapshots).toEqual([{ id: 'snap1', template_id: 'tid' }])
  })

  it('loadSetupLists fetches the seven setup entities and keys them by entity name', async () => {
    const client = makeFakeClient()
    client.setListStore({ groups: [{ id: 'g1' }], activities: [{ id: 'a1' }] })
    const repo = createScheduleRepository({ localClient: client, getToken })
    const lists = await repo.loadSetupLists()
    expect(client.calls.list).toEqual([
      'groups', 'days_of_operation', 'time_blocks', 'activities', 'anchor_activities', 'tiers', 'cohorts',
    ])
    expect(lists.groups).toEqual([{ id: 'g1' }])
    expect(lists.activities).toEqual([{ id: 'a1' }])
  })

  it('reloadSlots calls listByScope(template_slots, templateId) and normalizes the result', async () => {
    const client = makeFakeClient()
    client.setListStore({
      template_slots: [
        { id: 's1', template_id: 'tid', is_span_head: 0, flags: '{}' },
        { id: 's2', template_id: 'other', is_span_head: 1, flags: '{}' },
      ],
    })
    const repo = createScheduleRepository({ localClient: client, getToken })
    const slots = await repo.reloadSlots('tid')
    expect(client.calls.listByScope).toEqual([['template_slots', 'tid']])
    expect(slots).toHaveLength(1)
    expect(slots[0].id).toBe('s1')
    expect(slots[0].is_span_head).toBe(false)
  })

  it('reloadSlots passes null (not undefined) for an unminted template', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    await repo.reloadSlots(undefined)
    expect(client.calls.listByScope).toEqual([['template_slots', null]])
  })

  it('reloadOverlays calls listByScope(template_overlays, templateId)', async () => {
    const client = makeFakeClient()
    client.setListStore({ template_overlays: [{ id: 'o1', template_id: 'tid' }, { id: 'o2', template_id: 'x' }] })
    const repo = createScheduleRepository({ localClient: client, getToken })
    expect(await repo.reloadOverlays('tid')).toEqual([{ id: 'o1', template_id: 'tid' }])
    expect(client.calls.listByScope).toEqual([['template_overlays', 'tid']])
  })

  it('getSnapshot finds a schedule_snapshots row by id', async () => {
    const client = makeFakeClient()
    client.setListStore({ schedule_snapshots: [{ id: 'snap-1', slots: '[]' }, { id: 'snap-2', slots: '[]' }] })
    const repo = createScheduleRepository({ localClient: client, getToken })
    expect(await repo.getSnapshot('snap-2')).toEqual({ id: 'snap-2', slots: '[]' })
  })
})

// Guards the T28-review finding: is_anchor is derived PER SHAPE, not as a
// disjunction of `type` and `is_anchor`. These contrived slots carry BOTH
// fields (which real engine/snapshot slots never do) to prove each path reads
// only its own field — so the union can never resolve wrongly if a future slot
// ever carries both. (Red Hat + Code Reviewer converged on this.)
describe('is_anchor derivation is shape-specific, not a disjunction', () => {
  it('engine path (replaceWeek): is_anchor comes from `type`, ignoring a stray is_anchor', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    // type says NOT an anchor, but a stray is_anchor:true is present.
    await repo.replaceWeek('tid', [
      { groupId: 'g1', dayId: 'd1', blockId: 'b1', type: 'activity', is_anchor: true, activityId: 'a', anchorId: null, flags: {} },
    ])
    expect(client.calls.bulkReplace[1][3][0].is_anchor).toBe('0')
  })

  it('snapshot path (restoreSnapshotRows): is_anchor comes from `is_anchor`, ignoring a stray type', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    // is_anchor says NOT an anchor, but a stray type:'anchor' is present.
    await repo.restoreSnapshotRows('tid', [
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', type: 'anchor', is_anchor: false, activity_id: 'a', anchor_id: null, flags: {} },
    ], [])
    expect(client.calls.bulkReplace[0][3][0].is_anchor).toBe('0')
  })
})

describe('week exclusions — loadWeekExclusions / toggleActivityExclusion / toggleGroupExclusion', () => {
  it('loadWeekExclusions returns rows for the given weekId only', async () => {
    const client = makeFakeClient()
    client.setListStore({
      week_activity_exclusions: [
        { id: 'e1', week_id: 'week-1', activity_id: 'act-1' },
        { id: 'e2', week_id: 'week-2', activity_id: 'act-2' },
      ],
      week_group_exclusions: [
        { id: 'g1', week_id: 'week-1', group_id: 'grp-1' },
        { id: 'g2', week_id: 'week-2', group_id: 'grp-2' },
      ],
    })
    const repo = createScheduleRepository({ localClient: client, getToken })
    const result = await repo.loadWeekExclusions('week-1')
    expect(result.activityExclusions).toEqual([{ id: 'e1', week_id: 'week-1', activity_id: 'act-1' }])
    expect(result.groupExclusions).toEqual([{ id: 'g1', week_id: 'week-1', group_id: 'grp-1' }])
    expect(client.calls.listByScope).toEqual(
      expect.arrayContaining([
        ['week_activity_exclusions', 'week-1'],
        ['week_group_exclusions', 'week-1'],
      ])
    )
  })

  it('toggleActivityExclusion(true) calls write with week_id first then activity_id', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    await repo.toggleActivityExclusion('week-1', 'act-swim', true)
    // week_id must be written first (projections ensureExists gate)
    expect(client.calls.write[0][3]).toBe('week_id')
    expect(client.calls.write[0][4]).toBe('week-1')
    expect(client.calls.write[1][3]).toBe('activity_id')
    expect(client.calls.write[1][4]).toBe('act-swim')
    expect(client.calls.write[0][1]).toBe('week_activity_exclusions')
  })

  it('toggleActivityExclusion(false) calls deleteEntity for the matching row', async () => {
    const client = makeFakeClient()
    client.setListStore({
      week_activity_exclusions: [
        { id: 'excl-1', week_id: 'week-1', activity_id: 'act-swim' },
      ],
    })
    const repo = createScheduleRepository({ localClient: client, getToken })
    await repo.toggleActivityExclusion('week-1', 'act-swim', false)
    expect(client.calls.deleteEntity).toEqual([
      ['tok', 'week_activity_exclusions', 'excl-1'],
    ])
  })

  it('toggleGroupExclusion(true) calls write with week_id first then group_id', async () => {
    const client = makeFakeClient()
    const repo = createScheduleRepository({ localClient: client, getToken })
    await repo.toggleGroupExclusion('week-1', 'grp-3', true)
    expect(client.calls.write[0][3]).toBe('week_id')
    expect(client.calls.write[1][3]).toBe('group_id')
    expect(client.calls.write[1][4]).toBe('grp-3')
    expect(client.calls.write[0][1]).toBe('week_group_exclusions')
  })
})
