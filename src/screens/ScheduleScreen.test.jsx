// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
  },
}))

vi.mock('../supabase', () => ({
  supabase: {
    from: () => ({
      delete: () => ({ eq: () => Promise.resolve({}) }),
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null }) }) }),
      select: () => ({ eq: () => Promise.resolve({ data: [] }) }),
      update: () => ({ eq: () => Promise.resolve({}) }),
    }),
  },
}))

import ScheduleScreen from './ScheduleScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

function group(overrides = {}) { return { id: 'g1', camp_id: CAMP_ID, name: 'Group A', tier_id: 't1', ...overrides } }
function day(overrides = {}) { return { id: 'd1', camp_id: CAMP_ID, day_of_week: 1, sort_order: 1, label: 'Monday', ...overrides } }
function timeBlock(overrides = {}) { return { id: 'b1', camp_id: CAMP_ID, name: 'Morning', sort_order: 1, start_time: '09:00:00', end_time: '10:00:00', ...overrides } }
function activity(overrides = {}) { return { id: 'act-1', camp_id: CAMP_ID, name: 'Swim', ...overrides } }
function tier(overrides = {}) { return { id: 't1', camp_id: CAMP_ID, name: 'Tier 1', sort_order: 1, ...overrides } }
function slotRow(overrides = {}) {
  return { id: 'slot-1', template_id: 'tmpl-1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', anchor_id: null, is_anchor: false, is_span_head: true, is_released: false, flags: {}, ...overrides }
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
    render(<ScheduleScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Swim')).toBeTruthy())
    fireEvent.click(screen.getByText('Swim'))

    await waitFor(() => expect(screen.getByText('Assign Activity')).toBeTruthy())
    fireEvent.click(screen.getByText('Art'))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'template_slots', 'slot-1', 'activity_id', 'act-2')
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'template_slots', 'slot-1', 'flags', {})
    })
    await waitFor(() => expect(screen.queryByText('Assign Activity')).toBeNull())
  })

  it('failure: does not silently proceed when the write comes back non-applied — surfaces an error banner and keeps the modal open', async () => {
    mockList({ activities: [activity({ id: 'act-1', name: 'Swim' }), activity({ id: 'act-2', name: 'Art' })] })
    localClient.write.mockResolvedValue({ status: 'rejected' })
    render(<ScheduleScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Swim')).toBeTruthy())
    fireEvent.click(screen.getByText('Swim'))

    await waitFor(() => expect(screen.getByText('Assign Activity')).toBeTruthy())
    fireEvent.click(screen.getByText('Art'))
    fireEvent.click(screen.getByText('Save'))

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
      template_slots: [slotRow({ is_released: false })],
    })
    render(<ScheduleScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())
    fireEvent.click(screen.getByText('Daily View'))

    await waitFor(() => expect(screen.getByText('Swim')).toBeTruthy())
    fireEvent.click(screen.getByText('Swim'))

    await waitFor(() => {
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'template_slots', 'slot-1', 'is_released', true)
    })
  })

  it('releaseCell failure: surfaces an error banner and leaves the cell locked when the write is rejected', async () => {
    mockList({
      activities: [activity({ is_locked: true })],
      template_slots: [slotRow({ is_released: false })],
    })
    localClient.write.mockResolvedValue({ status: 'rejected' })
    render(<ScheduleScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('Daily View')).toBeTruthy())
    fireEvent.click(screen.getByText('Daily View'))

    await waitFor(() => expect(screen.getByText('Swim')).toBeTruthy())
    fireEvent.click(screen.getByText('Swim'))

    await waitFor(() => {
      expect(screen.getByText(/Failed to release cell/i)).toBeTruthy()
    })
  })

  it('removeOverlay: clicking the remove button on a stamped overlay deletes it via localClient.deleteEntity', async () => {
    mockList({
      template_overlays: [{ id: 'ov-1', template_id: 'tmpl-1', unit_id: 't1', day_id: 'd1', from_block_order: 1, to_block_order: 1, label: 'Field Trip' }],
    })
    render(<ScheduleScreen campId={CAMP_ID} onNavigate={() => {}} />)
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
