// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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

  it('names the schedule cells, fixed events and overlays a day holds, before deleting it', async () => {
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
    expect(screen.queryByText(/1 fixed event/)).not.toBeNull()
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
      expect(screen.queryByText(/Failed to load data/)).not.toBeNull()
    )
  })

  it('deletes all camp-scoped days via Delete All, camp-isolated from other camps', async () => {
    localClient.list.mockResolvedValue([
      day({ id: 'd1', label: 'Monday' }),
      day({ id: 'd2', label: 'Tuesday' }),
      day({ id: 'd-other', label: 'Wrong Camp', camp_id: 'other-camp' }),
    ])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('2 days')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledTimes(2))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'days_of_operation', 'd1')
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'days_of_operation', 'd2')
    expect(localClient.deleteEntity).not.toHaveBeenCalledWith('token-abc', 'days_of_operation', 'd-other')
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

  it('imports rows from Excel, skipping duplicates (case-insensitive) and rows with a validation warning', async () => {
    localClient.list.mockResolvedValue([day({ label: 'Monday' })])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Monday')).not.toBeNull())

    const file = new File(['dummy'], 'days.xlsx')
    const fileInput = document.querySelector('input[type="file"]')

    const rows = [
      { label: 'monday', day_of_week: 1, sort_order: 1 }, // duplicate, case-insensitive
      { label: '', day_of_week: 2, sort_order: 2 }, // missing label -> warning
      { label: 'Tuesday', day_of_week: 2, sort_order: 2 }, // new, valid
    ]
    XLSX.utils.sheet_to_json.mockReturnValue(rows)
    XLSX.read.mockReturnValue({ SheetNames: ['Days'], Sheets: { Days: {} } })

    await userEvent.upload(fileInput, file)

    // The preview's ready/warning split reflects PARSE validity only ("monday"
    // parses fine — the name-collision check happens later, at commit).
    await waitFor(() => expect(screen.queryByText(/2 ready/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 2/))

    await waitFor(() => expect(screen.queryByText(/1 added/)).not.toBeNull())
    expect(screen.queryByText(/2 skipped/)).not.toBeNull()
    const labelsWritten = localClient.write.mock.calls.filter(c => c[3] === 'label').map(c => c[4])
    expect(labelsWritten).toEqual(['Tuesday'])
  })
})
