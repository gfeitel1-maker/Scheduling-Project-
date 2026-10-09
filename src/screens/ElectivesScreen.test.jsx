// @vitest-environment jsdom
//
// docs/work/specs/2026-08-23-electives-gap.md Part (b) — ElectivesScreen is
// now authoring-only (create/name/delete an elective set); the offerings
// builder (ElectiveSetDetail) is reached from the Schedule-side
// ScheduleElectivesScreen instead of an inline swap here. That builder's
// own tests live at src/screens/elective/ElectiveSetDetail.test.jsx.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    deleteElectiveSet: vi.fn(),
    purgeElectiveSeason: vi.fn(),
  },
}))

import ElectivesScreen from './ElectivesScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

function electiveSet(overrides = {}) {
  return { id: 'set-1', camp_id: CAMP_ID, name: 'Afternoon Chugim', sort_order: null, is_reusable: 1, ...overrides }
}

function byEntity(entries) {
  return (entity) => Promise.resolve(entries[entity] ?? [])
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
  localClient.deleteElectiveSet.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.purgeElectiveSeason.mockReset().mockResolvedValue({ ok: true, runsDeleted: 3 })
})

describe('ElectivesScreen', () => {
  it('shows the empty state when the camp has no elective sets', async () => {
    localClient.list.mockImplementation(byEntity({ elective_sets: [] }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.queryByText('No elective sets yet')).not.toBeNull())
  })

  it('creates a new elective set by writing camp_id and name', async () => {
    localClient.list.mockImplementation(byEntity({ elective_sets: [] }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
    await screen.findByPlaceholderText('e.g. Afternoon Chugim')

    fireEvent.change(screen.getByPlaceholderText('e.g. Afternoon Chugim'), { target: { value: 'Morning Bechirot' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const fields = localClient.write.mock.calls.map((c) => c[3])
    expect(fields).toEqual(expect.arrayContaining(['name', 'camp_id']))
  })

  it('lists elective sets by name, without opening a builder inline', async () => {
    localClient.list.mockImplementation(byEntity({ elective_sets: [electiveSet()] }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())
    // No offerings table / Add Offering builder surface on this screen anymore.
    expect(screen.queryByText('Add Offering')).toBeNull()
  })

  it('navigates to the Schedule-side Electives builder, focused on this set, when "Open" is clicked', async () => {
    localClient.list.mockImplementation(byEntity({ elective_sets: [electiveSet()] }))
    const onNavigate = vi.fn()
    render(<ElectivesScreen campId={CAMP_ID} role="admin" onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())

    fireEvent.click(screen.getByText('Open'))

    expect(onNavigate).toHaveBeenCalledWith('schedule:electives', { electiveSetId: 'set-1' })
  })

  it('deletes an elective set via localClient.deleteElectiveSet after confirmation', async () => {
    localClient.list.mockImplementation(byEntity({ elective_sets: [electiveSet()] }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText(/Delete "Afternoon Chugim"/)).not.toBeNull())
    fireEvent.click(screen.getByText('Delete Elective Set'))

    await waitFor(() => expect(localClient.deleteElectiveSet).toHaveBeenCalledWith({ electiveSetId: 'set-1' }))
  })

  async function openPurge() {
    localClient.list.mockImplementation(byEntity({ elective_sets: [electiveSet()] }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())
    fireEvent.click(screen.getByText(/Clear season.s elective choices/))
  }

  it('purge confirm copy discloses history retention, exported copies, and the sync-race reappearance', async () => {
    await openPurge()
    expect(screen.getByText(/Still in this app.s change history and any exported copy/)).not.toBeNull()
    expect(screen.getByText(/Can.t be undone/)).not.toBeNull()
    expect(screen.getByText(/can bring it back, unnamed — clear again/)).not.toBeNull()
  })

  it('shows an inline count after a successful purge', async () => {
    await openPurge()
    fireEvent.click(screen.getByText('Clear Season'))
    await screen.findByText('Cleared 3 runs.')
  })

  it('says honestly when a purge had nothing to clear', async () => {
    localClient.purgeElectiveSeason.mockResolvedValue({ ok: true, runsDeleted: 0 })
    await openPurge()
    fireEvent.click(screen.getByText('Clear Season'))
    await screen.findByText('Nothing to clear.')
  })

  const WEEKS = [{ id: 'wk-1', name: 'Week 1' }, { id: 'wk-2', name: 'Week 2' }]
  async function openWeekly(props = {}) {
    localClient.list.mockImplementation(byEntity({ elective_sets: [electiveSet()] }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" weekId="wk-1" weeks={WEEKS} {...props} />)
    await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())
  }

  it('offers This week (<name>) and The whole season scopes, defaulting to the week', async () => {
    await openWeekly()
    const week = screen.getByLabelText('This week (Week 1)')
    const season = screen.getByLabelText('The whole season')
    expect(week.checked).toBe(true)
    expect(season.checked).toBe(false)
  })

  it('this-week scope: confirm copy names the week, keeps the caveats, and purges by week', async () => {
    await openWeekly()
    fireEvent.click(screen.getByText(/Clear this week.s elective choices/))
    expect(screen.getByText(/Week 1.s elective runs/)).not.toBeNull()
    expect(screen.getByText(/Still in this app.s change history and any exported copy/)).not.toBeNull()
    expect(screen.getByText(/Can.t be undone/)).not.toBeNull()
    expect(screen.getByText(/can bring it back, unnamed — clear again/)).not.toBeNull()
    fireEvent.click(screen.getByText('Clear Week'))
    await screen.findByText('Cleared 3 runs.')
    expect(localClient.purgeElectiveSeason).toHaveBeenCalledWith({ scope: 'week', weekId: 'wk-1' })
  })

  it('whole-season scope: confirm copy names the season and purges the season', async () => {
    await openWeekly()
    fireEvent.click(screen.getByLabelText('The whole season'))
    fireEvent.click(screen.getByText(/Clear season.s elective choices/))
    expect(screen.getByText(/every elective run, with their choices/)).not.toBeNull()
    fireEvent.click(screen.getByText('Clear Season'))
    await screen.findByText('Cleared 3 runs.')
    expect(localClient.purgeElectiveSeason).toHaveBeenCalledWith({ scope: 'season' })
  })

  it('with no current week, only the whole season is offered', async () => {
    localClient.list.mockImplementation(byEntity({ elective_sets: [electiveSet()] }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" weeks={WEEKS} />)
    await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())
    expect(screen.getByLabelText('This week (no week selected)').disabled).toBe(true)
    expect(screen.getByLabelText('The whole season').checked).toBe(true)
  })

  // T353 — the camper export surfaces a failed read instead of failing silently.
  it('surfaces a failed camper download', async () => {
    localClient.list.mockImplementation((entity) => entity === 'elective_preferences'
      ? Promise.reject(new Error('boom'))
      : Promise.resolve([]))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
    fireEvent.click(await screen.findByText('Download campers'))
    await waitFor(() => expect(screen.queryByText(/The camper file could not be downloaded/)).not.toBeNull())
  })

  it('says so when there are no camper choices to download', async () => {
    localClient.list.mockImplementation(byEntity({}))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
    fireEvent.click(await screen.findByText('Download campers'))
    await waitFor(() => expect(screen.queryByText('No camper choices to download.')).not.toBeNull())
  })

  it('hides Download campers from staff, whose preference reads are denied', async () => {
    localClient.list.mockImplementation(byEntity({ elective_sets: [] }))
    render(<ElectivesScreen campId={CAMP_ID} role="staff" />)
    await screen.findByText('No elective sets yet')
    expect(screen.queryByText('Download campers')).toBeNull()
  })
})
