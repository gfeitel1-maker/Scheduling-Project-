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

vi.mock('../hooks/useCohorts', () => ({
  useCohorts: () => ({
    cohorts: [{ id: 'cohort-1', camp_id: 'camp-1', name: 'Session 1' }],
    activeCohort: { id: 'cohort-1', camp_id: 'camp-1', name: 'Session 1' },
    setActiveCohortId: () => {},
  }),
}))

vi.mock('../components/CohortPicker', () => ({
  default: () => null,
}))

import DayOverridesScreen from './DayOverridesScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'
const COHORT_ID = 'cohort-1'

function block(overrides = {}) {
  return { id: 'block-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Morning', start_time: '09:00:00', end_time: '10:00:00', sort_order: 1, ...overrides }
}
function activity(overrides = {}) {
  return { id: 'act-1', camp_id: CAMP_ID, name: 'Swim', ...overrides }
}

let idCounter
beforeEach(() => {
  idCounter = 0
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => `new-id-${idCounter++}` })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
})

describe('DayOverridesScreen slot fan-out on save', () => {
  it('saving a new template with 2 block overrides writes exactly 2 slot rows with distinct ids and correct pairs', async () => {
    const blocks = [
      block({ id: 'b1', name: 'Morning', sort_order: 1 }),
      block({ id: 'b2', name: 'Afternoon', sort_order: 2 }),
    ]
    const acts = [activity({ id: 'act-1', name: 'Swim' }), activity({ id: 'act-2', name: 'Art' })]

    localClient.list.mockImplementation((entity) => {
      if (entity === 'day_override_templates') return Promise.resolve([])
      if (entity === 'day_override_template_slots') return Promise.resolve([])
      if (entity === 'time_blocks') return Promise.resolve(blocks)
      if (entity === 'activities') return Promise.resolve(acts)
      return Promise.resolve([])
    })

    render(<DayOverridesScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('No templates yet')).not.toBeNull())

    fireEvent.click(screen.getByText('+ New Template'))
    fireEvent.change(screen.getByPlaceholderText('e.g. Field Trip, Color War, Shabbaton'), { target: { value: 'Field Trip' } })

    await waitFor(() => expect(screen.getByText('Morning')).toBeTruthy())

    // Check both blocks to override them
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    fireEvent.click(checkboxes[1])

    // Assign activities via the newly-shown selects
    const selects = screen.getAllByDisplayValue('— Clear block (free time) —')
    fireEvent.change(selects[0], { target: { value: 'act-1' } })
    fireEvent.change(selects[1], { target: { value: 'act-2' } })

    fireEvent.click(screen.getByText('Create Template'))

    await waitFor(() => {
      const parentCalls = localClient.write.mock.calls.filter(c => c[1] === 'day_override_template_slots' && c[3] === 'day_override_template_id')
      expect(parentCalls.length).toBe(2)
    })

    const slotCalls = localClient.write.mock.calls.filter(c => c[1] === 'day_override_template_slots')
    const idsByField = (field) => slotCalls.filter(c => c[3] === field).map(c => [c[2], c[4]])

    const parentPairs = idsByField('day_override_template_id')
    const ids = parentPairs.map(([id]) => id)
    expect(new Set(ids).size).toBe(2)

    const blockPairs = Object.fromEntries(idsByField('time_block_id'))
    const activityPairs = Object.fromEntries(idsByField('activity_id'))

    const byBlock = {}
    for (const id of ids) {
      byBlock[blockPairs[id]] = activityPairs[id]
    }
    expect(byBlock).toEqual({ b1: 'act-1', b2: 'act-2' })
  })
})

describe('DayOverridesScreen frequency-mode control hidden until built', () => {
  it('does not render the "(coming soon)" frequency control in the modal', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'time_blocks') return Promise.resolve([block()])
      if (entity === 'activities') return Promise.resolve([activity()])
      return Promise.resolve([])
    })
    render(<DayOverridesScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('No templates yet')).not.toBeNull())

    fireEvent.click(screen.getByText('+ New Template'))
    await waitFor(() => expect(screen.getByPlaceholderText('e.g. Field Trip, Color War, Shabbaton')).toBeTruthy())

    // The half-built "coming soon" choice must not appear anywhere (modal or list header).
    expect(screen.queryByText(/coming soon/i)).toBeNull()
    expect(screen.queryByText('How often activities run')).toBeNull()
  })

  it('still persists the default frequency_mode "reduced" on save so the field stays forward-compatible', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'time_blocks') return Promise.resolve([block()])
      if (entity === 'activities') return Promise.resolve([activity()])
      return Promise.resolve([])
    })
    render(<DayOverridesScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('No templates yet')).not.toBeNull())

    fireEvent.click(screen.getByText('+ New Template'))
    fireEvent.change(screen.getByPlaceholderText('e.g. Field Trip, Color War, Shabbaton'), { target: { value: 'Trip Day' } })
    fireEvent.click(screen.getByText('Create Template'))

    await waitFor(() => {
      const freqWrites = localClient.write.mock.calls.filter(
        (c) => c[1] === 'day_override_templates' && c[3] === 'frequency_mode'
      )
      expect(freqWrites.length).toBeGreaterThan(0)
      expect(freqWrites.every((c) => c[4] === 'reduced')).toBe(true)
    })
  })
})

describe('DayOverridesScreen re-save replaces slots', () => {
  it('re-saving an existing template with a different slot set deletes old slot rows and creates new ones', async () => {
    const existingTemplate = { id: 'tmpl-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Field Trip', frequency_mode: 'reduced' }
    const existingSlots = [
      { id: 'slot-old-1', day_override_template_id: 'tmpl-1', time_block_id: 'b1', activity_id: 'act-1' },
    ]
    const blocks = [
      block({ id: 'b1', name: 'Morning', sort_order: 1 }),
      block({ id: 'b2', name: 'Afternoon', sort_order: 2 }),
    ]
    const acts = [activity({ id: 'act-1', name: 'Swim' }), activity({ id: 'act-2', name: 'Art' })]

    localClient.list.mockImplementation((entity) => {
      if (entity === 'day_override_templates') return Promise.resolve([existingTemplate])
      if (entity === 'day_override_template_slots') return Promise.resolve(existingSlots)
      if (entity === 'time_blocks') return Promise.resolve(blocks)
      if (entity === 'activities') return Promise.resolve(acts)
      return Promise.resolve([])
    })

    render(<DayOverridesScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('Field Trip')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))

    // Existing block 'Morning' should already be checked/overridden
    await waitFor(() => expect(screen.getByText('Morning')).toBeTruthy())

    // Uncheck Morning (drop the old override), check Afternoon (new override)
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0]) // uncheck Morning
    fireEvent.click(checkboxes[1]) // check Afternoon

    const select = screen.getByDisplayValue('— Clear block (free time) —')
    fireEvent.change(select, { target: { value: 'act-2' } })

    fireEvent.click(screen.getByText('Save Changes'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'day_override_template_slots', 'slot-old-1'))

    await waitFor(() => {
      const parentCalls = localClient.write.mock.calls.filter(c => c[1] === 'day_override_template_slots' && c[3] === 'day_override_template_id')
      expect(parentCalls.length).toBe(1)
    })

    const newSlotCalls = localClient.write.mock.calls.filter(c => c[1] === 'day_override_template_slots')
    const newId = newSlotCalls.find(c => c[3] === 'day_override_template_id')[2]
    expect(newSlotCalls.find(c => c[3] === 'time_block_id' && c[2] === newId)[4]).toBe('b2')
    expect(newSlotCalls.find(c => c[3] === 'activity_id' && c[2] === newId)[4]).toBe('act-2')

    // Old slot id must never be reused/re-written as the new row.
    expect(newSlotCalls.some(c => c[2] === 'slot-old-1' && c[3] !== '__deleted__')).toBe(false)
  })
})

describe('DayOverridesScreen save-phase failure messaging', () => {
  it('reports a mixed/partial state (not the generic message) when delete-old fails partway', async () => {
    const existingTemplate = { id: 'tmpl-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Field Trip', frequency_mode: 'reduced' }
    const existingSlots = [
      { id: 'slot-old-1', day_override_template_id: 'tmpl-1', time_block_id: 'b1', activity_id: 'act-1' },
      { id: 'slot-old-2', day_override_template_id: 'tmpl-1', time_block_id: 'b2', activity_id: 'act-2' },
    ]
    const blocks = [
      block({ id: 'b1', name: 'Morning', sort_order: 1 }),
      block({ id: 'b2', name: 'Afternoon', sort_order: 2 }),
    ]
    const acts = [activity({ id: 'act-1', name: 'Swim' }), activity({ id: 'act-2', name: 'Art' })]

    localClient.list.mockImplementation((entity) => {
      if (entity === 'day_override_templates') return Promise.resolve([existingTemplate])
      if (entity === 'day_override_template_slots') return Promise.resolve(existingSlots)
      if (entity === 'time_blocks') return Promise.resolve(blocks)
      if (entity === 'activities') return Promise.resolve(acts)
      return Promise.resolve([])
    })
    localClient.deleteEntity.mockImplementation((token, entity, id) => {
      if (id === 'slot-old-2') return Promise.reject(new Error('network error'))
      return Promise.resolve({ status: 'applied' })
    })

    render(<DayOverridesScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('Field Trip')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    await waitFor(() => expect(screen.getByText('Morning')).toBeTruthy())

    fireEvent.click(screen.getByText('Save Changes'))

    await waitFor(() => {
      const err = screen.queryByText(/removing your old block overrides/i)
      expect(err).not.toBeNull()
    })
    expect(screen.queryByText(/check your connection and try again/i)).toBeNull()
  })

  it('reports a full-wipe message when delete-old succeeds but create-new fails', async () => {
    const existingTemplate = { id: 'tmpl-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Field Trip', frequency_mode: 'reduced' }
    const existingSlots = [
      { id: 'slot-old-1', day_override_template_id: 'tmpl-1', time_block_id: 'b1', activity_id: 'act-1' },
    ]
    const blocks = [
      block({ id: 'b1', name: 'Morning', sort_order: 1 }),
      block({ id: 'b2', name: 'Afternoon', sort_order: 2 }),
    ]
    const acts = [activity({ id: 'act-1', name: 'Swim' }), activity({ id: 'act-2', name: 'Art' })]

    localClient.list.mockImplementation((entity) => {
      if (entity === 'day_override_templates') return Promise.resolve([existingTemplate])
      if (entity === 'day_override_template_slots') return Promise.resolve(existingSlots)
      if (entity === 'time_blocks') return Promise.resolve(blocks)
      if (entity === 'activities') return Promise.resolve(acts)
      return Promise.resolve([])
    })
    localClient.deleteEntity.mockResolvedValue({ status: 'applied' })
    localClient.write.mockImplementation((token, entity) => {
      if (entity === 'day_override_template_slots') return Promise.reject(new Error('network error'))
      return Promise.resolve({ status: 'applied' })
    })

    render(<DayOverridesScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('Field Trip')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    await waitFor(() => expect(screen.getByText('Morning')).toBeTruthy())

    fireEvent.click(screen.getByText('Save Changes'))

    await waitFor(() => {
      const err = screen.queryByText(/currently has NO block overrides/i)
      expect(err).not.toBeNull()
    })
  })
})

describe('DayOverridesScreen delete confirmation', () => {
  function setupList(slots) {
    const existingTemplate = { id: 'tmpl-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Field Trip', frequency_mode: 'reduced' }
    localClient.list.mockImplementation((entity) => {
      if (entity === 'day_override_templates') return Promise.resolve([existingTemplate])
      if (entity === 'day_override_template_slots') return Promise.resolve(slots)
      if (entity === 'time_blocks') return Promise.resolve([])
      if (entity === 'activities') return Promise.resolve([])
      return Promise.resolve([])
    })
  }

  it('shows count-aware copy for a template with no block overrides', async () => {
    setupList([])
    render(<DayOverridesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Field Trip')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    expect(window.confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Delete "Field Trip"?')).not.toBeNull())
    expect(screen.queryByText('This template has no block overrides. It will be removed from your programs.')).not.toBeNull()
  })

  it('shows count-aware copy for a template with exactly 1 block override', async () => {
    setupList([{ id: 'slot-1', day_override_template_id: 'tmpl-1', time_block_id: 'b1', activity_id: 'act-1' }])
    render(<DayOverridesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Field Trip')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Field Trip"?')).not.toBeNull())
    expect(screen.queryByText('This template and its 1 block override will be removed from your programs.')).not.toBeNull()
  })

  it('shows count-aware copy for a template with N block overrides and confirms the existing child-then-parent delete', async () => {
    setupList([
      { id: 'slot-1', day_override_template_id: 'tmpl-1', time_block_id: 'b1', activity_id: 'act-1' },
      { id: 'slot-2', day_override_template_id: 'tmpl-1', time_block_id: 'b2', activity_id: 'act-2' },
      { id: 'slot-3', day_override_template_id: 'tmpl-1', time_block_id: 'b3', activity_id: 'act-3' },
    ])
    render(<DayOverridesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Field Trip')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Field Trip"?')).not.toBeNull())
    expect(screen.queryByText('This template and its 3 block overrides will be removed from your programs.')).not.toBeNull()

    fireEvent.click(screen.getByText('Delete Template'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'day_override_template_slots', 'slot-1'))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'day_override_template_slots', 'slot-2')
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'day_override_template_slots', 'slot-3')
    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'day_override_templates', 'tmpl-1'))
  })

  it('cancels without deleting', async () => {
    setupList([])
    render(<DayOverridesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Field Trip')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Field Trip"?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete "Field Trip"?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })
})
