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
  return { id: 'slot-1', template_id: 'schedule-template:camp-1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', anchor_id: null, is_anchor: 0, is_span_head: 1, is_released: 0, flags: {}, ...overrides }
}

function mockList(overridesByEntity = {}) {
  const base = {
    groups: [group()],
    days_of_operation: [day()],
    time_blocks: [timeBlock()],
    activities: [activity()],
    anchor_activities: [],
    tiers: [tier()],
    schedule_templates: [{ id: 'schedule-template:camp-1', camp_id: CAMP_ID, name: 'Master Template' }],
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
        slotRow({ template_id: 'schedule-template:camp-1', flags: '{"UNFILLABLE":true}' }),
      ],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.getByText('Generate a schedule')).toBeTruthy())
    fireEvent.click(screen.getByText('Generate a schedule'))

    await waitFor(() => {
      expect(localClient.bulkReplace).toHaveBeenCalledWith('token-abc', 'template_slots', expect.any(String), expect.any(Array))
    })

    // The Unfillable stat badge reads `s.flags?.UNFILLABLE` — this only
    // shows "1" if flags came back as a real object, not the raw
    // '{"UNFILLABLE":true}' string (whose truthy-but-un-indexable .UNFILLABLE
    // access would silently read undefined instead).
    // Scoped to the stat badge specifically. The grid legend also documents an
    // "Unfillable" treatment, so a bare getByText(/Unfillable/) matches two
    // elements and throws — and matching the legend would prove nothing here,
    // since the legend is static and renders whether or not any slot is flagged.
    const statBadgeLabel = () => screen.getAllByText(/Unfillable/)
      .find(el => el.parentElement?.getAttribute('title') === 'Click to see details')

    await waitFor(() => {
      expect(statBadgeLabel()).toBeTruthy()
    })
    const unfillableBadge = statBadgeLabel().parentElement
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

// Round 2 B2: loadAll() previously never called buildSchedule() or otherwise
// populated `findings`, so the Underserved/Distribution badges silently read
// 0 (neutral gray — visually "all clear") for an EXISTING schedule that was
// simply opened, never regenerated in this session. This is the ordinary
// director path — nobody regenerates just to look.
describe('findings recompute on load without regenerating (Round 2 B2)', () => {
  it('loadAll(): the Underserved badge reflects persisted slot counts on initial render, before Generate is ever clicked', async () => {
    mockList({
      activities: [activity({ id: 'act-1', name: 'Swim', min_per_week: 3, eligible_tier_ids: [], eligible_group_ids: [] })],
      template_slots: [slotRow({ activity_id: 'act-1' })], // only 1 placement, needs 3
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.getByText(/Underserved/)).toBeTruthy())
    const badge = screen.getByText(/Underserved/).parentElement
    expect(badge.textContent).toContain('1')
    // The Generate button must never have been clicked — proves this is
    // loadAll(), not a leftover buildSchedule() call from generate().
    expect(localClient.bulkReplace).not.toHaveBeenCalled()
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

  // Round 2 B1: ScheduleGroupView (the default, primary view) destructures
  // and calls `releaseCell` from SlotCell's onRelease, but ScheduleScreen
  // never passed the prop down — clicking a locked cell in group view threw
  // "releaseCell is not a function". Day view got the prop; group view did
  // not. This test renders in the DEFAULT view (no "Daily View" click) so it
  // fails with that TypeError if the prop wiring regresses.
  it('releaseCell in GROUP view (default view): clicking a locked slot cell writes template_slots.is_released without throwing', async () => {
    mockList({
      activities: [activity({ is_locked: true })],
      template_slots: [slotRow({ is_released: 0 })],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
    fireEvent.click(scheduleCell('Swim'))

    await waitFor(() => {
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'template_slots', 'slot-1', 'is_released', true)
    })
  })

  it('generate() failure: a non-admin bulkReplace rejection ("admin role required") is caught and surfaced as a user-visible error, not an unhandled crash (Round 2 Fix 2)', async () => {
    mockList({ schedule_templates: [] })
    localClient.bulkReplace.mockRejectedValue(new Error('admin role required'))
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.getByText('Generate a schedule')).toBeTruthy())
    fireEvent.click(screen.getByText('Generate a schedule'))

    await waitFor(() => {
      expect(screen.getByText(/Only an admin can regenerate the schedule/i)).toBeTruthy()
    })
    // Still on the "no schedule" empty state — the rejection did not leave
    // the screen stuck on a spinner or throw past the click handler.
    expect(screen.getByText('Generate a schedule')).toBeTruthy()
  })

  it('removeOverlay: clicking the remove button on a stamped overlay deletes it via localClient.deleteEntity', async () => {
    mockList({
      template_overlays: [{ id: 'ov-1', template_id: 'schedule-template:camp-1', unit_id: 't1', day_id: 'd1', from_block_order: 1, to_block_order: 1, label: 'Field Trip' }],
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
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'schedule_snapshots', 'new-id-1', 'template_id', 'schedule-template:camp-1')
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
        { id: 'snap-2', template_id: 'schedule-template:camp-1', name: 'Newest', is_auto: false, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'snap-1', template_id: 'schedule-template:camp-1', name: null, is_auto: true, created_at: '2025-12-31T00:00:00.000Z' },
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
        { id: 'snap-1', template_id: 'schedule-template:camp-1', name: null, is_auto: true, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'snap-2', template_id: 'schedule-template:camp-1', name: 'Older', is_auto: false, created_at: '2025-12-31T00:00:00.000Z', slots: storedSlots, overlays: '' },
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
        'token-abc', 'template_slots', 'schedule-template:camp-1',
        expect.arrayContaining([expect.objectContaining({ activity_id: 'act-restored' })])
      )
    })
  })

  it('restoreSnapshot: a malformed slots JSON string surfaces a corruption error instead of throwing, and does not call bulkReplace', async () => {
    mockList({
      schedule_snapshots: [
        { id: 'snap-1', template_id: 'schedule-template:camp-1', name: null, is_auto: true, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'snap-2', template_id: 'schedule-template:camp-1', name: 'Corrupt', is_auto: false, created_at: '2025-12-31T00:00:00.000Z', slots: '{not valid json', overlays: '' },
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
        { id: 'snap-2', template_id: 'schedule-template:camp-1', name: 'Newest', is_auto: false, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'snap-1', template_id: 'schedule-template:camp-1', name: null, is_auto: true, created_at: '2025-12-31T00:00:00.000Z' },
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
    await waitFor(() => expect(screen.getByText('Build a new one')).toBeTruthy())
    fireEvent.click(screen.getByText('Build a new one'))

    await waitFor(() => {
      expect(screen.getByText(/undo point/i)).toBeTruthy()
    })
    expect(localClient.bulkReplace).not.toHaveBeenCalled()
  })
})

// T6 — placeActivityManual (ScheduleScreen.jsx:683) computed eligibility off
// activity.eligible_tier_ids / eligible_group_ids without parsing them.
// activities.list() returns those columns as JSON strings ('[]' for "no
// restriction"), so `tierIds.length === 0` was `'[]'.length === 0` (false)
// and `.includes()` did a substring search — every manually-placed activity
// came back ineligible and got flagged UNFILLABLE regardless of its actual
// eligibility. placeActivityManual is module-private and only reachable
// through drag-and-drop (@dnd-kit) or copy/paste; copy/paste is plain click +
// keydown, so it's used here to exercise the real component instead of
// simulating dnd-kit pointer drags. Fixtures are DB-shaped JSON strings for
// eligible_tier_ids/eligible_group_ids, never JS arrays — an array fixture
// would pass against the pre-fix code and prove nothing.
describe('placeActivityManual eligibility (T6 — DB-shaped eligible_tier_ids/eligible_group_ids)', () => {
  // Copies the "Swim" cell (slot-1, block b1) via Ctrl+C, then pastes it onto
  // the "Soccer" cell (slot-2, block b2), which is what drives
  // placeActivityManual('act-1', 'g1', 'd1', 'b2') without touching dnd-kit.
  async function copySwimPasteOntoSoccer() {
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
    fireEvent.click(scheduleCell('Swim'))
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true })
    fireEvent.click(scheduleCell('Soccer'))
  }

  function flagsWriteFor(slotId) {
    const call = localClient.write.mock.calls.find(
      c => c[1] === 'template_slots' && c[2] === slotId && c[3] === 'flags'
    )
    return call?.[4]
  }

  it('an activity with no eligibility restrictions ("[]" for both fields) is placed with no UNFILLABLE flag', async () => {
    mockList({
      time_blocks: [timeBlock(), timeBlock({ id: 'b2', name: 'Afternoon', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' })],
      activities: [
        activity({ id: 'act-1', name: 'Swim', eligible_tier_ids: '[]', eligible_group_ids: '[]' }),
        activity({ id: 'act-2', name: 'Soccer' }),
      ],
      template_slots: [
        slotRow({ id: 'slot-1', time_block_id: 'b1', activity_id: 'act-1' }),
        slotRow({ id: 'slot-2', time_block_id: 'b2', activity_id: 'act-2' }),
      ],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await copySwimPasteOntoSoccer()

    await waitFor(() => expect(flagsWriteFor('slot-2')).toBeDefined())
    expect(flagsWriteFor('slot-2')).toEqual({})
  })

  it('an activity restricted by eligible_tier_ids that INCLUDES the target group\'s tier is placed with no UNFILLABLE flag', async () => {
    // The positive-match branch — the only case in this block that exercises
    // `.includes()` returning true.
    //
    // Verified: this test passes even with the fix reverted, and that is not a
    // flaw in the test, it is the shape of the bug. Unparsed, `tierIds` was the
    // STRING '["t1"]', and `'["t1"]'.includes('t1')` is a substring hit — so
    // the broken code reached the right answer here by accident. Only the
    // empty-list case ('[]'.length === 2, never 0) came out wrong, which is why
    // exactly one test in this block is red-green sensitive.
    //
    // Keep this one anyway: it is the sole guard against a future change making
    // eligibility over-restrictive for a NON-empty allow-list, which the four
    // UNFILLABLE-asserting siblings cannot catch.
    mockList({
      time_blocks: [timeBlock(), timeBlock({ id: 'b2', name: 'Afternoon', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' })],
      activities: [
        // group() fixture's tier_id is 't1' — this list explicitly allows it.
        activity({ id: 'act-1', name: 'Swim', eligible_tier_ids: '["t1"]', eligible_group_ids: '[]' }),
        activity({ id: 'act-2', name: 'Soccer' }),
      ],
      template_slots: [
        slotRow({ id: 'slot-1', time_block_id: 'b1', activity_id: 'act-1' }),
        slotRow({ id: 'slot-2', time_block_id: 'b2', activity_id: 'act-2' }),
      ],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await copySwimPasteOntoSoccer()

    await waitFor(() => expect(flagsWriteFor('slot-2')).toBeDefined())
    expect(flagsWriteFor('slot-2')).toEqual({})
  })

  it('an activity restricted by eligible_group_ids that INCLUDES the target group is placed with no UNFILLABLE flag', async () => {
    mockList({
      time_blocks: [timeBlock(), timeBlock({ id: 'b2', name: 'Afternoon', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' })],
      activities: [
        // slot-2 is placed into group g1 — this list explicitly allows it.
        activity({ id: 'act-1', name: 'Swim', eligible_tier_ids: '[]', eligible_group_ids: '["g1"]' }),
        activity({ id: 'act-2', name: 'Soccer' }),
      ],
      template_slots: [
        slotRow({ id: 'slot-1', time_block_id: 'b1', activity_id: 'act-1' }),
        slotRow({ id: 'slot-2', time_block_id: 'b2', activity_id: 'act-2' }),
      ],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await copySwimPasteOntoSoccer()

    await waitFor(() => expect(flagsWriteFor('slot-2')).toBeDefined())
    expect(flagsWriteFor('slot-2')).toEqual({})
  })

  it('an activity genuinely restricted by eligible_tier_ids (excludes the target group\'s tier) is still flagged UNFILLABLE', async () => {
    mockList({
      time_blocks: [timeBlock(), timeBlock({ id: 'b2', name: 'Afternoon', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' })],
      activities: [
        // group() fixture's tier_id is 't1' — 't2' deliberately excludes it.
        activity({ id: 'act-1', name: 'Swim', eligible_tier_ids: '["t2"]', eligible_group_ids: '[]' }),
        activity({ id: 'act-2', name: 'Soccer' }),
      ],
      template_slots: [
        slotRow({ id: 'slot-1', time_block_id: 'b1', activity_id: 'act-1' }),
        slotRow({ id: 'slot-2', time_block_id: 'b2', activity_id: 'act-2' }),
      ],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await copySwimPasteOntoSoccer()

    await waitFor(() => expect(flagsWriteFor('slot-2')).toBeDefined())
    expect(flagsWriteFor('slot-2')).toEqual({ UNFILLABLE: true })
  })

  it('an activity genuinely restricted by eligible_group_ids (excludes the target group) is still flagged UNFILLABLE', async () => {
    mockList({
      time_blocks: [timeBlock(), timeBlock({ id: 'b2', name: 'Afternoon', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' })],
      activities: [
        // slot-2 is placed into group g1 — 'g2' deliberately excludes it.
        activity({ id: 'act-1', name: 'Swim', eligible_tier_ids: '[]', eligible_group_ids: '["g2"]' }),
        activity({ id: 'act-2', name: 'Soccer' }),
      ],
      template_slots: [
        slotRow({ id: 'slot-1', time_block_id: 'b1', activity_id: 'act-1' }),
        slotRow({ id: 'slot-2', time_block_id: 'b2', activity_id: 'act-2' }),
      ],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await copySwimPasteOntoSoccer()

    await waitFor(() => expect(flagsWriteFor('slot-2')).toBeDefined())
    expect(flagsWriteFor('slot-2')).toEqual({ UNFILLABLE: true })
  })

  it('locationFull (max_groups_per_slot reached) still flags UNFILLABLE independent of eligibility', async () => {
    mockList({
      time_blocks: [timeBlock(), timeBlock({ id: 'b2', name: 'Afternoon', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' })],
      activities: [
        activity({ id: 'act-1', name: 'Swim', eligible_tier_ids: '[]', eligible_group_ids: '[]', max_groups_per_slot: 1 }),
        activity({ id: 'act-2', name: 'Soccer' }),
      ],
      template_slots: [
        slotRow({ id: 'slot-1', time_block_id: 'b1', activity_id: 'act-1' }),
        slotRow({ id: 'slot-2', time_block_id: 'b2', activity_id: 'act-2' }),
        // Another group already has "Swim" (act-1) at the same day+block —
        // pasting it into slot-2 too would put two groups in one activity
        // slot whose cap is 1.
        slotRow({ id: 'slot-3', group_id: 'g2', time_block_id: 'b2', activity_id: 'act-1' }),
      ],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await copySwimPasteOntoSoccer()

    await waitFor(() => expect(flagsWriteFor('slot-2')).toBeDefined())
    expect(flagsWriteFor('slot-2')).toEqual({ UNFILLABLE: true })
  })
})

// ── Two routes, two candidate schedules ─────────────────────────────────────
//
// The manual route is not a third way of looking at the generated schedule —
// it is a separate week the director builds themselves. Neither is "the"
// schedule; moving between them is navigation and must never cost either one
// its work.
describe('separate manual and generated routes', () => {
  const GENERATED = 'schedule-template:camp-1'
  const MANUAL = 'schedule-template:camp-1:manual'

  function bothRoutes(extra = {}) {
    mockList({
      activities: [activity(), activity({ id: 'act-2', name: 'Archery', min_per_week: 3 })],
      schedule_templates: [
        { id: GENERATED, camp_id: CAMP_ID, name: 'Master Template', kind: 'generated' },
        { id: MANUAL, camp_id: CAMP_ID, name: 'Manual', kind: 'manual' },
      ],
      template_slots: [
        slotRow({ id: 'gen-1', template_id: GENERATED, activity_id: 'act-1' }),
        slotRow({ id: 'man-1', template_id: MANUAL, activity_id: null }),
      ],
      ...extra,
    })
  }

  it('keeps the Manual route always reachable, with no confirmation on switching', async () => {
    bothRoutes()
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Manual')).toBeTruthy())

    fireEvent.click(screen.getByText('Manual'))
    // No "are you sure" of any kind stands between the two routes.
    expect(screen.queryByText(/are you sure/i)).toBeNull()
    expect(screen.queryByText(/Build a new one/)).toBeNull()
  })

  it('does not show the generated schedule’s placements on the manual grid', async () => {
    bothRoutes()
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    fireEvent.click(screen.getByText('Manual'))
    await waitFor(() => expect(screen.getByText('The week you’re building')).toBeTruthy())
    expect(scheduleCell('Swim')).toBeFalsy()
  })

  it('returns each route’s week exactly as it was, in both directions', async () => {
    bothRoutes()
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    fireEvent.click(screen.getByText('Manual'))
    await waitFor(() => expect(scheduleCell('Swim')).toBeFalsy())
    fireEvent.click(screen.getByText('Generated'))
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
  })

  it('never labels either route as the real or current schedule', async () => {
    bothRoutes()
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Manual')).toBeTruthy())

    const body = document.body.textContent
    for (const forbidden of ['active schedule', 'current schedule', 'the real schedule', 'Master Template', 'template', 'candidate', 'UNFILLABLE', 'OVERLAP', 'UNDERSERVED']) {
      expect(body).not.toContain(forbidden)
    }
  })

  it('writes Generate only to the generated schedule, leaving the manual one alone', async () => {
    bothRoutes()
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Regenerate from Scratch')).toBeTruthy())

    fireEvent.click(screen.getByText('Regenerate from Scratch'))
    await waitFor(() => expect(screen.getByText('Build a new one')).toBeTruthy())
    fireEvent.click(screen.getByText('Build a new one'))

    await waitFor(() => {
      expect(localClient.bulkReplace).toHaveBeenCalledWith('token-abc', 'template_slots', GENERATED, expect.any(Array))
    })
    const scopes = localClient.bulkReplace.mock.calls.map(c => c[2])
    expect(scopes).not.toContain(MANUAL)
  })

  it('offers a blank week — not the generated one — when the manual route has not been started', async () => {
    mockList({
      schedule_templates: [{ id: GENERATED, camp_id: CAMP_ID, name: 'Master Template', kind: 'generated' }],
      template_slots: [slotRow({ id: 'gen-1', template_id: GENERATED, activity_id: 'act-1' })],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Manual')).toBeTruthy())
    expect(screen.getByText('not started')).toBeTruthy()

    fireEvent.click(screen.getByText('Manual'))
    await waitFor(() => expect(screen.getByText('Start a blank week')).toBeTruthy())
    expect(scheduleCell('Swim')).toBeFalsy()

    fireEvent.click(screen.getByText('Start a blank week'))
    await waitFor(() => {
      expect(localClient.bulkReplace).toHaveBeenCalledWith('token-abc', 'template_slots', MANUAL, expect.any(Array))
    })
    // kind is written FIRST, or the manual row materialises as a second
    // 'generated' row and is absorbed by the unique index.
    const templateWrites = localClient.write.mock.calls.filter(c => c[1] === 'schedule_templates')
    expect(templateWrites[0][3]).toBe('kind')
    expect(templateWrites[0][4]).toBe('manual')
  })

  it('reports what the week still needs the moment the manual grid opens', async () => {
    bothRoutes()
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Manual')).toBeTruthy())
    fireEvent.click(screen.getByText('Manual'))

    const stillNeeded = () => screen.getAllByText((_, el) => el?.textContent?.trim().startsWith('Still needed'))
      .find(el => el.parentElement?.getAttribute('title') === 'Click to see details')
    await waitFor(() => expect(stillNeeded()).toBeTruthy())
    // Archery needs 3 a week and nothing is placed on the blank grid.
    const tile = stillNeeded().parentElement
    expect(tile.textContent).toContain('1')
    // No "unfillable" anywhere on this route — not in the tiles, not in the legend.
    expect(document.body.textContent).not.toMatch(/nfillable/)
  })
})
