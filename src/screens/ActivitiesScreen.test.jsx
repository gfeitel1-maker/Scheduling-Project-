// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    previewDelete: vi.fn(),
    deleteRecord: vi.fn(),
  },
}))

vi.mock('../data/scheduleRepository', () => ({
  createScheduleRepository: () => ({
    loadWeekExclusions: vi.fn().mockResolvedValue({ activityExclusions: [] }),
    toggleActivityExclusion: vi.fn(),
  }),
}))

import ActivitiesScreen from './ActivitiesScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

function activity(overrides = {}) {
  return {
    id: 'act-1',
    camp_id: CAMP_ID,
    name: 'Archery',
    location: null,
    is_outdoor: 0,
    max_groups_per_slot: 1,
    min_per_week: 0,
    max_per_week: 5,
    span_blocks: 1,
    same_tier_only: 0,
    priority: 'low',
    eligible_tier_ids: '[]',
    eligible_group_ids: '[]',
    prefer_before_day: null,
    prefer_before_day_min: null,
    weather_alternative_id: null,
    notes: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'new-activity-id' })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset().mockImplementation(entity => {
    if (entity === 'activities') return Promise.resolve([])
    if (entity === 'tiers') return Promise.resolve([])
    if (entity === 'groups') return Promise.resolve([])
    return Promise.resolve([])
  })
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.previewDelete.mockReset().mockResolvedValue({
    ok: true, entity: 'activities', entity_id: 'act-1', name: 'Archery',
    destructive: true, slot_count: 0, routes: [], unprotected_count: 0,
    anchor_count: 0, overlay_count: 0, weather_dependent_count: 0,
  })
  localClient.deleteRecord.mockReset().mockResolvedValue({ ok: true, cleared: 0 })
})

describe('ActivitiesScreen quick-add', () => {
  it('appends a name-only activity with normalizeActivity-matching defaults', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('0 activities')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Activity name (e.g. Archery)'), { target: { value: 'Archery' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const fieldsWritten = Object.fromEntries(
      localClient.write.mock.calls.map(c => [c[3], c[4]])
    )
    expect(fieldsWritten.name).toBe('Archery')
    expect(fieldsWritten.camp_id).toBe(CAMP_ID)
    expect(fieldsWritten.location).toBe(null)
    expect(fieldsWritten.is_outdoor).toBe(0) // serialized boolean, matches normalizeActivity's is_outdoor fallback of false
    expect(fieldsWritten.max_groups_per_slot).toBe(1)
    expect(fieldsWritten.min_per_week).toBe(0)
    expect(fieldsWritten.max_per_week).toBe(5)
    expect(fieldsWritten.span_blocks).toBe(1)
    expect(fieldsWritten.same_tier_only).toBe(0)
    expect(fieldsWritten.priority).toBe('low')
    expect(fieldsWritten.eligible_tier_ids).toBe('[]')
    expect(fieldsWritten.eligible_group_ids).toBe('[]')
    expect(fieldsWritten.prefer_before_day).toBe(null)
    expect(fieldsWritten.prefer_before_day_min).toBe(null)
    expect(fieldsWritten.weather_alternative_id).toBe(null)
    expect(fieldsWritten.notes).toBe(null)

    // name written first, matching the create-path convention used across
    // TiersScreen/TimeBlocksScreen/GroupsScreen (UNIQUE collision fails atomically)
    expect(localClient.write.mock.calls[0][3]).toBe('name')
  })

  it('rejects a duplicate name (case-insensitive) without writing', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity({ name: 'Archery' })])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Activity name (e.g. Archery)'), { target: { value: 'archery' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() =>
      expect(screen.queryByText(/An activity with this name already exists/)).not.toBeNull()
    )
    expect(localClient.write).not.toHaveBeenCalled()
  })
})
