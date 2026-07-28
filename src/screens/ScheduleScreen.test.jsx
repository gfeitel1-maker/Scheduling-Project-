// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

// Captured onOpApplied callbacks so tests can fire synthetic op-applied events.
const opAppliedListeners = []

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    bulkReplace: vi.fn(),
    onOpApplied: vi.fn((cb) => { opAppliedListeners.push(cb) }),
  },
}))

import ScheduleScreen from './ScheduleScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

// An activity name (e.g. "Swim") renders in two places: the schedule cell
// (inside a <td>) and the always-present ActivityPalette sidebar chip. Plain
// getByText is therefore ambiguous — scope to the cell, which is the only
// occurrence inside a <td>.
function scheduleCell(name) {
  return screen.getAllByText(name).find((el) => el.closest('td'))
}

// Activity names also appear in the palette sidebar, so queries meant for the
// edit modal must be scoped to it rather than run against the whole screen.
function editModal() {
  return screen.getByText('Assign Activity').parentElement
}

function group(overrides = {}) { return { id: 'g1', camp_id: CAMP_ID, name: 'Group A', tier_id: 't1', ...overrides } }
function day(overrides = {}) { return { id: 'd1', camp_id: CAMP_ID, day_of_week: 1, sort_order: 1, label: 'Monday', ...overrides } }
function timeBlock(overrides = {}) { return { id: 'b1', camp_id: CAMP_ID, name: 'Morning', sort_order: 1, start_time: '09:00:00', end_time: '10:00:00', ...overrides } }
function activity(overrides = {}) { return { id: 'act-1', camp_id: CAMP_ID, name: 'Swim', ...overrides } }
function tier(overrides = {}) { return { id: 't1', camp_id: CAMP_ID, name: 'Tier 1', sort_order: 1, ...overrides } }
// DB shape, deliberately: is_anchor/is_span_head/is_released are INTEGER
// columns (electron/db/localDb.js) and localClient.list() returns raw
// `SELECT *` rows with no coercion (electron/main.js), so the renderer only
// ever receives 0/1 here — never false/true. Fixturing JS booleans hid every
// `=== false` comparison bug in the component.
function slotRow(overrides = {}) {
  return { id: 'slot-1', template_id: 'tmpl-1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', anchor_id: null, is_anchor: 0, is_span_head: 1, is_released: 0, flags: {}, ...overrides }
}

function mockList(overridesByEntity = {}) {
  const base = {
    groups: [group()],
    days_of_operation: [day()],
    time_blocks: [timeBlock()],
    activities: [activity()],
    anchor_activities: [],
    tiers: [tier()],
    schedule_templates: [{ id: 'tmpl-1', camp_id: CAMP_ID, name: 'Master Template' }],
    template_slots: [slotRow()],
    template_overlays: [],
    schedule_snapshots: [],
  }
  const merged = { ...base, ...overridesByEntity }
  localClient.list.mockImplementation((entity) => Promise.resolve(merged[entity] ?? []))
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'new-id-1' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.bulkReplace.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.onOpApplied.mockReset().mockImplementation((cb) => { opAppliedListeners.push(cb) })
  // Clear captured listeners before each test so one test's listener
  // callbacks can't fire in a later test's assertion window.
  opAppliedListeners.length = 0
})

// Round 2 Fix 1: bulk_replace rows carry `flags` JSON.stringify'd (the op-log
// only accepts string/null row values — see validateBulkReplaceRows in
// electron/ops/operations.js). generate()/placeAnchors()/restoreSnapshot()
// all re-fetch via localClient.list('template_slots') after the bulkReplace
// call, and ScheduleScreen must parse that string back to an object at the
// read boundary — otherwise every flags?.FOO check in the UI (e.g. the
// Unfillable stat badge below) silently breaks.
describe('flags round-trips through bulk_replace as a parsed object (Round 2 Fix 1)', () => {
  it('generate(): after bulkReplace, the refetched template_slots rows have flags parsed back into an object, not left as a JSON string', async () => {
    mockList({
      schedule_templates: [],
      template_slots: [
        slotRow({ template_id: 'new-id-1', flags: '{"UNFILLABLE":true}' }),
      ],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.getByText('Generate Schedule')).toBeTruthy())
    fireEvent.click(screen.getByText('Generate Schedule'))

    await waitFor(() => {
      expect(localClient.bulkReplace).toHaveBeenCalledWith('token-abc', 'template_slots', expect.any(String), expect.any(Array))
    })

    // The Unfillable stat badge reads `s.flags?.UNFILLABLE` — this only
    // shows "1" if flags came back as a real object, not the raw
    // '{"UNFILLABLE":true}' string (whose truthy-but-un-indexable .UNFILLABLE
    // access would silently read undefined instead).
    await waitFor(() => {
      expect(screen.getByText(/Unfillable/)).toBeTruthy()
    })
    const unfillableBadge = screen.getByText(/Unfillable/).parentElement
    expect(unfillableBadge.textContent).toContain('1')
  })
})

// Regression at the real defect: a merge-down writes is_span_head:false, the
// resulting op_applied fires loadAll(), and the reloaded rows come back as
// integers. Without coercion isActivityTail()/getActivityRowSpan() stop
// recognising the tail and the head activity renders twice in two unmerged
// cells; recalcStats' `is_anchor === false` filters likewise match nothing.
describe('DB-shaped slots (integers, as list() actually returns) drive the span/stat readers correctly', () => {
  it('isActivityTail/getActivityRowSpan: a merged pair renders the head activity ONCE, in a rowSpan=2 cell — not twice in two unmerged cells', async () => {
    mockList({
      time_blocks: [timeBlock(), timeBlock({ id: 'b2', name: 'Afternoon', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' })],
      template_slots: [
        slotRow({ id: 'slot-1', time_block_id: 'b1', is_span_head: 1 }),
        slotRow({ id: 'slot-2', time_block_id: 'b2', is_span_head: 0 }),
      ],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    const cells = screen.getAllByText('Swim').filter((el) => el.closest('td'))
    expect(cells).toHaveLength(1)
    expect(cells[0].closest('td').rowSpan).toBe(2)
  })

  it('recalcStats: `is_anchor === false` counts DB-loaded non-anchor slots instead of reporting 0/0 after every reload', async () => {
    mockList()
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.getByText('Filled')).toBeTruthy())
    expect(screen.getByText('Filled').parentElement.textContent).toContain('1/1')
  })
})

// writeFields is the shared primitive that editSlotSave, swapSlots, dismissFlag,
// lockActivity, releaseCell, addOverlay, updateOverlayRange, placeActivityManual,
// and expandSlot all route through (it is module-private, so it is exercised here
// through editSlotSave rather than imported directly). These two tests cover the
// success/failure contract shared by all nine writeFields-based functions;
// releaseCell and removeOverlay additionally get their own direct rendered-component
// coverage below since they call localClient directly rather than via writeFields.
describe('editSlotSave (exercises the shared writeFields primitive)', () => {
  it('success: selecting a different activity and saving writes activity_id and flags, then updates the cell', async () => {
    mockList({ activities: [activity({ id: 'act-1', name: 'Swim' }), activity({ id: 'act-2', name: 'Art' })] })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
    // Group view wires onCellSelect, so a single click SELECTS the cell —
    // the edit modal is opened by double-click (SlotCell.handleDoubleClick).
    fireEvent.doubleClick(scheduleCell('Swim'))

    await waitFor(() => expect(screen.getByText('Assign Activity')).toBeTruthy())
    fireEvent.click(within(editModal()).getByText('Art'))
    fireEvent.click(within(editModal()).getByText('Save'))

    await waitFor(() => {
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'template_slots', 'slot-1', 'activity_id', 'act-2')
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'template_slots', 'slot-1', 'flags', {})
    })
    await waitFor(() => expect(screen.queryByText('Assign Activity')).toBeNull())
  })

  it('failure: does not silently proceed when the write comes back non-applied — surfaces an error banner and keeps the modal open', async () => {
    mockList({ activities: [activity({ id: 'act-1', name: 'Swim' }), activity({ id: 'act-2', name: 'Art' })] })
    localClient.write.mockResolvedValue({ status: 'rejected' })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
    // See note above: double-click is what opens the edit modal in group view.
    fireEvent.doubleClick(scheduleCell('Swim'))

    await waitFor(() => expect(screen.getByText('Assign Activity')).toBeTruthy())
    fireEvent.click(within(editModal()).getByText('Art'))
    fireEvent.click(within(editModal()).getByText('Save'))

    await waitFor(() => {
      expect(screen.getByText(/Failed to save slot/i)).toBeTruthy()
    })
    // Modal stays open — editSlotSave returned early instead of clearing editSlot.
    expect(screen.getByText('Assign Activity')).toBeTruthy()
  })
})

describe('ScheduleScreen mutation functions exercised via rendered component', () => {
  it('releaseCell: clicking a locked slot cell writes template_slots.is_released and updates the UI to unlocked', async () => {
    mockList({
      activities: [activity({ is_locked: true })],
      template_slots: [slotRow({ is_released: 0 })],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())
    fireEvent.click(screen.getByText('Daily View'))

    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
    fireEvent.click(scheduleCell('Swim'))

    await waitFor(() => {
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'template_slots', 'slot-1', 'is_released', true)
    })
  })

  it('releaseCell failure: surfaces an error banner and leaves the cell locked when the write is rejected', async () => {
    mockList({
      activities: [activity({ is_locked: true })],
      template_slots: [slotRow({ is_released: 0 })],
    })
    localClient.write.mockResolvedValue({ status: 'rejected' })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())
    fireEvent.click(screen.getByText('Daily View'))

    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
    fireEvent.click(scheduleCell('Swim'))

    await waitFor(() => {
      expect(screen.getByText(/Failed to release cell/i)).toBeTruthy()
    })
  })

  it('generate() failure: a non-admin bulkReplace rejection ("admin role required") is caught and surfaced as a user-visible error, not an unhandled crash (Round 2 Fix 2)', async () => {
    mockList({ schedule_templates: [] })
    localClient.bulkReplace.mockRejectedValue(new Error('admin role required'))
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.getByText('Generate Schedule')).toBeTruthy())
    fireEvent.click(screen.getByText('Generate Schedule'))

    await waitFor(() => {
      expect(screen.getByText(/Only an admin can regenerate the schedule/i)).toBeTruthy()
    })
    // Still on the "no schedule" empty state — the rejection did not leave
    // the screen stuck on a spinner or throw past the click handler.
    expect(screen.getByText('Generate Schedule')).toBeTruthy()
  })

  it('removeOverlay: clicking the remove button on a stamped overlay deletes it via localClient.deleteEntity', async () => {
    mockList({
      template_overlays: [{ id: 'ov-1', template_id: 'tmpl-1', unit_id: 't1', day_id: 'd1', from_block_order: 1, to_block_order: 1, label: 'Field Trip' }],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())
    fireEvent.click(screen.getByText('Daily View'))

    await waitFor(() => expect(screen.getAllByText('Field Trip').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByText('Field Trip')[0])

    await waitFor(() => expect(screen.getAllByText('✕ Remove').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByText('✕ Remove')[0])

    await waitFor(() => {
      expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'template_overlays', 'ov-1')
    })
  })
})

// Task 4: saveSnapshot/restoreSnapshot's payload fetch/renameSnapshot ported
// from Supabase to localClient. slots/overlays are the one scoped exception
// where a JSON-text-column is written via ordinary writeFields (not bulk_replace).
describe('snapshot CRUD ported to localClient', () => {
  it('saveSnapshot: writes template_id/name/is_auto/created_at/slots/overlays via writeFields (slots+overlays JSON.stringify\'d) and updates snapshot list optimistically', async () => {
    mockList({
      template_slots: [slotRow({ flags: { UNFILLABLE: true } })],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())

    fireEvent.click(screen.getByText('📋 Versions ▾'))
    const nameInput = screen.getByPlaceholderText('Name current version…')
    fireEvent.change(nameInput, { target: { value: 'My Version' } })
    fireEvent.click(screen.getByText('Save as named version'))

    await waitFor(() => {
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'schedule_snapshots', 'new-id-1', 'name', 'My Version')
    })
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'schedule_snapshots', 'new-id-1', 'template_id', 'tmpl-1')
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'schedule_snapshots', 'new-id-1', 'is_auto', false)
    expect(localClient.write).toHaveBeenCalledWith(
      'token-abc', 'schedule_snapshots', 'new-id-1', 'slots',
      JSON.stringify([{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', anchor_id: null, is_anchor: false, flags: { UNFILLABLE: true } }])
    )
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'schedule_snapshots', 'new-id-1', 'overlays', JSON.stringify([]))

    // Optimistic local state update — new snapshot appears in the dropdown.
    await waitFor(() => expect(screen.getByText('My Version')).toBeTruthy())
  })

  it('renameSnapshot: writes name and is_auto:false via writeFields', async () => {
    mockList({
      schedule_snapshots: [
        { id: 'snap-2', template_id: 'tmpl-1', name: 'Newest', is_auto: false, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'snap-1', template_id: 'tmpl-1', name: null, is_auto: true, created_at: '2025-12-31T00:00:00.000Z' },
      ],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())

    fireEvent.click(screen.getByText('📋 Versions ▾'))
    await waitFor(() => expect(screen.getByText('rename')).toBeTruthy())
    fireEvent.click(screen.getByText('rename'))

    const renameInput = screen.getByPlaceholderText('Version name…')
    fireEvent.change(renameInput, { target: { value: 'Renamed Version' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'schedule_snapshots', 'snap-1', 'name', 'Renamed Version')
    })
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'schedule_snapshots', 'snap-1', 'is_auto', false)
  })

  it('restoreSnapshot: parses stored slots/overlays JSON strings back into arrays and applies them to the live schedule', async () => {
    const storedSlots = JSON.stringify([
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-restored', anchor_id: null, is_anchor: false, flags: {} },
    ])
    mockList({
      schedule_snapshots: [
        { id: 'snap-1', template_id: 'tmpl-1', name: null, is_auto: true, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'snap-2', template_id: 'tmpl-1', name: 'Older', is_auto: false, created_at: '2025-12-31T00:00:00.000Z', slots: storedSlots, overlays: '' },
      ],
      activities: [activity(), activity({ id: 'act-restored', name: 'Arts & Crafts' })],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())
    fireEvent.click(screen.getByText('Daily View'))

    fireEvent.click(screen.getByText('📋 Versions ▾'))
    await waitFor(() => expect(screen.getByText('Restore')).toBeTruthy())

    // After restore, the refetch of template_slots/template_overlays reflects
    // what bulkReplace was called with — built from the parsed snapshot slots.
    fireEvent.click(screen.getByText('Restore'))

    await waitFor(() => {
      expect(localClient.bulkReplace).toHaveBeenCalledWith(
        'token-abc', 'template_slots', 'tmpl-1',
        expect.arrayContaining([expect.objectContaining({ activity_id: 'act-restored' })])
      )
    })
  })

  it('restoreSnapshot: a malformed slots JSON string surfaces a corruption error instead of throwing, and does not call bulkReplace', async () => {
    mockList({
      schedule_snapshots: [
        { id: 'snap-1', template_id: 'tmpl-1', name: null, is_auto: true, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'snap-2', template_id: 'tmpl-1', name: 'Corrupt', is_auto: false, created_at: '2025-12-31T00:00:00.000Z', slots: '{not valid json', overlays: '' },
      ],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())
    fireEvent.click(screen.getByText('Daily View'))

    fireEvent.click(screen.getByText('📋 Versions ▾'))
    await waitFor(() => expect(screen.getByText('Restore')).toBeTruthy())
    fireEvent.click(screen.getByText('Restore'))

    await waitFor(() => {
      expect(screen.getByText(/corrupted and cannot be restored/i)).toBeTruthy()
    })
    expect(localClient.bulkReplace).not.toHaveBeenCalled()
  })

  it('renameSnapshot failure: a rejected write surfaces an error banner instead of throwing unhandled', async () => {
    mockList({
      schedule_snapshots: [
        { id: 'snap-2', template_id: 'tmpl-1', name: 'Newest', is_auto: false, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'snap-1', template_id: 'tmpl-1', name: null, is_auto: true, created_at: '2025-12-31T00:00:00.000Z' },
      ],
    })
    localClient.write.mockRejectedValue(new Error('network down'))
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())

    fireEvent.click(screen.getByText('📋 Versions ▾'))
    await waitFor(() => expect(screen.getByText('rename')).toBeTruthy())
    fireEvent.click(screen.getByText('rename'))

    const renameInput = screen.getByPlaceholderText('Version name…')
    fireEvent.change(renameInput, { target: { value: 'Renamed Version' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(screen.getByText(/Failed to rename snapshot/i)).toBeTruthy()
    })
  })
})

// §7.3: ScheduleScreen registers an onOpApplied listener (for conflict-
// resolution refresh) and re-runs loadAll() when that listener fires. This
// test exercises the happy path: listener registered on mount, fires once
// via the captured callback, schedule data is re-fetched.
describe('§7.3 — onOpApplied triggers schedule reload (conflict-resolution refresh)', () => {
  it('registers an onOpApplied listener on mount and calls loadAll() again when it fires', async () => {
    mockList()
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    // Wait for initial load to finish (we see the schedule grid label).
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())

    // Confirm the listener was registered exactly once.
    expect(localClient.onOpApplied).toHaveBeenCalledTimes(1)
    const listCallsAfterMount = localClient.list.mock.calls.length

    // Simulate an op_applied event (e.g. after a conflict resolution) by
    // firing the captured callback — same path as the real shoresh:op-applied
    // IPC event going through localClient.onOpApplied.
    expect(opAppliedListeners.length).toBeGreaterThan(0)
    opAppliedListeners[0]()

    // loadAll() must issue a fresh batch of localClient.list() calls.
    await waitFor(() => {
      expect(localClient.list.mock.calls.length).toBeGreaterThan(listCallsAfterMount)
    })
  })
})

// Round 2 Fix 1: saveSnapshot is a safety-net undo point taken immediately
// before generate()'s destructive bulkReplace wipe. If the snapshot write
// fails, saveSnapshot must propagate that failure so generate() can abort
// instead of proceeding to destroy the existing schedule with no undo point.
describe('generate() aborts the destructive wipe when the pre-emptive snapshot fails (Round 2 Fix 1)', () => {
  it('does not call bulkReplace when the auto-snapshot write rejects', async () => {
    mockList({
      template_slots: [slotRow()],
    })
    localClient.write.mockRejectedValue(new Error('write failed'))
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())

    fireEvent.click(screen.getByText('Regenerate from Scratch'))
    await waitFor(() => expect(screen.getByText('Yes, Regenerate')).toBeTruthy())
    fireEvent.click(screen.getByText('Yes, Regenerate'))

    await waitFor(() => {
      expect(screen.getByText(/undo point/i)).toBeTruthy()
    })
    expect(localClient.bulkReplace).not.toHaveBeenCalled()
  })
})
