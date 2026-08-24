// @vitest-environment jsdom
//
// docs/work/specs/2026-08-23-electives-gap.md — ElectiveSetDetail extracted
// from ElectivesScreen.jsx so it can be reused verbatim from both Roots's
// authoring screen and the Schedule-side ScheduleElectivesScreen. This file
// carries the offerings-builder tests that used to live in
// ElectivesScreen.test.jsx (behind a "Manage Offerings" click that no
// longer exists), rendering the component directly with its props.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
  },
}))

vi.mock('../../ingest/textGrid', () => ({ parseTextGrid: vi.fn() }))
vi.mock('../../ingest/parseGridSchedule', () => ({ parseGridSchedule: vi.fn() }))
vi.mock('../../ingest/electiveSetPopulate', () => ({ populateElectiveSet: vi.fn() }))

import ElectiveSetDetail from './ElectiveSetDetail'
import { localClient } from '../../localClient'
import { parseTextGrid } from '../../ingest/textGrid'
import { parseGridSchedule } from '../../ingest/parseGridSchedule'
import { populateElectiveSet } from '../../ingest/electiveSetPopulate'

const CAMP_ID = 'camp-1'

function electiveSet(overrides = {}) {
  return { id: 'set-1', camp_id: CAMP_ID, name: 'Afternoon Chugim', sort_order: null, is_reusable: 1, ...overrides }
}

function offering(overrides = {}) {
  return { id: 'off-1', elective_set_id: 'set-1', activity_id: 'act-1', camper_headcount: null, ...overrides }
}

function activity(overrides = {}) {
  return { id: 'act-1', camp_id: CAMP_ID, name: 'Pottery', location_id: 'loc-1', eligible_tier_ids: '[]', eligible_group_ids: '[]', ...overrides }
}

function byEntity(entries) {
  return (entity) => Promise.resolve(entries[entity] ?? [])
}

function renderDetail(props = {}) {
  const refreshActivities = props.refreshActivities ?? vi.fn()
  const onBack = props.onBack ?? vi.fn()
  return render(
    <ElectiveSetDetail
      set={electiveSet()}
      role="admin"
      activities={[]}
      locations={[]}
      tiers={[]}
      groups={[]}
      refreshActivities={refreshActivities}
      onBack={onBack}
      {...props}
    />
  )
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'new-id' })
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
})

describe('ElectiveSetDetail — offerings table', () => {
  it('lists a set with its offerings, showing location and eligibility read from the activity', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering({ camper_headcount: 8 })] }))
    renderDetail({ activities: [activity()], locations: [{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool' }] })

    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())
    expect(screen.queryByText('Pool')).not.toBeNull()
    expect(screen.queryByText('Everyone')).not.toBeNull()
    expect(screen.getByLabelText('Capacity for Pottery').value).toBe('8')
  })

  it('persists a capacity edit as camper_headcount, and empty as null (no cap)', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const capacityInput = screen.getByLabelText('Capacity for Pottery')
    fireEvent.change(capacityInput, { target: { value: '15' } })
    fireEvent.blur(capacityInput)

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_set_activities', 'off-1', 'camper_headcount', 15)
    )
  })

  it('rejects non-numeric / negative capacity input without writing', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const capacityInput = screen.getByLabelText('Capacity for Pottery')
    fireEvent.change(capacityInput, { target: { value: 'abc' } })
    expect(capacityInput.value).toBe('')
    fireEvent.change(capacityInput, { target: { value: '-5' } })
    expect(capacityInput.value).toBe('')
    fireEvent.blur(capacityInput)
    expect(localClient.write).not.toHaveBeenCalledWith(
      'token-abc', 'elective_set_activities', 'off-1', 'camper_headcount', expect.anything()
    )
  })

  it('surfaces a write failure instead of silently swallowing it', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    localClient.write.mockResolvedValue({ status: 'rejected' })
    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const capacityInput = screen.getByLabelText('Capacity for Pottery')
    fireEvent.change(capacityInput, { target: { value: '15' } })
    fireEvent.blur(capacityInput)

    await waitFor(() => expect(screen.queryByText(/That capacity could not be saved/)).not.toBeNull())
  })
})

describe('ElectiveSetDetail — Add Offering (existing activity)', () => {
  it('adds an offering from the camp activities not already in the set, immediately on selection', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [] }))
    renderDetail({ activities: [activity(), activity({ id: 'act-2', name: 'Ceramics' })] })
    await waitFor(() => expect(screen.queryByText('No offerings yet')).not.toBeNull())

    const input = screen.getByLabelText('Search or add an activity')
    fireEvent.change(input, { target: { value: 'Ceramics' } })
    fireEvent.mouseDown(screen.getByText('Ceramics'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const calls = localClient.write.mock.calls
    expect(calls.some((c) => c[3] === 'activity_id' && c[4] === 'act-2')).toBe(true)
    expect(calls.some((c) => c[3] === 'elective_set_id' && c[4] === 'set-1')).toBe(true)
  })

  it('marks a blank-status added activity recurrence_truth_status permission (electives are Permission-tier by construction)', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [] }))
    // act-2 carries no prior truth-status → claimable as Permission.
    renderDetail({ activities: [activity(), activity({ id: 'act-2', name: 'Ceramics' })] })
    await waitFor(() => expect(screen.queryByText('No offerings yet')).not.toBeNull())

    const input = screen.getByLabelText('Search or add an activity')
    fireEvent.change(input, { target: { value: 'Ceramics' } })
    fireEvent.mouseDown(screen.getByText('Ceramics'))

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'act-2', 'recurrence_truth_status', 'permission')
    )
  })

  it('non-destructive — does NOT overwrite a prior obligation/asserted when the added activity already has a truth-status', async () => {
    // "Ceramics" already classified obligation (reused from the main schedule).
    // Adding it as an elective must not collapse that truth to 'permission' on
    // the single synced column — coexistence is owner priority #5 (two-rows).
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [] }))
    renderDetail({ activities: [activity(), activity({ id: 'act-2', name: 'Ceramics', recurrence_truth_status: 'obligation' })] })
    await waitFor(() => expect(screen.queryByText('No offerings yet')).not.toBeNull())

    const input = screen.getByLabelText('Search or add an activity')
    fireEvent.change(input, { target: { value: 'Ceramics' } })
    fireEvent.mouseDown(screen.getByText('Ceramics'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    expect(
      localClient.write.mock.calls.some((c) => c[2] === 'act-2' && c[3] === 'recurrence_truth_status')
    ).toBe(false)
  })

  it('does not write recurrence_truth_status again when the added activity is already permission-tier', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [] }))
    renderDetail({ activities: [activity(), activity({ id: 'act-2', name: 'Ceramics', recurrence_truth_status: 'permission' })] })
    await waitFor(() => expect(screen.queryByText('No offerings yet')).not.toBeNull())

    const input = screen.getByLabelText('Search or add an activity')
    fireEvent.change(input, { target: { value: 'Ceramics' } })
    fireEvent.mouseDown(screen.getByText('Ceramics'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    expect(localClient.write.mock.calls.some((c) => c[3] === 'recurrence_truth_status')).toBe(false)
  })
})

describe('ElectiveSetDetail — Add Offering (manual create-any-activity, electives-gap Part a)', () => {
  it('mints a new activity and adds it as an offering when the typed name has no catalog match', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [] }))
    const refreshActivities = vi.fn()
    renderDetail({ activities: [activity()], refreshActivities })
    await waitFor(() => expect(screen.queryByText('No offerings yet')).not.toBeNull())

    const input = screen.getByLabelText('Search or add an activity')
    fireEvent.change(input, { target: { value: 'Pottery Wheel' } })
    await waitFor(() => expect(screen.getByText(/Create "Pottery Wheel" as a new activity/)).toBeTruthy())
    fireEvent.mouseDown(screen.getByText(/Create "Pottery Wheel" as a new activity/))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const calls = localClient.write.mock.calls
    // The mint writes name + camp_id on `activities`, same shape
    // createActivityHelper.js's createActivity writes for import-minted rows.
    expect(calls.some((c) => c[1] === 'activities' && c[3] === 'name' && c[4] === 'Pottery Wheel')).toBe(true)
    expect(calls.some((c) => c[1] === 'activities' && c[3] === 'camp_id' && c[4] === CAMP_ID)).toBe(true)
    // Then adds the newly-minted activity as an offering on this set.
    expect(calls.some((c) => c[1] === 'elective_set_activities' && c[3] === 'elective_set_id' && c[4] === 'set-1')).toBe(true)
    // A freshly-minted activity is also marked Permission-tier — electives
    // are Permission-tier by construction (ADR §4.1).
    expect(calls.some((c) => c[1] === 'activities' && c[3] === 'recurrence_truth_status' && c[4] === 'permission')).toBe(true)
    await waitFor(() => expect(refreshActivities).toHaveBeenCalled())
  })

  it('does not mint a duplicate for a name that already exists in the catalog (case/whitespace-insensitive)', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [] }))
    renderDetail({ activities: [activity({ id: 'act-existing', name: 'Ceramics' })] })
    await waitFor(() => expect(screen.queryByText('No offerings yet')).not.toBeNull())

    const input = screen.getByLabelText('Search or add an activity')
    // Typed text matches an existing activity exactly (case-insensitive) —
    // no Create row should even offer to mint a duplicate.
    fireEvent.change(input, { target: { value: 'ceramics' } })
    await waitFor(() => expect(screen.queryByText('Ceramics')).not.toBeNull())
    expect(screen.queryByText(/Create "ceramics" as a new activity/)).toBeNull()
  })

  it('shows the reworded hint once every catalog activity is already offered', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const input = screen.getByLabelText('Search or add an activity')
    fireEvent.focus(input)

    await waitFor(() =>
      expect(screen.getByText(/All existing activities are already offered here/)).toBeTruthy()
    )
  })
})

describe('ElectiveSetDetail — grid-schedule import affordance (docs/adr/2026-08-22-event-schedule-import.md §8)', () => {
  beforeEach(() => {
    parseTextGrid.mockReset()
    parseGridSchedule.mockReset()
    populateElectiveSet.mockReset()
  })

  it('renders the import affordance in the empty-offerings state', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [] }))
    renderDetail({ activities: [activity()] })

    await waitFor(() => expect(screen.getByText(/import this set’s offerings from a file/)).toBeTruthy())
  })

  it('file -> parse -> populate wiring: selecting a file runs parseTextGrid -> parseGridSchedule -> populateElectiveSet, then reloads', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [] }))
    parseTextGrid.mockReturnValue({ pages: [{ title: 'x', columns: ['A'], rows: [{ label: 'Chugim', cells: ['Pottery'] }] }] })
    const parsed = {
      orientation: { axis: null, confident: false },
      timeAxis: [], groupAxis: [],
      cells: [{ timeIndex: 0, groupIndex: 0, activityName: 'Pottery', locationName: null }],
      unmapped: [],
    }
    parseGridSchedule.mockReturnValue(parsed)
    populateElectiveSet.mockResolvedValue({ ok: true })

    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.getByText(/import this set’s offerings from a file/)).toBeTruthy())

    const listCallsBefore = localClient.list.mock.calls.filter(([e]) => e === 'elective_set_activities').length

    const importButton = screen.getByText(/import this set’s offerings from a file/)
    fireEvent.click(importButton)
    const file = new File(['irrelevant'], 'chugim.txt', { type: 'text/plain' })
    const input = document.querySelector('input[type="file"]')
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(populateElectiveSet).toHaveBeenCalledTimes(1))
    expect(parseGridSchedule).toHaveBeenCalledWith([{ title: 'x', columns: ['A'], rows: [{ label: 'Chugim', cells: ['Pottery'] }] }])
    const [passedParsed, ctx] = populateElectiveSet.mock.calls[0]
    expect(passedParsed).toBe(parsed)
    expect(ctx.electiveSetId).toBe('set-1')
    expect(ctx.campId).toBe(CAMP_ID)

    await waitFor(() =>
      expect(localClient.list.mock.calls.filter(([e]) => e === 'elective_set_activities').length).toBeGreaterThan(listCallsBefore)
    )
  })

  it('refusal reason (e.g. nonempty set) is surfaced, writes nothing new', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [] }))
    parseTextGrid.mockReturnValue({ pages: [{ title: 'x', columns: ['A'], rows: [{ label: 'Chugim', cells: ['Pottery'] }] }] })
    parseGridSchedule.mockReturnValue({ orientation: { axis: null, confident: false }, timeAxis: [], groupAxis: [], cells: [], unmapped: [] })
    populateElectiveSet.mockResolvedValue({ ok: false, reason: 'This elective set already has offerings. Clear it first if you want to replace it with an import, or add to it by hand.' })

    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.getByText(/import this set’s offerings from a file/)).toBeTruthy())

    const input = document.querySelector('input[type="file"]')
    const file = new File(['irrelevant'], 'chugim.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(screen.getByText(/already has offerings/)).toBeTruthy())
  })

  it('a mid-import throw (partial write) still reloads offerings, so stale UI does not mask partial data', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [] }))
    parseTextGrid.mockReturnValue({ pages: [{ title: 'x', columns: ['A'], rows: [{ label: 'Chugim', cells: ['Pottery'] }] }] })
    parseGridSchedule.mockReturnValue({
      orientation: { axis: null, confident: false }, timeAxis: [], groupAxis: [],
      cells: [{ timeIndex: 0, groupIndex: 0, activityName: 'Pottery', locationName: null }], unmapped: [],
    })
    populateElectiveSet.mockRejectedValue(new Error('write failed for field "activity_id"'))

    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.getByText(/import this set’s offerings from a file/)).toBeTruthy())

    const listCallsBefore = localClient.list.mock.calls.filter(([e]) => e === 'elective_set_activities').length

    const input = document.querySelector('input[type="file"]')
    const file = new File(['irrelevant'], 'chugim.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(screen.getByText(/Could not import that schedule/)).toBeTruthy())
    await waitFor(() =>
      expect(localClient.list.mock.calls.filter(([e]) => e === 'elective_set_activities').length).toBeGreaterThan(listCallsBefore)
    )
  })
})

describe('ElectiveSetDetail — Clear offerings control (Tester MEDIUM)', () => {
  it('clears all offerings after confirmation, and the import affordance reappears', async () => {
    let offeringsCleared = false
    localClient.list.mockImplementation((entity) => {
      if (entity === 'elective_set_activities') return Promise.resolve(offeringsCleared ? [] : [offering()])
      return Promise.resolve([])
    })
    localClient.deleteEntity.mockImplementation(() => {
      offeringsCleared = true
      return Promise.resolve({ status: 'applied' })
    })
    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    fireEvent.click(screen.getByText('Clear offerings'))
    await waitFor(() => expect(screen.queryByText(/Clear all offerings from this set/)).not.toBeNull())
    fireEvent.click(screen.getByText('Clear Offerings'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'elective_set_activities', 'off-1'))
    await waitFor(() => expect(screen.queryByText('No offerings yet')).not.toBeNull())
    expect(screen.queryByText(/import this set’s offerings from a file/)).not.toBeNull()
  })
})

describe('ElectiveSetDetail — Remove offering clears permission-tier (owner priority #4, symmetric with #172)', () => {
  it('removing the last offering of a permission-status activity nulls recurrence_truth_status', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    renderDetail({ activities: [activity({ recurrence_truth_status: 'permission' })] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(screen.queryByText(/Remove Pottery\?/)).not.toBeNull())
    fireEvent.click(screen.getByText('Remove Offering'))

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'act-1', 'recurrence_truth_status', null)
    )
  })

  it('does NOT clear when the activity still belongs to another elective set', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_set_activities: [
        offering({ id: 'off-1', elective_set_id: 'set-1', activity_id: 'act-1' }),
        offering({ id: 'off-2', elective_set_id: 'set-2', activity_id: 'act-1' }),
      ],
    }))
    renderDetail({ activities: [activity({ recurrence_truth_status: 'permission' })] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(screen.queryByText(/Remove Pottery\?/)).not.toBeNull())
    fireEvent.click(screen.getByText('Remove Offering'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalled())
    expect(
      localClient.write.mock.calls.some((c) => c[2] === 'act-1' && c[3] === 'recurrence_truth_status')
    ).toBe(false)
  })

  it('does NOT clear an obligation-status activity even with zero remaining memberships', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    renderDetail({ activities: [activity({ recurrence_truth_status: 'obligation' })] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(screen.queryByText(/Remove Pottery\?/)).not.toBeNull())
    fireEvent.click(screen.getByText('Remove Offering'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalled())
    expect(
      localClient.write.mock.calls.some((c) => c[2] === 'act-1' && c[3] === 'recurrence_truth_status')
    ).toBe(false)
  })
})

describe('ElectiveSetDetail — Back', () => {
  it('calls onBack when "← Back to Elective Sets" is clicked', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [] }))
    const onBack = vi.fn()
    renderDetail({ activities: [], onBack })
    await waitFor(() => expect(screen.queryByText('No offerings yet')).not.toBeNull())

    fireEvent.click(screen.getByText('← Back to Elective Sets'))
    expect(onBack).toHaveBeenCalled()
  })
})
