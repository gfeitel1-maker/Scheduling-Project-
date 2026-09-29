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
  // v66 (T194): capacity is the two-part capacity_mode/capacity_limit pair.
  // camper_headcount is retained in the table but retired from the write path.
  return { id: 'off-1', elective_set_id: 'set-1', activity_id: 'act-1', capacity_mode: 'unlimited', capacity_limit: null, ...overrides }
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
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering({ capacity_mode: 'limited', capacity_limit: 8 })] }))
    renderDetail({ activities: [activity()], locations: [{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool' }] })

    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())
    expect(screen.queryByText('Pool')).not.toBeNull()
    expect(screen.queryByText('Everyone')).not.toBeNull()
    expect(screen.getByLabelText('Capacity for Pottery').value).toBe('8')
  })

  // T195 (offering-grid import) — this is the AUTHORING surface, one of two
  // (with ScheduleElectivesScreen.jsx) that must keep seeing 'potential'
  // offerings so a director can review and confirm them. Only the
  // consumption boundaries (engine/conflicts/export/MCP) filter status.
  it('shows a potential-status offering — the authoring screen is never status-filtered', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering({ status: 'potential' })] }))
    renderDetail({ activities: [activity()] })

    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())
  })

  it('persists a capacity edit as the capacity_mode/capacity_limit pair, empty as unlimited', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const capacityInput = screen.getByLabelText('Capacity for Pottery')
    fireEvent.change(capacityInput, { target: { value: '15' } })
    fireEvent.blur(capacityInput)

    // Two fields, written one op each. The DB CHECKs are per-column precisely
    // so either arrival order is legal on every device — see schema.sql.
    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_set_activities', 'off-1', 'capacity_mode', 'limited')
    )
    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_set_activities', 'off-1', 'capacity_limit', 15)
    )
  })

  // T265 — the minimum headcount to run, set and cleared beside the capacity it
  // sits next to, because that is where a director already goes to say how many
  // campers an offering takes.
  it('shows a stored minimum in its own control', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_set_activities: [offering({ min_mode: 'required', min_to_run: 6 })],
    }))
    renderDetail({ activities: [activity()] })

    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())
    expect(screen.getByLabelText('Minimum to run Pottery').value).toBe('6')
  })

  // min_mode is the AUTHORITY, so a leftover value under 'none' must read as no
  // minimum in the UI too — otherwise a director sees a minimum the engine is
  // ignoring, which is worse than seeing none.
  it('shows an empty control when the mode says none, even with a leftover value', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_set_activities: [offering({ min_mode: 'none', min_to_run: 6 })],
    }))
    renderDetail({ activities: [activity()] })

    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())
    expect(screen.getByLabelText('Minimum to run Pottery').value).toBe('')
  })

  it('persists a minimum as the min_mode/min_to_run pair', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const input = screen.getByLabelText('Minimum to run Pottery')
    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.blur(input)

    // Two fields, one op each — the DB CHECKs are per-column precisely so either
    // arrival order is legal on every device.
    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_set_activities', 'off-1', 'min_mode', 'required')
    )
    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_set_activities', 'off-1', 'min_to_run', 5)
    )
  })

  it('clears a minimum back to none', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_set_activities: [offering({ min_mode: 'required', min_to_run: 6 })],
    }))
    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const input = screen.getByLabelText('Minimum to run Pottery')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_set_activities', 'off-1', 'min_mode', 'none')
    )
    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_set_activities', 'off-1', 'min_to_run', null)
    )
  })

  // Owner ruling: the min could be 1, cannot be 0. The DB CHECK rejects 0; the UI
  // says so instead of quietly coercing it, because a coerced 0 is exactly how
  // the live blank-capacity defect reaches a director.
  it('refuses a minimum of 0 and says why, without writing it', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const input = screen.getByLabelText('Minimum to run Pottery')
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)

    await waitFor(() => expect(screen.queryByText(/at least 1/i)).not.toBeNull())
    expect(localClient.write).not.toHaveBeenCalledWith(
      'token-abc', 'elective_set_activities', 'off-1', 'min_to_run', 0
    )
  })

  it('accepts a minimum of 1, the smallest the owner allows', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const input = screen.getByLabelText('Minimum to run Pottery')
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_set_activities', 'off-1', 'min_to_run', 1)
    )
  })

  // Every mutation surfaces its failure — a rejected write (the DB CHECK, a
  // permission, a replayed op) must reach the director, never be swallowed.
  it('surfaces a failed minimum write through describeWriteFailure', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    localClient.write.mockRejectedValue(new Error('nope'))
    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const input = screen.getByLabelText('Minimum to run Pottery')
    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.blur(input)

    await waitFor(() => expect(screen.queryByText(/minimum could not be saved/i)).not.toBeNull())
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
      'token-abc', 'elective_set_activities', 'off-1', 'capacity_limit', expect.anything()
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

    await waitFor(() => expect(screen.getByText(/Import from a file/)).toBeTruthy())
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
    await waitFor(() => expect(screen.getByText(/Import from a file/)).toBeTruthy())

    const listCallsBefore = localClient.list.mock.calls.filter(([e]) => e === 'elective_set_activities').length

    const importButton = screen.getByText(/Import from a file/)
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
    await waitFor(() => expect(screen.getByText(/Import from a file/)).toBeTruthy())

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
    await waitFor(() => expect(screen.getByText(/Import from a file/)).toBeTruthy())

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
    expect(screen.queryByText(/Import from a file/)).not.toBeNull()
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

// T301 slice 2 — the linked-elective bundle authoring control. A camp holds
// up to two candidate schedules (manual/generated); a bundle's picker grid
// shows the union of both. Fixture below places the set on a MANUAL template
// only, which is enough to prove the wiring without needing both routes —
// deriveBundlePickerCells' own tests already cover the union/sub-label logic.
const SCHEDULE_FIXTURE = {
  groups: [{ id: 'grp-1', tier_id: 'tier-jr' }],
  tiers: [{ id: 'tier-jr', name: 'Juniors' }],
  days: [{ id: 'day-1', label: 'Mon' }],
  timeBlocks: [{ id: 'tb-1', name: 'First Period' }],
  scheduleTemplates: [{ id: 'tpl-1', camp_id: CAMP_ID, week_id: null, name: 'Manual', kind: 'manual' }],
  templateSlots: [
    { id: 's1', template_id: 'tpl-1', elective_set_id: 'set-1', group_id: 'grp-1', day_id: 'day-1', time_block_id: 'tb-1' },
  ],
}

describe('ElectiveSetDetail — T301 slice 2: bundle authoring trigger', () => {
  it("shows a quiet, DISABLED '+ Add bundle' trigger when this set is not on any schedule yet", async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    renderDetail({ activities: [activity()] })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const trigger = screen.getByRole('button', { name: '+ Add bundle' })
    expect(trigger.disabled).toBe(true)
    expect(trigger.title).toMatch(/Place this set on a schedule first/)
  })

  it('an enabled trigger opens a draft editor; picking its first period mints the bundle and its first period', async () => {
    localClient.list.mockImplementation(byEntity({ elective_set_activities: [offering()] }))
    renderDetail({ activities: [activity()], ...SCHEDULE_FIXTURE })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const trigger = screen.getByRole('button', { name: '+ Add bundle' })
    expect(trigger.disabled).toBe(false)
    fireEvent.click(trigger)

    const nameInput = await screen.findByLabelText(/Bundle name/i)
    expect(nameInput.getAttribute('placeholder')).toBe('Pick a period below to name this bundle')

    // Review round 2 — a draft (0 persisted bundles, disclosure just opened)
    // must never render as "0 bundles": that reads as a count of something
    // that exists, not an invitation to create the first one. The trigger
    // legitimately STAYS "+ Add bundle" here — the original spec's own
    // "nothing else about the [zero-bundle] row changes" — since there is
    // still, correctly, no persisted bundle yet.
    expect(screen.queryByText(/^0 bundles?$/)).toBeNull()
    expect(screen.getByRole('button', { name: '+ Add bundle' })).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Mon, First Period — click to include'))

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_bundles', 'new-id', 'name', 'Pottery')
    )
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_bundles', 'new-id', 'elective_set_id', 'set-1')
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_bundles', 'new-id', 'activity_id', 'act-1')
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_bundle_periods', 'new-id', 'bundle_id', 'new-id')
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_bundle_periods', 'new-id', 'day_id', 'day-1')
  })

  it('a populated activity shows the collapsed bundle count with a chevron, not the quiet trigger', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_set_activities: [offering()],
      elective_bundles: [{ id: 'bundle-1', elective_set_id: 'set-1', activity_id: 'act-1', name: 'Pottery', scope_mode: 'all' }],
    }))
    renderDetail({ activities: [activity()], ...SCHEDULE_FIXTURE })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    expect(screen.getByText('1 bundle')).toBeTruthy()
    expect(screen.queryByText('+ Add bundle')).toBeNull()
  })
})

describe('ElectiveSetDetail — T301 slice 2: orphan cleanup', () => {
  it('deleting an offering also deletes its bundles, their periods, and their tier-scope rows', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_set_activities: [offering()],
      elective_bundles: [{ id: 'bundle-1', elective_set_id: 'set-1', activity_id: 'act-1', name: 'Pottery', scope_mode: 'only' }],
      elective_bundle_periods: [{ id: 'bp-1', bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' }],
      elective_bundle_tiers: [{ id: 'bt-1', bundle_id: 'bundle-1', tier_id: 'tier-jr' }],
    }))
    renderDetail({ activities: [activity()], ...SCHEDULE_FIXTURE })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(screen.queryByText(/Remove Pottery\?/)).not.toBeNull())
    fireEvent.click(screen.getByText('Remove Offering'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'elective_bundles', 'bundle-1'))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'elective_bundle_periods', 'bp-1')
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'elective_bundle_tiers', 'bt-1')
  })

  it('clearing all offerings also deletes every bundle (and its periods/tiers) for the removed activities', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_set_activities: [offering()],
      elective_bundles: [{ id: 'bundle-1', elective_set_id: 'set-1', activity_id: 'act-1', name: 'Pottery', scope_mode: 'all' }],
      elective_bundle_periods: [{ id: 'bp-1', bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' }],
    }))
    renderDetail({ activities: [activity()], ...SCHEDULE_FIXTURE })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    fireEvent.click(screen.getByText('Clear offerings'))
    await waitFor(() => expect(screen.queryByText(/Clear all offerings from this set/)).not.toBeNull())
    fireEvent.click(screen.getByText('Clear Offerings'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'elective_bundles', 'bundle-1'))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'elective_bundle_periods', 'bp-1')
  })
})

// T301 slice 3 — the seam AssignmentPanel.test.jsx's own wiring test cannot
// see: that test renders <AssignmentPanel bundles={...} .../> DIRECTLY, so it
// proves "if AssignmentPanel receives bundles, it wires them to the solver"
// but never proves ElectiveSetDetail actually PASSES them down. Found by
// execution during T301 visual verification: ElectiveSetDetail rendered
// <AssignmentPanel> with no bundles/bundlePeriods/bundleTiers props at all,
// so every real solve in the shipped app fed the engine zero bundles —
// invisible to every unit test in this feature, because every one of them
// either renders AssignmentPanel standalone or renders ElectiveSetDetail
// without ever driving a solve far enough to notice the engine received
// nothing. This test renders the REAL parent-to-child wiring and drives a
// real solve, using the same only-tier-1-can-produce-this signal
// (UNSUPPORTED_LINKED_CHOICE) as the AssignmentPanel-level test, for the same
// reason stated there: a "camper placed" assertion would pass even with the
// wiring completely absent.
describe('ElectiveSetDetail — T301 slice 3: a bundle authored on this screen reaches the solver', () => {
  it('surfaces UNSUPPORTED_LINKED_CHOICE naming the bundle, proving ElectiveSetDetail passes bundles/bundlePeriods/bundleTiers down to AssignmentPanel', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_set_activities: [offering()],
      elective_bundles: [{ id: 'bundle-1', elective_set_id: 'set-1', activity_id: 'act-1', name: 'Pottery', scope_mode: 'all' }],
      elective_bundle_periods: [
        { id: 'bp-1', bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' },
        // Never placed on SCHEDULE_FIXTURE's own template_slots — ADR D5 case
        // (a), unreachable unless the engine actually received this bundle.
        { id: 'bp-2', bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-2' },
      ],
    }))
    renderDetail({ activities: [activity()], ...SCHEDULE_FIXTURE })
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())
    await waitFor(() => expect(screen.queryByText('1 bundle')).not.toBeNull())

    const fileInput = [...document.querySelectorAll('input[type="file"]')].find((i) => i.accept?.includes('csv'))
    const sheetFile = new File(['Name\t#1\nAri\tPottery'], 'sheet.txt', { type: 'text/plain' })
    fireEvent.change(fileInput, { target: { files: [sheetFile] } })
    await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Confirm Mapping/))
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Solve/i))

    await waitFor(() => expect(screen.getByText(/“Pottery” is meant to be taken as a set/)).toBeTruthy())
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
