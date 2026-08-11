// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within, configure } from '@testing-library/react'

// loadAll() chains ~12 sequential localClient.list()/listByScope() calls before
// the grid replaces "Loading…" — comfortably under RTL's 1000ms default when the
// machine is idle, but not when it isn't. Scoped to this file only (not a vitest
// global timeout), since this component's initial load is genuinely heavier than
// most screens' async settle time, not a symptom of a broken query.
configure({ asyncUtilTimeout: 3000 })

// Captured onOpApplied callbacks so tests can fire synthetic op-applied events.
const opAppliedListeners = []

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    listByScope: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    bulkReplace: vi.fn(),
    onOpApplied: vi.fn((cb) => { opAppliedListeners.push(cb) }),
    getDeviceId: vi.fn(),
  },
}))

import ScheduleScreen from './ScheduleScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

// An activity name (e.g. "Swim") renders in two places: the schedule cell and
// the always-present ActivityPalette sidebar chip. Plain getByText is therefore
// ambiguous — scope to the cell, which is the only occurrence inside one.
//
// T54 converted the GROUP view (the default view these tests render) from a
// <table> to a CSS Grid, so a schedule cell there is now a
// <div role="gridcell">. The remaining three views are still tables until T56,
// and this helper is shared across both, hence the two-part selector. Drop the
// 'td' half when T56 lands.
const CELL_SELECTOR = 'td, [role="gridcell"]'

function scheduleCell(name) {
  return screen.getAllByText(name).find((el) => el.closest(CELL_SELECTOR))
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
    // Programs are part of the required set (src/engine/readiness.js) even
    // though buildSchedule never reads cohorts — three setup screens gate data
    // entry on an active one, so a camp without one cannot have groups.
    cohorts: [{ id: 'coh-1', camp_id: CAMP_ID, name: 'Main Session' }],
    // One week (Slice 1). Its id is CAMP_ID by fixture convention: template ids
    // are deriveScheduleTemplateId(weekId, kind), so a week keyed to CAMP_ID
    // keeps the existing 'schedule-template:camp-1' ids the slot fixtures use,
    // avoiding a rename across every fixture (docs/adr/2026-08-02-schedule-weeks-first-class.md).
    schedule_weeks: [{ id: CAMP_ID, camp_id: CAMP_ID, name: 'Week 1', sort_order: 0, is_archived: 0 }],
    schedule_templates: [{ id: 'schedule-template:camp-1', camp_id: CAMP_ID, name: 'Generated', kind: 'generated', week_id: CAMP_ID }],
    template_slots: [slotRow()],
    template_overlays: [],
    schedule_snapshots: [],
  }
  const merged = { ...base, ...overridesByEntity }
  localClient.list.mockImplementation((entity) => Promise.resolve(merged[entity] ?? []))
  // Mirrors main.js's PARENT_SCOPED_ENTITIES parentKey for the entities
  // reloadSlots/reloadOverlays actually call listByScope for.
  const scopeKeyByEntity = { template_slots: 'template_id', template_overlays: 'template_id' }
  localClient.listByScope.mockImplementation((entity, scopeId) => {
    const key = scopeKeyByEntity[entity]
    return Promise.resolve((merged[entity] ?? []).filter((row) => row[key] === scopeId))
  })
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
  localClient.listByScope.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.bulkReplace.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.onOpApplied.mockReset().mockImplementation((cb) => { opAppliedListeners.push(cb) })
  localClient.getDeviceId.mockReset().mockResolvedValue('device-local')
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
      .find(el => el.parentElement?.getAttribute('title') === 'Click to review these')

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

    const cells = screen.getAllByText('Swim').filter((el) => el.closest(CELL_SELECTOR))
    expect(cells).toHaveLength(1)
    // The span is now expressed as `grid-row: <n> / span 2` plus aria-rowspan
    // rather than the rowSpan attribute (T54). The assertion — one element,
    // two blocks tall — is unchanged.
    const cell = cells[0].closest(CELL_SELECTOR)
    expect(cell.getAttribute('aria-rowspan')).toBe('2')
    expect(cell.style.gridRow).toMatch(/\/ span 2$/)
  })

  it('recalcStats: `is_anchor === false` counts DB-loaded non-anchor slots instead of reporting 0/0 after every reload', async () => {
    mockList()
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    // Label is "Placed" on both routes since T18; the value reads "1 of 1"
    // rather than "1/1" for the same reason — a director reads words, not ratios.
    await waitFor(() => expect(screen.getByText('Placed')).toBeTruthy())
    expect(screen.getByText('Placed').parentElement.textContent).toContain('1 of 1')
  })
})

// Round 2 B2: loadAll() previously never called buildSchedule() or otherwise
// populated `findings`, so the Underserved/Distribution badges silently read
// 0 (neutral gray — visually "all clear") for an EXISTING schedule that was
// simply opened, never regenerated in this session. This is the ordinary
// director path — nobody regenerates just to look.
describe('findings recompute on load without regenerating (Round 2 B2)', () => {
  it('loadAll(): the still-needed badge reflects persisted slot counts on initial render, before Generate is ever clicked', async () => {
    mockList({
      activities: [activity({ id: 'act-1', name: 'Swim', min_per_week: 3, eligible_tier_ids: [], eligible_group_ids: [] })],
      template_slots: [slotRow({ activity_id: 'act-1' })], // only 1 placement, needs 3
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    // "Underserved" is the engine's word; the tile says "Still needed" since T18.
    await waitFor(() => expect(screen.getByText(/Still needed/)).toBeTruthy())
    const badge = screen.getByText(/Still needed/).parentElement
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

  // Regression (reported): opening the edit modal on a FILLED cell and pressing
  // Save without touching the list blanked the cell. EditModal initialised its
  // selection from `slot.activityId` (camelCase), but the slot object threaded
  // through onEdit/setEditSlot carries `activity_id` (snake_case, DB shape) — so
  // the current activity was never pre-selected, the list sat on "Clear slot",
  // and Save wrote activity_id: null. The director's mental model is "I opened
  // this to look at it / tweak it", not "I asked to erase it".
  it('preselection: opening the modal on a filled cell and saving unchanged keeps the activity (does not blank the cell)', async () => {
    mockList({ activities: [activity({ id: 'act-1', name: 'Swim' }), activity({ id: 'act-2', name: 'Art' })] })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
    fireEvent.doubleClick(scheduleCell('Swim'))

    await waitFor(() => expect(screen.getByText('Assign Activity')).toBeTruthy())
    // Save WITHOUT selecting anything — the current activity must already be the
    // active choice.
    fireEvent.click(within(editModal()).getByText('Save'))

    await waitFor(() => expect(screen.queryByText('Assign Activity')).toBeNull())
    // The cell must still show Swim, and no clearing write may have happened.
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
    const clearedWrite = localClient.write.mock.calls.find(
      c => c[1] === 'template_slots' && c[2] === 'slot-1' && c[3] === 'activity_id' && c[4] === null
    )
    expect(clearedWrite).toBeUndefined()
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
      // T18: 'slot' is the template_slots row, not a word a director uses.
      expect(screen.getByText(/That cell could not be saved/i)).toBeTruthy()
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
      // T18: 'released' is the is_released column; the director unlocks a cell.
      expect(screen.getByText(/That cell could not be unlocked/i)).toBeTruthy()
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
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())
    fireEvent.click(screen.getByText('Daily View'))

    await waitFor(() => expect(screen.getByText('📋 Versions ▾')).toBeTruthy())
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
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())
    fireEvent.click(screen.getByText('Daily View'))

    await waitFor(() => expect(screen.getByText('📋 Versions ▾')).toBeTruthy())
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
      // T18: the menu says Versions; 'snapshot' appears nowhere the director sees.
      expect(screen.getByText(/That version could not be renamed/i)).toBeTruthy()
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

    fireEvent.click(screen.getByText('Rebuild this schedule'))
    await waitFor(() => expect(screen.getByText('Rebuild it')).toBeTruthy())
    fireEvent.click(screen.getByText('Rebuild it'))

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
    // Two consecutive waitFor calls: the second one forces a macrotask boundary
    // so any weekId-triggered secondary loadAll() can fire and settle before
    // we query cells for interaction.
    await waitFor(() => {
      expect(scheduleCell('Swim')).toBeTruthy()
      expect(scheduleCell('Soccer')).toBeTruthy()
    })
    await waitFor(() => {
      expect(scheduleCell('Swim')).toBeTruthy()
      expect(scheduleCell('Soccer')).toBeTruthy()
    })
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
        { id: GENERATED, camp_id: CAMP_ID, name: 'Generated', kind: 'generated', week_id: CAMP_ID },
        { id: MANUAL, camp_id: CAMP_ID, name: 'Manual', kind: 'manual', week_id: CAMP_ID },
      ],
      template_slots: [
        slotRow({ id: 'gen-1', template_id: GENERATED, activity_id: 'act-1' }),
        slotRow({ id: 'man-1', template_id: MANUAL, activity_id: null }),
      ],
      ...extra,
    })
  }

  // Route selection lives in the left sidebar (App.jsx SCREENS ->
  // 'schedule:manual' / 'schedule:generated'), so switching route is the shell
  // re-rendering this screen with a different initialRoute. These tests drive
  // it exactly the way the sidebar does.
  const routeScreen = (initialRoute) => (
    <ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} initialRoute={initialRoute} />
  )

  it('keeps the Manual route always reachable, with no confirmation on switching', async () => {
    bothRoutes()
    const { rerender } = render(routeScreen('generated'))
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    rerender(routeScreen('manual'))
    // No "are you sure" of any kind stands between the two routes.
    expect(screen.queryByText(/are you sure/i)).toBeNull()
    expect(screen.queryByText(/Rebuild it/)).toBeNull()
  })

  it('does not show the generated schedule’s placements on the manual grid', async () => {
    bothRoutes()
    const { rerender } = render(routeScreen('generated'))
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    rerender(routeScreen('manual'))
    await waitFor(() => expect(screen.getByText('The week you’re building')).toBeTruthy())
    expect(scheduleCell('Swim')).toBeFalsy()
  })

  it('returns each route’s week exactly as it was, in both directions', async () => {
    bothRoutes()
    const { rerender } = render(routeScreen('generated'))
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    rerender(routeScreen('manual'))
    await waitFor(() => expect(scheduleCell('Swim')).toBeFalsy())
    rerender(routeScreen('generated'))
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
  })

  // Round 2. The neutral 'schedule' screen key (CampSetup / AnchorsScreen
  // "Next: Schedule") supplies no route. Falling through to a default would be
  // the app choosing a director's week for them.
  it('asks which week to open when the neutral entry is used and both exist', async () => {
    bothRoutes()
    const navigated = []
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={(s) => navigated.push(s)} />)
    await waitFor(() => expect(screen.getByText('Which week do you want to open?')).toBeTruthy())
    // Nothing of either week is on screen until the director picks.
    expect(screen.queryAllByText('Swim').some(el => el.closest(CELL_SELECTOR))).toBe(false)

    fireEvent.click(screen.getByText('Manual'))
    await waitFor(() => expect(screen.getByText('The week you’re building')).toBeTruthy())
    expect(navigated).toContain('schedule:manual')
  })

  it('does not ask when only one week exists — there is no choice to make', async () => {
    mockList({
      schedule_templates: [{ id: GENERATED, camp_id: CAMP_ID, name: 'Generated', kind: 'generated', week_id: CAMP_ID }],
      template_slots: [slotRow({ id: 'gen-1', template_id: GENERATED, activity_id: 'act-1' })],
    })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
    expect(screen.queryByText('Which week do you want to open?')).toBeFalsy()
  })

  it('never labels either route as the real or current schedule', async () => {
    bothRoutes()
    const { rerender } = render(routeScreen('generated'))
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    const check = () => {
      const body = document.body.textContent
      for (const forbidden of ['active schedule', 'current schedule', 'the real schedule', 'Master Template', 'template', 'candidate', 'UNFILLABLE', 'OVERLAP', 'UNDERSERVED']) {
        expect(body).not.toContain(forbidden)
      }
    }
    check()
    rerender(routeScreen('manual'))
    await waitFor(() => expect(screen.getByText('The week you’re building')).toBeTruthy())
    check()
  })

  it('writes Generate only to the generated schedule, leaving the manual one alone', async () => {
    bothRoutes()
    render(routeScreen('generated'))
    await waitFor(() => expect(screen.getByText('Rebuild this schedule')).toBeTruthy())

    fireEvent.click(screen.getByText('Rebuild this schedule'))
    await waitFor(() => expect(screen.getByText('Rebuild it')).toBeTruthy())
    fireEvent.click(screen.getByText('Rebuild it'))

    await waitFor(() => {
      expect(localClient.bulkReplace).toHaveBeenCalledWith('token-abc', 'template_slots', GENERATED, expect.any(Array))
    })
    const scopes = localClient.bulkReplace.mock.calls.map(c => c[2])
    expect(scopes).not.toContain(MANUAL)
  })

  it('offers a blank week — not the generated one — when the manual route has not been started', async () => {
    mockList({
      schedule_templates: [{ id: GENERATED, camp_id: CAMP_ID, name: 'Generated', kind: 'generated', week_id: CAMP_ID }],
      template_slots: [slotRow({ id: 'gen-1', template_id: GENERATED, activity_id: 'act-1' })],
    })
    render(routeScreen('manual'))
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
    render(routeScreen('manual'))

    const stillNeeded = () => screen.getAllByText((_, el) => el?.textContent?.trim().startsWith('Still needed'))
      .find(el => el.parentElement?.getAttribute('title') === 'Click to review these')
    await waitFor(() => expect(stillNeeded()).toBeTruthy())
    // Archery needs 3 a week and nothing is placed on the blank grid.
    const tile = stillNeeded().parentElement
    expect(tile.textContent).toContain('1')
    // No "unfillable" anywhere on this route — not in the tiles, not in the legend.
    expect(document.body.textContent).not.toMatch(/nfillable/)
  })

  it('generated: clicking a concern box opens its list, shows the reason, and Accept clears it', async () => {
    // docs/work/specs/2026-08-01-generated-flag-review.md — the "track changes"
    // review. The box is a toggle (aria-pressed), the list shows the per-cell
    // reason, and dismiss reads as "Accept" (I can live with this).
    bothRoutes({
      template_slots: [
        slotRow({ id: 'gen-1', template_id: GENERATED, activity_id: null, flags: JSON.stringify({ UNFILLABLE: true, UNFILLABLE_reason: 'No activity this group can do fits here' }) }),
        slotRow({ id: 'man-1', template_id: MANUAL, activity_id: null }),
      ],
    })
    render(routeScreen('generated'))

    // The clickable concern box is the one Unfillable label with aria-pressed;
    // the static legend entry has none.
    const boxLabel = () => screen.getAllByText(/Unfillable/).find(el => el.parentElement?.hasAttribute('aria-pressed'))
    await waitFor(() => expect(boxLabel()).toBeTruthy())
    expect(boxLabel().parentElement.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(boxLabel().parentElement)

    await waitFor(() => expect(screen.getByText('Accept')).toBeTruthy())
    // Two occurrences since T54: the concern list, and the lit cell's own
    // reason callout. The callout used to be mounted only while hovered; it is
    // now always mounted and revealed by `.cell:hover .cell-reason` in
    // scheduleGrid.css, which is also what removes it from the accessibility
    // tree (display: none) when not shown. jsdom applies no stylesheet, so
    // both are queryable here.
    const reasons = screen.getAllByText('No activity this group can do fits here')
    // Exactly two, and one of each kind — a bare `> 0` would pass if the callout
    // started rendering on every cell instead of only the lit one.
    expect(reasons).toHaveLength(2)
    expect(reasons.filter(el => el.closest('.cell-reason'))).toHaveLength(1)
    expect(boxLabel().parentElement.getAttribute('aria-pressed')).toBe('true')

    // Toggling the same box off closes the list.
    fireEvent.click(boxLabel().parentElement)
    await waitFor(() => expect(screen.queryByText('Accept')).toBeNull())
  })
})

// A camp whose generated schedule_templates row carries a RANDOM UUID id —
// the real-world starting state for any camp whose row was minted after
// migration v21 by a renderer that still used crypto.randomUUID(). The
// existing route tests all use the DERIVED id, which can never collide with
// itself, so this defect was invisible to every one of them.
describe('ScheduleScreen — camp whose generated template has a random UUID id', () => {
  const UUID = '48485127-57b0-42d9-b889-61d05d639ae7'
  const MANUAL = 'schedule-template:camp-1:manual'
  const DERIVED = 'schedule-template:camp-1'

  function uuidCamp(extra = {}) {
    mockList({
      schedule_templates: [{ id: UUID, camp_id: CAMP_ID, name: 'Generated', kind: 'generated', week_id: CAMP_ID }],
      template_slots: [slotRow({ id: 'gen-1', template_id: UUID, activity_id: 'act-1' })],
      ...extra,
    })
  }

  const routeScreen = (initialRoute) => (
    <ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} initialRoute={initialRoute} />
  )

  it('C2: resolves the generated route to the UUID row and renders its week', async () => {
    uuidCamp()
    render(routeScreen('generated'))
    // Pre-fix this rendered an EMPTY week: the derived id matched no row, so
    // the route read as "not started".
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
  })

  it('C3: generate() writes to the UUID id and mints no schedule_templates row', async () => {
    uuidCamp()
    render(routeScreen('generated'))
    await waitFor(() => expect(screen.getByText('Rebuild this schedule')).toBeTruthy())

    fireEvent.click(screen.getByText('Rebuild this schedule'))
    await waitFor(() => expect(screen.getByText('Rebuild it')).toBeTruthy())
    fireEvent.click(screen.getByText('Rebuild it'))

    await waitFor(() => {
      expect(localClient.bulkReplace).toHaveBeenCalledWith('token-abc', 'template_slots', UUID, expect.any(Array))
    })
    const scopes = localClient.bulkReplace.mock.calls.map(c => c[2])
    expect(scopes).not.toContain(DERIVED)
    // The row already exists — nothing may be written for it, or the insert
    // loses silently to UNIQUE(camp_id, kind).
    expect(localClient.write.mock.calls.filter(c => c[1] === 'schedule_templates')).toHaveLength(0)
  })

  it('C4: the manual route still mints and writes its own row on the same camp', async () => {
    uuidCamp()
    render(routeScreen('manual'))
    await waitFor(() => expect(screen.getByText('Start a blank week')).toBeTruthy())
    fireEvent.click(screen.getByText('Start a blank week'))

    await waitFor(() => {
      expect(localClient.bulkReplace).toHaveBeenCalledWith('token-abc', 'template_slots', MANUAL, expect.any(Array))
    })
    const templateWrites = localClient.write.mock.calls.filter(c => c[1] === 'schedule_templates')
    expect(templateWrites[0][2]).toBe(MANUAL)
    expect(templateWrites[0][3]).toBe('kind')
    expect(templateWrites[0][4]).toBe('manual')
  })

  it('C5: slots under a template_id with no row render nothing and crash nothing', async () => {
    // Exactly the orphan set migration v24 deliberately LEAVES in place when a
    // competing week exists. loadAll gates every route on the parent row, so
    // an orphan week can never be shown — that gate is what makes leaving them
    // safe, so it is asserted rather than assumed.
    uuidCamp({
      template_slots: [
        slotRow({ id: 'gen-1', template_id: UUID, activity_id: 'act-1' }),
        slotRow({ id: 'orphan-1', template_id: DERIVED, activity_id: 'act-1' }),
        slotRow({ id: 'orphan-2', template_id: MANUAL, activity_id: 'act-1' }),
      ],
    })
    const { rerender } = render(routeScreen('generated'))
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    // The manual route has no schedule_templates row: its orphan slot must not
    // appear as a started week.
    rerender(routeScreen('manual'))
    await waitFor(() => expect(screen.getByText('Start a blank week')).toBeTruthy())
    expect(scheduleCell('Swim')).toBeFalsy()
  })
})

describe('ScheduleScreen — generate() is route-explicit', () => {
  const GENERATED = 'schedule-template:camp-1'
  const MANUAL = 'schedule-template:camp-1:manual'

  it('builds the GENERATED week regardless of the route in closure', async () => {
    // Originally this rendered initialRoute="manual" to put 'manual' in the
    // route closure while the generated offer was still on screen — the offers
    // call setRoute(r) immediately before startRoute[r](), and setRoute does not
    // apply inside that handler, so generate() ran with the OLD route in scope.
    //
    // That path no longer exists. `fix: when arriving via a specific schedule
    // sidebar link, show only that route's offer` (a3f1f9e) means initialRoute
    // ="manual" shows ONLY the manual offer, so the closure mismatch is
    // unreachable through the UI. Both offers survive on the NEUTRAL entry (no
    // initialRoute), which is what this now drives.
    //
    // What is still guarded, and why this test stays: generate() must write to
    // the GENERATED template and must never touch the MANUAL candidate. The
    // closure-mismatch trigger is gone; writing to the wrong scope is not.
    mockList({ schedule_templates: [], template_slots: [] })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Generate a schedule')).toBeTruthy())

    fireEvent.click(screen.getByText('Generate a schedule'))

    await waitFor(() => {
      expect(localClient.bulkReplace).toHaveBeenCalledWith('token-abc', 'template_slots', GENERATED, expect.any(Array))
    })
    // The manual candidate is never read, moved or cleared by a generate.
    const scopes = localClient.bulkReplace.mock.calls.map(c => c[2])
    expect(scopes).not.toContain(MANUAL)
    const templateWrites = localClient.write.mock.calls.filter(c => c[1] === 'schedule_templates')
    expect(templateWrites.map(c => c[2])).not.toContain(MANUAL)
    expect(templateWrites[0][3]).toBe('kind')
    expect(templateWrites[0][4]).toBe('generated')

    // And the manual route on screen is still un-started. Pre-fix, generate()'s
    // setSlots/setStats/setFindings were the CURRENT route's, so the generated
    // week was painted onto the manual candidate's state.
    await waitFor(() => expect(screen.getByText('Start a blank week')).toBeTruthy())
  })

  // Round 2. The assertion above locks the WRITE scope but NOT the setters:
  // with a static list mock, the post-write re-read returns nothing, so
  // reverting generate()'s setters to the current route leaves it green
  // (verified by mutating the source and watching it pass). This one makes the
  // setter half observable — bulkReplace feeds the store the re-read reads, so
  // a current-route setter paints the generated week onto the MANUAL grid.
  it('never paints the generated week onto the manual grid it was launched from', async () => {
    const store = {
      groups: [group()],
      days_of_operation: [day()],
      time_blocks: [timeBlock()],
      activities: [activity()],
      anchor_activities: [],
      tiers: [tier()],
      cohorts: [{ id: 'coh-1', camp_id: CAMP_ID, name: 'Main Session' }],
      schedule_weeks: [{ id: CAMP_ID, camp_id: CAMP_ID, name: 'Week 1', sort_order: 0, is_archived: 0 }],
      schedule_templates: [],
      template_slots: [],
      template_overlays: [],
      schedule_snapshots: [],
    }
    localClient.list.mockImplementation((entity) => Promise.resolve(store[entity] ?? []))
    localClient.listByScope.mockImplementation((entity, scopeId) =>
      Promise.resolve((store[entity] ?? []).filter((row) => row.template_id === scopeId))
    )
    localClient.bulkReplace.mockImplementation((_t, entity, templateId, rows) => {
      store[entity] = [
        ...(store[entity] ?? []).filter(r => r.template_id !== templateId),
        ...rows.map((r, i) => ({ ...r, id: `${templateId}-${i}`, is_anchor: r.is_anchor === '1' ? 1 : 0, is_span_head: r.is_span_head === '1' ? 1 : 0, is_released: 0, flags: {} })),
      ]
      return Promise.resolve({ status: 'applied' })
    })

    // Neutral entry — see the note on the previous test. a3f1f9e removed the
    // initialRoute="manual" path that used to show both offers; the neutral
    // entry is where the two-route picker still lives.
    const { rerender } = render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Generate a schedule')).toBeTruthy())

    fireEvent.click(screen.getByText('Generate a schedule'))

    await waitFor(() => {
      expect(localClient.bulkReplace).toHaveBeenCalledWith('token-abc', 'template_slots', GENERATED, expect.any(Array))
    })
    // The generated week must land in GENERATED state only. Switching to the
    // manual route on the SAME mount is what makes the setter half observable:
    // if generate()'s setSlots/setStats/setFindings were the current route's,
    // the generated week would now be sitting on the manual candidate.
    // rerender (not a fresh render) is load-bearing — route state is per mount,
    // so remounting would discard the very state this is checking.
    rerender(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} initialRoute="manual" />)
    await waitFor(() => expect(screen.getByText('Start a blank week')).toBeTruthy())
    expect(scheduleCell('Swim')).toBeFalsy()

    // And at the data layer: nothing was ever written into the manual candidate.
    const manualSlots = (store.template_slots ?? []).filter(r => r.template_id === MANUAL)
    expect(manualSlots).toHaveLength(0)
  })
})

// Round 2 — the two routes are two sidebar destinations but ONE mounted
// component, so component state survives the switch unless it is cleared.
describe('ScheduleScreen — switching routes cannot carry work across candidates', () => {
  const GENERATED = 'schedule-template:camp-1'
  const MANUAL = 'schedule-template:camp-1:manual'

  const routeScreen = (initialRoute) => (
    <ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} initialRoute={initialRoute} />
  )

  it('drops the clipboard and the selection when the director navigates to the other route', async () => {
    mockList({
      schedule_templates: [
        { id: GENERATED, camp_id: CAMP_ID, name: 'Generated', kind: 'generated', week_id: CAMP_ID },
        { id: MANUAL, camp_id: CAMP_ID, name: 'Manual', kind: 'manual', week_id: CAMP_ID },
      ],
      template_slots: [
        slotRow({ id: 'gen-1', template_id: GENERATED, activity_id: 'act-1' }),
        slotRow({ id: 'man-1', template_id: MANUAL, activity_id: null }),
      ],
    })
    const { rerender } = render(routeScreen('generated'))
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    // Select the generated week's cell and copy it (Ctrl+A then Ctrl+C is the
    // documented shortcut pair).
    // Re-fired inside waitFor on purpose: the shortcut listeners are attached
    // in an effect, and under full-suite load a single early keydown can land
    // before that effect runs (observed as a flake). Retrying the key press is
    // deterministic; a longer timeout on a one-shot press is not.
    await waitFor(() => {
      fireEvent.keyDown(window, { key: 'a', ctrlKey: true })
      fireEvent.keyDown(window, { key: 'c', ctrlKey: true })
      expect(document.body.textContent).toMatch(/to paste/)
    })

    rerender(routeScreen('manual'))
    // Paste mode carrying the OTHER candidate's cells is exactly the
    // cross-candidate write the route separation exists to prevent.
    await waitFor(() => expect(document.body.textContent).not.toMatch(/to paste/))
  })

  it('drops the undo stack when the director navigates to the other route', async () => {
    mockList({
      activities: [activity(), activity({ id: 'act-2', name: 'Art' })],
      schedule_templates: [
        { id: GENERATED, camp_id: CAMP_ID, name: 'Generated', kind: 'generated', week_id: CAMP_ID },
        { id: MANUAL, camp_id: CAMP_ID, name: 'Manual', kind: 'manual', week_id: CAMP_ID },
      ],
      template_slots: [
        slotRow({ id: 'gen-1', template_id: GENERATED, activity_id: 'act-1' }),
        slotRow({ id: 'man-1', template_id: MANUAL, activity_id: null }),
      ],
    })
    const { rerender } = render(routeScreen('generated'))
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    fireEvent.doubleClick(scheduleCell('Swim'))
    await waitFor(() => expect(screen.getByText('Assign Activity')).toBeTruthy())
    fireEvent.click(within(editModal()).getByText('Art'))
    fireEvent.click(within(editModal()).getByText('Save'))
    await waitFor(() => expect(screen.getByTitle(/^Undo: /)).toBeTruthy())

    rerender(routeScreen('manual'))
    // An undo entry made on the generated week closed over that route's
    // setters and slot ids; replaying it from the manual grid would rewrite
    // the candidate the director is not looking at.
    await waitFor(() => expect(screen.getByTitle('Nothing to undo')).toBeTruthy())
  })
})

// Round 2 — ensureTemplateRow throws on any non-applied write (including the
// (camp_id, kind) backstop in electron/ops/projections.js). Unguarded, that
// left `generating` true forever with no banner: a spinner that never ends.
describe('ScheduleScreen — a rejected schedule_templates write is reported, not hung', () => {
  it('generate(): surfaces an error and stops generating instead of spinning forever', async () => {
    mockList({ schedule_templates: [], template_slots: [] })
    localClient.write.mockResolvedValue({ status: 'rejected' })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} initialRoute="generated" />)
    await waitFor(() => expect(screen.getByText('Generate a schedule')).toBeTruthy())

    fireEvent.click(screen.getByText('Generate a schedule'))

    await waitFor(() => expect(screen.getByText(/Could not open the generated schedule/i)).toBeTruthy())
    // Nothing was written to any week.
    expect(localClient.bulkReplace).not.toHaveBeenCalled()
  })

  it('placeAnchors(): surfaces an error and stops generating instead of spinning forever', async () => {
    mockList({ schedule_templates: [], template_slots: [] })
    localClient.write.mockResolvedValue({ status: 'rejected' })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} initialRoute="manual" />)
    await waitFor(() => expect(screen.getByText('Start a blank week')).toBeTruthy())

    fireEvent.click(screen.getByText('Start a blank week'))

    await waitFor(() => expect(screen.getByText(/Could not open the manual schedule/i)).toBeTruthy())
    expect(localClient.bulkReplace).not.toHaveBeenCalled()
  })
})

// T18. The two routes were deliberately given a shared flag vocabulary so a
// director learns it once. The stat tiles quietly broke that: every label was a
// ternary on isManual, so the SAME finding was called "Still needed" on one
// route and "Underserved" on the other. This locks the rule that survived the
// fix — one concept, one name; different concepts keep different names.
describe('T18: one concept has one name on both routes', () => {
  it('shows the director-facing name and never the engine word', async () => {
    // "Underserved" and "Distribution" are the engine's own vocabulary. They
    // leaked into the interface; Article V says the director's words win. The
    // defect was that the SAME finding was called one thing on the manual route
    // and another on the generated one, so a director learned it twice.
    mockList({ template_slots: [slotRow()] })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    expect(screen.getByText('Still needed')).toBeTruthy()
    expect(screen.getByText('Spread across the week')).toBeTruthy()
    expect(screen.getByText('Placed')).toBeTruthy()
    expect(screen.queryByText('Underserved')).toBeNull()
    expect(screen.queryByText('Distribution')).toBeNull()
    expect(screen.queryByText('Filled')).toBeNull()
  })

  it('keeps Unfillable distinct — it is a different concept, not a synonym', async () => {
    // The routes share a flag VOCABULARY, not an identical flag SET. Collapsing
    // Unfillable and Overlapping would be the opposite error to the one fixed.
    mockList({ template_slots: [slotRow()] })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    // On the generated route Unfillable is present and Overlapping is not —
    // the engine never makes a clashing placement, and an empty manual cell is
    // "not filled yet" rather than unfillable. Note the stat badge carries a
    // title only when it is clickable (count > 0), so do not key off that.
    expect(screen.getAllByText(/Unfillable/).length).toBeGreaterThan(0)
    expect(screen.queryByText('Overlapping')).toBeNull()
  })
})

// T3 / T4 / T5 — merge, split, copy/paste and the displaced tray were all
// marked completed with ZERO dedicated test coverage. The product owner
// reported all three as broken on 2026-07-29; driving the real app showed they
// work in Group View, so the report was about discoverability, not function.
// These tests exist so the next such report can be answered by the suite rather
// than by an hour of clicking.
describe('T4: merging a cell down', () => {
  function twoBlocks() {
    mockList({
      time_blocks: [timeBlock(), timeBlock({ id: 'b2', name: 'Afternoon', sort_order: 2, start_time: '10:00:00', end_time: '11:00:00' })],
      activities: [activity(), activity({ id: 'act-2', name: 'Archery' })],
      template_slots: [
        slotRow({ id: 'slot-1', time_block_id: 'b1', activity_id: 'act-1' }),
        slotRow({ id: 'slot-2', time_block_id: 'b2', activity_id: 'act-2' }),
      ],
    })
  }

  it('marks the tail as part of the span rather than deleting it', async () => {
    // The merge must not destroy the tail row — undo has to be able to put it
    // back, and the op log records a field change, not a removal.
    twoBlocks()
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    fireEvent.pointerOver(scheduleCell('Swim').closest(CELL_SELECTOR))
    const mergeBtn = await screen.findByTitle(/run into the next period/i)
    expect(mergeBtn, 'merge affordance should exist on a cell with a block below it').toBeTruthy()
    fireEvent.click(mergeBtn)

    await waitFor(() => {
      // write(token, entity, id, field, value) — one call per field.
      const spanHeadWrites = localClient.write.mock.calls
        .filter(c => c[1] === 'template_slots' && c[3] === 'is_span_head')
      expect(spanHeadWrites.length).toBeGreaterThan(0)
    })
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('returns the displaced activity to the left palette instead of dropping it', async () => {
    // The drag-first-placement rebuild retired the floating "Displaced
    // Activities" tray (its only consumer was this merge-down flow, which is
    // otherwise untouched — see spec 2026-08-09). The invariant it protected
    // still holds under the new unified semantic: a displaced activity is
    // never deleted, and once no slot references it, the left ActivityPalette
    // re-derives it as unplaced/available on its own — no separate tray.
    twoBlocks()
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())
    await waitFor(() => expect(scheduleCell('Archery')).toBeTruthy())

    fireEvent.pointerOver(scheduleCell('Swim').closest(CELL_SELECTOR))
    fireEvent.click(await screen.findByTitle(/run into the next period/i))

    await waitFor(() => expect(scheduleCell('Archery')).toBeUndefined())
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    // Still present on screen — in the palette sidebar, not a cell.
    expect(screen.getAllByText('Archery').length).toBeGreaterThan(0)
  })
})

describe('T3: selecting, copying and pasting cells', () => {
  it('selects a cell on cmd/ctrl-click rather than opening the editor', async () => {
    mockList({ template_slots: [slotRow()] })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    fireEvent.click(scheduleCell('Swim').closest(CELL_SELECTOR), { metaKey: true })
    // A plain click opens "Assign Activity"; a modified click must not.
    expect(screen.queryByText('Assign Activity')).toBeNull()
  })

  it('cmd+C on a selection offers the copy to be placed', async () => {
    mockList({ template_slots: [slotRow()] })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    fireEvent.click(scheduleCell('Swim').closest(CELL_SELECTOR), { metaKey: true })
    fireEvent.keyDown(window, { key: 'c', metaKey: true })

    await waitFor(() => expect(screen.getByText(/to paste/i)).toBeTruthy())
    // The banner has to say how to get out again — paste mode swallows clicks.
    expect(screen.getByText(/Esc to cancel/i)).toBeTruthy()
  })

  it('Escape leaves paste mode without writing anything', async () => {
    mockList({ template_slots: [slotRow()] })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    fireEvent.click(scheduleCell('Swim').closest(CELL_SELECTOR), { metaKey: true })
    fireEvent.keyDown(window, { key: 'c', metaKey: true })
    await waitFor(() => expect(screen.getByText(/to paste/i)).toBeTruthy())

    const writesBefore = localClient.write.mock.calls.length
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(/to paste/i)).toBeNull())
    expect(localClient.write.mock.calls.length).toBe(writesBefore)
  })
})

describe('T37: onOpApplied skips loadAll for local-device ops', () => {
  it('does NOT call loadAll (localClient.list) when op.device_id matches the local device', async () => {
    mockList({ template_slots: [slotRow()] })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    // Wait for getDeviceId to resolve so localDeviceIdRef is populated.
    await waitFor(() => expect(localClient.getDeviceId).toHaveBeenCalled())

    const listCallsBefore = localClient.list.mock.calls.length

    // Fire an op-applied event from the local device — loadAll must NOT fire.
    opAppliedListeners.forEach(cb => cb({ device_id: 'device-local', entity: 'template_slots' }))

    // Give any async reload a chance to run.
    await new Promise(r => setTimeout(r, 50))

    expect(localClient.list.mock.calls.length).toBe(listCallsBefore)
  })

  it('DOES call loadAll when op.device_id is a different device (peer write)', async () => {
    mockList({ template_slots: [slotRow()] })
    render(<ScheduleScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(scheduleCell('Swim')).toBeTruthy())

    await waitFor(() => expect(localClient.getDeviceId).toHaveBeenCalled())

    const listCallsBefore = localClient.list.mock.calls.length

    // Fire an op-applied event from a different device — loadAll MUST fire.
    opAppliedListeners.forEach(cb => cb({ device_id: 'device-peer', entity: 'template_slots' }))

    await waitFor(() => expect(localClient.list.mock.calls.length).toBeGreaterThan(listCallsBefore))
  })
})
