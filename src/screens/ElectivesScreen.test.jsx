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
})
