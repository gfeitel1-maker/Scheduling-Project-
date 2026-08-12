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

import CohortsScreen from './CohortsScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

function cohort(overrides = {}) {
  return {
    id: 'cohort-1',
    camp_id: CAMP_ID,
    name: 'Main',
    session_week_start: 1,
    session_week_end: 4,
    anchor_model: 'fixed',
    capacity_source: 'groups_per_slot',
    sort_order: 1,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'new-cohort-id' })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(window, 'alert').mockImplementation(() => {})
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
})

describe('CohortsScreen', () => {
  it('loads cohorts scoped to campId via localClient.list', async () => {
    localClient.list.mockResolvedValue([
      cohort({ id: 'c1', name: 'Main' }),
      cohort({ id: 'c2', name: 'Other camp', camp_id: 'other-camp' }),
    ])
    render(<CohortsScreen campId={CAMP_ID} />)

    await waitFor(() => expect(screen.queryByText('Main')).not.toBeNull())
    expect(screen.queryByText('Other camp')).toBeNull()
    expect(localClient.list).toHaveBeenCalledWith('cohorts')
  })

  it('adding a program writes each field via localClient.write with the token and reloads', async () => {
    localClient.list.mockResolvedValue([])
    render(<CohortsScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('No programs yet')).not.toBeNull())

    localClient.list.mockResolvedValue([cohort({ id: 'new-cohort-id', name: 'Specialty' })])

    fireEvent.change(screen.getByPlaceholderText('Name (e.g. Main, Specialty)'), {
      target: { value: 'Specialty' },
    })
    fireEvent.click(screen.getByText('+ Add Program'))

    await waitFor(() => expect(screen.queryByText('Specialty')).not.toBeNull())

    expect(localClient.write).toHaveBeenCalledWith(
      'token-abc',
      'cohorts',
      'new-cohort-id',
      'camp_id',
      CAMP_ID
    )
    expect(localClient.write).toHaveBeenCalledWith(
      'token-abc',
      'cohorts',
      'new-cohort-id',
      'name',
      'Specialty'
    )
  })

  it('editing a cohort writes the changed fields and reloads', async () => {
    localClient.list.mockResolvedValue([cohort()])
    render(<CohortsScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('Main')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    const nameInput = screen.getByDisplayValue('Main')
    fireEvent.change(nameInput, { target: { value: 'Renamed' } })

    localClient.list.mockResolvedValue([cohort({ name: 'Renamed' })])
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(screen.queryByText('Renamed')).not.toBeNull())
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'cohorts', 'cohort-1', 'name', 'Renamed')
  })

  it('deleting a cohort calls localClient.deleteEntity and reloads when more than one cohort exists', async () => {
    localClient.list.mockResolvedValue([cohort({ id: 'c1' }), cohort({ id: 'c2', name: 'Second' })])
    render(<CohortsScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('Main')).not.toBeNull())

    localClient.list.mockResolvedValue([cohort({ id: 'c2', name: 'Second' })])
    const deleteButtons = screen.getAllByText('Delete')
    fireEvent.click(deleteButtons[0])

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'cohorts', 'c1'))
    await waitFor(() => expect(screen.queryByText('Main')).toBeNull())
  })

  it('refuses to delete the last remaining cohort without calling deleteEntity', async () => {
    localClient.list.mockResolvedValue([cohort()])
    render(<CohortsScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('Main')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    expect(window.alert).toHaveBeenCalledWith(
      'Cannot delete the last program — every camp must have at least one.'
    )
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('writes name before camp_id when adding a program (round 2 Finding 1: avoids an orphaned partial row on a UNIQUE collision)', async () => {
    localClient.list.mockResolvedValue([])
    render(<CohortsScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('No programs yet')).not.toBeNull())

    localClient.list.mockResolvedValue([cohort({ id: 'new-cohort-id', name: 'Specialty' })])
    fireEvent.change(screen.getByPlaceholderText('Name (e.g. Main, Specialty)'), {
      target: { value: 'Specialty' },
    })
    fireEvent.click(screen.getByText('+ Add Program'))

    await waitFor(() => expect(screen.queryByText('Specialty')).not.toBeNull())

    const fieldsWritten = localClient.write.mock.calls
      .filter((call) => call[1] === 'cohorts' && call[2] === 'new-cohort-id')
      .map((call) => call[3])
    expect(fieldsWritten.indexOf('name')).toBeLessThan(fieldsWritten.indexOf('camp_id'))
  })

  it('shows a specific message (not the generic connectivity one) when adding a program hits a UNIQUE name collision', async () => {
    localClient.list.mockResolvedValue([])
    localClient.write.mockRejectedValue(new Error('UNIQUE constraint failed: cohorts.camp_id, cohorts.name'))
    render(<CohortsScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('No programs yet')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Name (e.g. Main, Specialty)'), {
      target: { value: 'Main' },
    })
    fireEvent.click(screen.getByText('+ Add Program'))

    await waitFor(() =>
      expect(
        screen.queryByText('A program with this name already exists — choose a different name.')
      ).not.toBeNull()
    )
  })

  it('keeps the row in edit mode when saving a cohort fails', async () => {
    localClient.list.mockResolvedValue([cohort()])
    localClient.write.mockRejectedValue(new Error('UNIQUE constraint failed: cohorts.camp_id, cohorts.name'))
    render(<CohortsScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('Main')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() =>
      expect(
        screen.queryByText('A program with this name already exists — choose a different name.')
      ).not.toBeNull()
    )
    // Still in edit mode: the Save/Cancel buttons are present, not Edit/Delete.
    expect(screen.queryByText('Save')).not.toBeNull()
    expect(screen.queryByText('Cancel')).not.toBeNull()
  })

  // Characterization test pinning the CURRENT add-failure behavior before the
  // setupCrudRepository migration: addCohort writes fields directly and does
  // NOT compensating-delete a partially-created row (a UNIQUE collision fails
  // atomically on the name-first write, so there is nothing to clean up). This
  // distinguishes the writeFields-delegation migration from a createRecord one,
  // which would add a rollback delete that changes behavior. Must stay green,
  // unedited, post-migration.
  it('does not compensating-delete when a later field write fails while adding a program', async () => {
    localClient.list.mockResolvedValue([])
    localClient.write.mockImplementation((token, entity, id, field) => {
      if (field === 'name') return Promise.resolve({ status: 'applied' })
      return Promise.reject(new Error('disk failure'))
    })
    render(<CohortsScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('No programs yet')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Name (e.g. Main, Specialty)'), {
      target: { value: 'Specialty' },
    })
    fireEvent.click(screen.getByText('+ Add Program'))

    await waitFor(() =>
      expect(screen.queryByText(/That program could not be added\./)).not.toBeNull()
    )
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('shows a specific message (not the generic connectivity one) when deleting fails due to a foreign-key reference', async () => {
    localClient.list.mockResolvedValue([cohort({ id: 'c1' }), cohort({ id: 'c2', name: 'Second' })])
    localClient.deleteEntity.mockRejectedValue(
      new Error('FOREIGN KEY constraint failed')
    )
    render(<CohortsScreen campId={CAMP_ID} />)
    await waitFor(() => expect(screen.queryByText('Main')).not.toBeNull())

    fireEvent.click(screen.getAllByText('Delete')[0])

    await waitFor(() =>
      expect(
        screen.queryByText(
          "Can't delete — other data (time blocks or fixed events) still references this program. Remove those first."
        )
      ).not.toBeNull()
    )
  })
})
