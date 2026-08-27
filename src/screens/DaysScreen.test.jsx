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

vi.mock('xlsx', () => ({
  utils: {
    book_new: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
    sheet_to_json: vi.fn(() => []),
  },
  writeFile: vi.fn(),
  read: vi.fn(() => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })),
}))

import DaysScreen from './DaysScreen'
import { localClient } from '../localClient'
import * as XLSX from 'xlsx'

const CAMP_ID = 'camp-1'

function day(overrides = {}) {
  return {
    id: 'day-1',
    camp_id: CAMP_ID,
    label: 'Monday',
    day_of_week: 1,
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
  vi.stubGlobal('crypto', { randomUUID: () => 'new-day-id' })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  XLSX.utils.sheet_to_json.mockReset().mockReturnValue([])
  XLSX.read.mockReset().mockReturnValue({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })
  localClient.previewDelete.mockReset().mockResolvedValue({
    ok: true, entity: 'days_of_operation', entity_id: 'day-1', name: 'Monday',
    destructive: true, slot_count: 0, routes: [], unprotected_count: 0,
    anchor_count: 0, overlay_count: 0, weather_dependent_count: 0,
  })
  localClient.deleteRecord.mockReset().mockResolvedValue({ ok: true, cleared: 0 })
})

describe('DaysScreen', () => {
  it('loads days scoped to campId via localClient.list, sorted by sort_order', async () => {
    localClient.list.mockResolvedValue([
      day({ id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 2 }),
      day({ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 1 }),
      day({ id: 'd-other', label: 'Wrong Camp', camp_id: 'other-camp' }),
    ])

    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('2 days')).not.toBeNull())
    expect(localClient.list).toHaveBeenCalledWith('days_of_operation')
    expect(screen.queryByText('Wrong Camp')).toBeNull()

    const rows = screen.getAllByRole('row').slice(1) // skip header
    expect(rows[0].textContent).toContain('Monday')
    expect(rows[1].textContent).toContain('Tuesday')
  })

  it('adds a day by writing each field via localClient.write, label first', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 days')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Monday)'), { target: { value: 'Wednesday' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const [, , , firstField] = localClient.write.mock.calls[0]
    expect(firstField).toBe('label')
    const fieldsWritten = localClient.write.mock.calls.map(c => c[3])
    expect(fieldsWritten).toEqual(expect.arrayContaining(['label', 'camp_id', 'day_of_week', 'sort_order']))
  })

  it('cleans up a partial row if a later field write fails during add', async () => {
    localClient.list.mockResolvedValue([])
    localClient.write.mockImplementation((token, entity, id, field) => {
      if (field === 'sort_order') return Promise.resolve({ status: 'rejected' })
      return Promise.resolve({ status: 'applied' })
    })
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 days')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Monday)'), { target: { value: 'Thursday' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'days_of_operation', 'new-day-id'))
    await waitFor(() => expect(screen.queryByText(/That day could not be added/)).not.toBeNull())
  })

  it('commits the add on Enter from the day-of-week select, a secondary field, when the row is valid', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 days')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Monday)'), { target: { value: 'Friday' } })
    const dowSelect = screen.getByDisplayValue('Monday')
    fireEvent.keyDown(dowSelect, { key: 'Enter' })

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
  })

  it('commits the add on Enter from the sort-order field, a secondary field, when the row is valid', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 days')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Monday)'), { target: { value: 'Saturday' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Order'), { key: 'Enter' })

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
  })

  it('does not add on Enter from a secondary field when the row is invalid (no label)', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 days')).not.toBeNull())

    fireEvent.keyDown(screen.getByPlaceholderText('Order'), { key: 'Enter' })

    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('names the schedule cells, recurring events and overlays a day holds, before deleting it', async () => {
    localClient.list.mockResolvedValue([day()])
    localClient.previewDelete.mockResolvedValue({
      ok: true, entity: 'days_of_operation', entity_id: 'day-1', name: 'Monday',
      destructive: true, slot_count: 30, routes: [], unprotected_count: 0,
      anchor_count: 1, overlay_count: 2, weather_dependent_count: 0,
    })
    localClient.deleteRecord.mockResolvedValue({ ok: true, cleared: 30 })
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Monday')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    // Three different things to a director, reported as three things.
    await waitFor(() => expect(screen.queryAllByText(/30 places/).length).toBeGreaterThan(0))
    expect(screen.queryByText(/1 recurring event/)).not.toBeNull()
    expect(screen.queryByText(/2 trips or other overlay/)).not.toBeNull()
    expect(localClient.deleteRecord).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Delete and clear 30 places'))
    await waitFor(() =>
      expect(localClient.deleteRecord).toHaveBeenCalledWith('days_of_operation', 'day-1', 30)
    )
  })

  it('shows an admin-role-specific error when delete is rejected for a non-admin', async () => {
    localClient.list.mockResolvedValue([day()])
    localClient.previewDelete.mockRejectedValue(new Error('admin role required'))
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Monday')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(screen.queryByText(/Only an admin can delete days/)).not.toBeNull())
  })

  it('shows a load-failure banner when localClient.list rejects', async () => {
    localClient.list.mockRejectedValue(new Error('boom'))
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() =>
      expect(screen.queryByText(/Couldn't load your camp setup/)).not.toBeNull()
    )
  })

  it('shows a styled confirm modal (not window.confirm) before Delete All, and confirming deletes all camp-scoped days, camp-isolated from other camps', async () => {
    localClient.list.mockResolvedValue([
      day({ id: 'd1', label: 'Monday' }),
      day({ id: 'd2', label: 'Tuesday' }),
      day({ id: 'd-other', label: 'Wrong Camp', camp_id: 'other-camp' }),
    ])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('2 days')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    expect(window.confirm).not.toHaveBeenCalled()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Delete all days?')).not.toBeNull())
    expect(screen.queryByText('They can be restored from Trash.')).not.toBeNull()

    fireEvent.click(screen.getByText('Delete All Days'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledTimes(2))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'days_of_operation', 'd1')
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'days_of_operation', 'd2')
    expect(localClient.deleteEntity).not.toHaveBeenCalledWith('token-abc', 'days_of_operation', 'd-other')
  })

  it('surfaces an error banner when Delete All fails unexpectedly instead of silently closing', async () => {
    localClient.list.mockResolvedValue([day({ id: 'd1', label: 'Monday' })])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Monday')).not.toBeNull())

    // Open the confirm modal, then make the re-fetch inside deleteAll (in
    // useCrudScreen) throw — confirming must surface an error banner, not
    // close silently.
    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all days?')).not.toBeNull())
    localClient.list.mockRejectedValue(new Error('disk failure'))
    fireEvent.click(screen.getByText('Delete All Days'))

    await waitFor(() => expect(screen.queryByText(/Those days could not be deleted/)).not.toBeNull())
  })

  it('cancels Delete All without deleting', async () => {
    localClient.list.mockResolvedValue([day({ id: 'd1', label: 'Monday' })])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Monday')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all days?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete all days?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('disables Delete All for non-admin roles', async () => {
    localClient.list.mockResolvedValue([day()])
    render(<DaysScreen campId={CAMP_ID} role="staff" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Monday')).not.toBeNull())

    expect(screen.getByText('Delete All').disabled).toBe(true)
  })

  it('shows a collision-specific message when adding a day whose name already exists', async () => {
    localClient.list.mockResolvedValue([])
    // First write (label) succeeds and "creates" the row; a later field fails
    // with a UNIQUE violation (mirrors a real SQLite constraint failure).
    localClient.write.mockImplementation((token, entity, id, field) => {
      if (field === 'sort_order') {
        return Promise.reject(new Error('UNIQUE constraint failed: days_of_operation.camp_id, days_of_operation.name'))
      }
      return Promise.resolve({ status: 'applied' })
    })
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 days')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Monday)'), { target: { value: 'Monday' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(screen.queryByText(/Another record already has that name/)).not.toBeNull())
  })

  it('saves an edited day by writing only the changed fields via localClient.write', async () => {
    localClient.list.mockResolvedValue([day()])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Monday')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    const labelInput = screen.getAllByDisplayValue('Monday')[0]
    fireEvent.change(labelInput, { target: { value: 'Mon' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'days_of_operation', 'day-1', 'label', 'Mon')
    )
  })

  // Days deliberately omits bulk Excel import (SetupScreenShell `actions` config
  // — a director does not bulk-import 5 weekday rows); the old import-preview
  // test was removed along with the in-screen import UI it exercised.
})
