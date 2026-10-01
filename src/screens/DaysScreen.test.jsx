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
    fixed_event_count: 0, overlay_count: 0, weather_dependent_count: 0,
  })
  localClient.deleteRecord.mockReset().mockResolvedValue({ ok: true, cleared: 0 })
})

describe('DaysScreen', () => {
  it('loads days scoped to campId via localClient.list, sorted by day_of_week (weekday order)', async () => {
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

  it('has no Sort Order input or column anywhere in the DOM', async () => {
    localClient.list.mockResolvedValue([day()])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

    expect(screen.queryByText('Sort Order')).toBeNull()
    expect(screen.queryByPlaceholderText('Order')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Monday' }))
    expect(screen.queryByPlaceholderText('Order')).toBeNull()
  })

  it('adds a day from the inline blank row by writing each field via localClient.write, day_of_week first (UNIQUE_FIRST_FIELD auto-reorder), deriving sort_order from day_of_week', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No days yet')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Day (e.g. Monday)'), { target: { value: 'Wednesday' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const [, , , firstField] = localClient.write.mock.calls[0]
    expect(firstField).toBe('day_of_week')
    const fieldsWritten = localClient.write.mock.calls.map(c => c[3])
    expect(fieldsWritten).toEqual(expect.arrayContaining(['label', 'camp_id', 'day_of_week', 'sort_order']))
    const sortOrderCall = localClient.write.mock.calls.find(c => c[3] === 'sort_order')
    const dayOfWeekCall = localClient.write.mock.calls.find(c => c[3] === 'day_of_week')
    expect(sortOrderCall[4]).toBe(dayOfWeekCall[4])
  })

  it('adds a day when Enter is pressed in the inline row label input', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No days yet')).not.toBeNull())

    const labelInput = screen.getByPlaceholderText('Day (e.g. Monday)')
    fireEvent.change(labelInput, { target: { value: 'Sunday' } })
    fireEvent.keyDown(labelInput, { key: 'Enter' })

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const labelsWritten = localClient.write.mock.calls.filter(c => c[3] === 'label').map(c => c[4])
    expect(labelsWritten).toContain('Sunday')
  })

  it('adds a day when focus leaves the inline row entirely (blur-to-commit)', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No days yet')).not.toBeNull())

    const labelInput = screen.getByPlaceholderText('Day (e.g. Monday)')
    fireEvent.change(labelInput, { target: { value: 'Saturday' } })
    // Blur with relatedTarget outside the row commits the add.
    fireEvent.blur(labelInput, { relatedTarget: document.body })

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const labelsWritten = localClient.write.mock.calls.filter(c => c[3] === 'label').map(c => c[4])
    expect(labelsWritten).toContain('Saturday')
  })

  it('does not commit the inline row on blur when the label is empty', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No days yet')).not.toBeNull())

    const labelInput = screen.getByPlaceholderText('Day (e.g. Monday)')
    fireEvent.blur(labelInput, { relatedTarget: document.body })

    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('clears the inline row and keeps it present after a successful add', async () => {
    localClient.list.mockResolvedValueOnce([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No days yet')).not.toBeNull())

    // After the add, the reload returns the newly-created day.
    localClient.list.mockResolvedValue([day({ id: 'new-day-id', label: 'Wednesday', day_of_week: 3, sort_order: 3 })])
    const labelInput = screen.getByPlaceholderText('Day (e.g. Monday)')
    fireEvent.change(labelInput, { target: { value: 'Wednesday' } })
    fireEvent.click(screen.getByText('+ Add'))

    // The created day now shows as a real row...
    await waitFor(() => expect(screen.queryByText('1 day')).not.toBeNull())
    // ...and the blank row is still there, cleared, ready for the next entry.
    const blankInput = screen.getByPlaceholderText('Day (e.g. Monday)')
    expect(blankInput.value).toBe('')
  })

  it('cleans up a partial row if a later field write fails during add', async () => {
    localClient.list.mockResolvedValue([])
    localClient.write.mockImplementation((token, entity, id, field) => {
      if (field === 'sort_order') return Promise.resolve({ status: 'rejected' })
      return Promise.resolve({ status: 'applied' })
    })
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No days yet')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Day (e.g. Monday)'), { target: { value: 'Thursday' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'days_of_operation', 'new-day-id'))
    await waitFor(() => expect(screen.queryByText(/That day could not be added/)).not.toBeNull())
  })

  it('commits the add on Enter from the day-of-week select, a secondary field, when the row is valid', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No days yet')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Day (e.g. Monday)'), { target: { value: 'Friday' } })
    const dowSelect = screen.getByDisplayValue('Monday')
    fireEvent.keyDown(dowSelect, { key: 'Enter' })

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
  })

  it('does not add on Enter from a secondary field when the row is invalid (no label)', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No days yet')).not.toBeNull())

    fireEvent.keyDown(screen.getByDisplayValue('Monday'), { key: 'Enter' })

    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('names the schedule cells and recurring events a day holds, before deleting it', async () => {
    localClient.list.mockResolvedValue([day()])
    localClient.previewDelete.mockResolvedValue({
      ok: true, entity: 'days_of_operation', entity_id: 'day-1', name: 'Monday',
      destructive: true, slot_count: 30, routes: [], unprotected_count: 0,
      fixed_event_count: 1, fixed_event_kind_counts: { fixed: 0, recurring: 1 }, weather_dependent_count: 0,
    })
    localClient.deleteRecord.mockResolvedValue({ ok: true, cleared: 30 })
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    // Two different things to a director, reported as two things.
    await waitFor(() => expect(screen.queryAllByText(/30 places/).length).toBeGreaterThan(0))
    expect(screen.queryByText(/1 recurring event/)).not.toBeNull()
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
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

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
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

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
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all days?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete all days?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('disables Delete All for non-admin roles', async () => {
    localClient.list.mockResolvedValue([day()])
    render(<DaysScreen campId={CAMP_ID} role="staff" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

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
    await waitFor(() => expect(screen.queryByText('No days yet')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Day (e.g. Monday)'), { target: { value: 'Monday' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(screen.queryByText(/Another record already has that name/)).not.toBeNull())
  })

  it('saves an edited day by writing only the changed fields via localClient.write', async () => {
    localClient.list.mockResolvedValue([day()])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Edit Monday' }))
    const labelInput = screen.getAllByDisplayValue('Monday')[0]
    fireEvent.change(labelInput, { target: { value: 'Mon' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'days_of_operation', 'day-1', 'label', 'Mon')
    )
  })

  it('re-derives sort_order from day_of_week when saving an edited day', async () => {
    localClient.list.mockResolvedValue([day()])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Edit Monday' }))
    const dowSelect = screen.getAllByDisplayValue('Monday')[1]
    fireEvent.change(dowSelect, { target: { value: '3' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'days_of_operation', 'day-1', 'sort_order', 3)
    )
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'days_of_operation', 'day-1', 'day_of_week', 3)
  })

  // Days offers bulk Excel import like the other setup screens (Wave B2
  // coherence — every setup screen now exposes the same Import affordance).
  it('exposes an "Import from Excel" affordance', async () => {
    localClient.list.mockResolvedValue([day()])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())
    expect(screen.queryByText('Import from Excel')).not.toBeNull()
  })

  it('imports days from Excel, leaving an unchanged duplicate alone (case-insensitive) and skipping rows with a warning', async () => {
    localClient.list.mockResolvedValue([day({ id: 'd1', label: 'Monday', day_of_week: 1 })])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

    const file = new File(['dummy'], 'days.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue([
      { label: 'monday', day_of_week: 1, sort_order: 1 }, // duplicate (case-insensitive), identical -> unchanged
      { label: '', day_of_week: 2, sort_order: 2 },       // missing label -> warning
      { label: 'Tuesday', day_of_week: 2, sort_order: 2 }, // new, valid
    ])

    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => expect(screen.queryByText(/1 with warnings/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 2/))

    await waitFor(() => expect(screen.queryByText(/1 new/)).not.toBeNull())
    expect(screen.queryByText(/1 unchanged/)).not.toBeNull()
    const labelsWritten = localClient.write.mock.calls.filter(c => c[3] === 'label').map(c => c[4])
    expect(labelsWritten).toEqual(['Tuesday'])
  })

  // board q-export-columns-do-not-round-trip, B3 — a re-imported row whose natural key
  // (label) already exists but carries a changed field is UPDATED, not skipped.
  it('updates an existing day when a re-imported row changes a field', async () => {
    localClient.list.mockResolvedValue([day({ id: 'd1', label: 'Monday', day_of_week: 1 })])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

    const file = new File(['dummy'], 'days.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue([
      { label: 'Monday', day_of_week: 2, sort_order: 2 }, // same label, changed day_of_week
    ])
    fireEvent.change(fileInput, { target: { files: [file] } })
    await waitFor(() => expect(screen.queryByText(/1 ready/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 1/))

    await waitFor(() => expect(screen.queryByText(/1 updated/)).not.toBeNull())
    const dowWrites = localClient.write.mock.calls.filter(c => c[3] === 'day_of_week')
    expect(dowWrites).toHaveLength(1)
    expect(dowWrites[0][2]).toBe('d1')
  })

  // Red Hat HIGH — a SECOND sheet row sharing a natural key must diff against what the
  // FIRST row actually applied, not the stale pre-import value. Without this, row 1 sets
  // day_of_week 1 -> 3 (applied), row 2 sets it back to 1 — diffed against the stale
  // original (1) that reads as "unchanged" and row 2's own change is silently dropped,
  // leaving the DB at 3 instead of row 2's 1.
  it('a later row sharing the same key diffs against the FIRST row\'s applied value, not the stale original (last-row-wins is honest)', async () => {
    localClient.list.mockResolvedValue([day({ id: 'd1', label: 'Monday', day_of_week: 1 })])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

    const file = new File(['dummy'], 'days.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue([
      { label: 'Monday', day_of_week: 3 }, // first: 1 -> 3, an update
      { label: 'Monday', day_of_week: 1 }, // second, same key: back to 1 — must ALSO update
    ])
    fireEvent.change(fileInput, { target: { files: [file] } })
    await waitFor(() => expect(screen.queryByText(/2 ready/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 2/))

    await waitFor(() => expect(screen.queryByText(/2 updated/)).not.toBeNull())
    const dowWrites = localClient.write.mock.calls.filter(c => c[3] === 'day_of_week').map(c => c[4])
    expect(dowWrites).toEqual([3, 1])
  })

  // board q-export-columns-do-not-round-trip, B2b derive-or-name — a file with no
  // day_of_week column at all still imports, deriving it from a recognizable weekday
  // name in the label instead of blocking the whole import.
  it('derives day_of_week from a weekday-name label when the column is absent', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Import from Excel')).not.toBeNull())

    const file = new File(['dummy'], 'days.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue([{ label: 'Wednesday' }])
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => expect(screen.queryByText(/1 ready/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 1/))
    await waitFor(() => expect(screen.queryByText(/1 new/)).not.toBeNull())
    const dowWrites = localClient.write.mock.calls.filter(c => c[3] === 'day_of_week')
    expect(dowWrites[0][4]).toBe(3)
  })

  it('flags a row that cannot be matched to a weekday as needing a director\'s eye, not a guess', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Import from Excel')).not.toBeNull())

    const file = new File(['dummy'], 'days.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue([{ label: 'Opening Day' }])
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => expect(screen.queryByText(/cannot determine day_of_week/)).not.toBeNull())
  })

  // honest-atomicity-half — an UNEXPECTED failure stops the loop immediately and reports
  // exactly how many rows landed before it, never claiming atomicity.
  it('stops the import loop on an unexpected row failure and reports how many rows already landed', async () => {
    localClient.list.mockResolvedValue([])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Import from Excel')).not.toBeNull())

    const file = new File(['dummy'], 'days.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue([
      { label: 'Monday', day_of_week: 1 },
      { label: 'Tuesday', day_of_week: 2 },
      { label: 'Wednesday', day_of_week: 3 },
    ])
    fireEvent.change(fileInput, { target: { files: [file] } })
    await waitFor(() => expect(screen.queryByText(/3 ready/)).not.toBeNull())

    localClient.write
      .mockResolvedValueOnce({ status: 'applied' }) // Monday day_of_week
      .mockResolvedValueOnce({ status: 'applied' }) // Monday label
      .mockResolvedValueOnce({ status: 'applied' }) // Monday camp_id
      .mockResolvedValueOnce({ status: 'applied' }) // Monday sort_order
      .mockRejectedValueOnce(new Error('disk full')) // Tuesday's first write fails

    fireEvent.click(screen.getByText(/Import 3/))

    await waitFor(() => expect(screen.queryByText(/No further rows were written/)).not.toBeNull())
    expect(screen.queryByText(/row 2 \('Tuesday'\) failed: disk full/)).not.toBeNull()
    // Wednesday was never attempted.
    const labelsWritten = localClient.write.mock.calls.filter(c => c[3] === 'label').map(c => c[4])
    expect(labelsWritten).toEqual(['Monday'])
  })
})

describe('DaysScreen — row-click to edit', () => {
  it('has no visible Edit button', async () => {
    localClient.list.mockResolvedValue([day()])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())
    expect(screen.queryByText('Edit')).toBeNull()
  })

  it('Enter on a focused row enters edit mode', async () => {
    localClient.list.mockResolvedValue([day()])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

    const row = screen.getByRole('button', { name: 'Edit Monday' })
    fireEvent.keyDown(row, { key: 'Enter' })

    expect(screen.getAllByDisplayValue('Monday')[0]).not.toBeNull()
  })

  it('clicking Delete does not enter edit mode', async () => {
    localClient.list.mockResolvedValue([day()])
    render(<DaysScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Monday' })).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(localClient.previewDelete).toHaveBeenCalled())
    expect(screen.queryByText('Save')).toBeNull()
  })
})
