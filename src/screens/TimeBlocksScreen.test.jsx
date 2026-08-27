// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
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

import TimeBlocksScreen from './TimeBlocksScreen'
import { localClient } from '../localClient'
import * as XLSX from 'xlsx'

const CAMP_ID = 'camp-1'
const COHORT_ID = 'cohort-1'

function cohort(overrides = {}) {
  return { id: COHORT_ID, camp_id: CAMP_ID, name: 'Summer', sort_order: 1, ...overrides }
}

function block(overrides = {}) {
  return {
    id: 'block-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Block 1',
    start_time: '09:00', end_time: '10:00', part_of_day: 'morning', sort_order: 1,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'new-block-id' })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset().mockImplementation(entity => {
    if (entity === 'cohorts') return Promise.resolve([cohort()])
    if (entity === 'time_blocks') return Promise.resolve([block()])
    return Promise.resolve([])
  })
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  XLSX.utils.sheet_to_json.mockReset().mockReturnValue([])
  XLSX.read.mockReset().mockReturnValue({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })
})

describe('TimeBlocksScreen delete confirmation', () => {
  it('shows a styled confirm modal (not window.confirm) with honest, uncounted copy before deleting', async () => {
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    expect(window.confirm).not.toHaveBeenCalled()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Delete "Block 1"?')).not.toBeNull())
    expect(screen.queryByText(/will no longer appear on the grid or in exports/)).not.toBeNull()

    fireEvent.click(screen.getByText('Delete Time Block'))
    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'time_blocks', 'block-1'))
  })

  it('cancels without deleting', async () => {
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Block 1"?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete "Block 1"?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('dismisses on Escape without deleting', async () => {
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Block 1"?')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByText('Delete "Block 1"?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('dismisses on backdrop click without deleting', async () => {
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Block 1"?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete "Block 1"?').closest('[style*="position: fixed"]'))

    expect(screen.queryByText('Delete "Block 1"?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })
})

describe('TimeBlocksScreen — cohort-scoped load', () => {
  it('loads time blocks scoped to campId AND cohort_id, sorted by sort_order then start_time', async () => {
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'time_blocks') return Promise.resolve([
        block({ id: 'b2', name: 'Block B', sort_order: 2 }),
        block({ id: 'b1', name: 'Block A', sort_order: 1 }),
        block({ id: 'b-wrong-cohort', name: 'Wrong Cohort', cohort_id: 'other-cohort' }),
        block({ id: 'b-wrong-camp', name: 'Wrong Camp', camp_id: 'other-camp' }),
      ])
      return Promise.resolve([])
    })
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('2 blocks')).not.toBeNull())
    expect(screen.queryByText('Wrong Cohort')).toBeNull()
    expect(screen.queryByText('Wrong Camp')).toBeNull()
    const rows = document.querySelectorAll('tbody tr')
    expect(rows[0].textContent).toContain('Block A')
    expect(rows[1].textContent).toContain('Block B')
  })
})

describe('TimeBlocksScreen — add', () => {
  it('adds a time block by writing each field via localClient.write, name first', async () => {
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'time_blocks') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 blocks')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Name (e.g. Block 1)'), { target: { value: 'Block 1' } })
    const timeInputs = document.querySelectorAll('input[type="time"]')
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } })
    fireEvent.change(timeInputs[1], { target: { value: '10:00' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const [, , , firstField] = localClient.write.mock.calls[0]
    expect(firstField).toBe('name')
    const fieldsWritten = localClient.write.mock.calls.map(c => c[3])
    expect(fieldsWritten).toEqual(expect.arrayContaining(['name', 'camp_id', 'cohort_id', 'start_time', 'end_time', 'part_of_day', 'sort_order']))
  })

  it('cleans up a partial row if a later field write fails during add', async () => {
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'time_blocks') return Promise.resolve([])
      return Promise.resolve([])
    })
    localClient.write.mockImplementation((token, entity, id, field) => {
      if (field === 'sort_order') return Promise.resolve({ status: 'rejected' })
      return Promise.resolve({ status: 'applied' })
    })
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 blocks')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Name (e.g. Block 1)'), { target: { value: 'Block 1' } })
    const timeInputs = document.querySelectorAll('input[type="time"]')
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } })
    fireEvent.change(timeInputs[1], { target: { value: '10:00' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'time_blocks', 'new-block-id'))
    await waitFor(() => expect(screen.queryByText(/That time block could not be added/)).not.toBeNull())
  })

  it('commits the add on Enter from the end-time field, a secondary field, when the row is valid', async () => {
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'time_blocks') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 blocks')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Name (e.g. Block 1)'), { target: { value: 'Block 1' } })
    const timeInputs = document.querySelectorAll('input[type="time"]')
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } })
    fireEvent.change(timeInputs[1], { target: { value: '10:00' } })
    fireEvent.keyDown(timeInputs[1], { key: 'Enter' })

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
  })

  it('commits the add on Enter from the sort-order field, a secondary field, when the row is valid', async () => {
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'time_blocks') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 blocks')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Name (e.g. Block 1)'), { target: { value: 'Block 1' } })
    const timeInputs = document.querySelectorAll('input[type="time"]')
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } })
    fireEvent.change(timeInputs[1], { target: { value: '10:00' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Order'), { key: 'Enter' })

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
  })

  it('does not add on Enter from a secondary field when the row is invalid (missing start/end time)', async () => {
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'time_blocks') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 blocks')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Name (e.g. Block 1)'), { target: { value: 'Block 1' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Order'), { key: 'Enter' })

    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('shows a collision-specific message when the underlying write fails with UNIQUE', async () => {
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'time_blocks') return Promise.resolve([])
      return Promise.resolve([])
    })
    localClient.write.mockImplementation((token, entity, id, field) => {
      if (field === 'sort_order') {
        return Promise.reject(new Error('UNIQUE constraint failed: time_blocks.camp_id, time_blocks.cohort_id, time_blocks.name'))
      }
      return Promise.resolve({ status: 'applied' })
    })
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 blocks')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Name (e.g. Block 1)'), { target: { value: 'Block 1' } })
    const timeInputs = document.querySelectorAll('input[type="time"]')
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } })
    fireEvent.change(timeInputs[1], { target: { value: '10:00' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(screen.queryByText(/already exists/)).not.toBeNull())
  })
})

describe('TimeBlocksScreen — save', () => {
  it('saves an edited time block by writing the changed fields via localClient.write', async () => {
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Edit Block 1' }))
    const nameInput = screen.getAllByDisplayValue('Block 1')[0]
    fireEvent.change(nameInput, { target: { value: 'Block One' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'time_blocks', 'block-1', 'name', 'Block One')
    )
  })
})

describe('TimeBlocksScreen — deleteAll', () => {
  it('shows a styled confirm modal (not window.confirm) before deleting, and confirming deletes', async () => {
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    expect(window.confirm).not.toHaveBeenCalled()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Delete all time blocks?')).not.toBeNull())
    expect(screen.queryByText('They can be restored from Trash.')).not.toBeNull()

    fireEvent.click(screen.getByText('Delete All Time Blocks'))
    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'time_blocks', 'block-1'))
  })

  it('cancels without deleting', async () => {
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all time blocks?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete all time blocks?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('re-fetches fresh, cohort-scoped time blocks via localClient.list before deleting, not the stale rows state', async () => {
    let blocksCallCount = 0
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'time_blocks') {
        blocksCallCount += 1
        // Call 1: initial load. Call 2: deleteAll's fresh refetch, with a row
        // another device synced in after page-load. Call 3: reload after delete.
        if (blocksCallCount === 1) return Promise.resolve([block()])
        if (blocksCallCount === 2) return Promise.resolve([block(), block({ id: 'block-2', name: 'Block Two' })])
        return Promise.resolve([])
      }
      return Promise.resolve([])
    })
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('1 block')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all time blocks?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete All Time Blocks'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledTimes(2))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'time_blocks', 'block-1')
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'time_blocks', 'block-2')
  })

  it('shows an admin-role-specific message when deleteAll is rejected for a non-admin', async () => {
    localClient.deleteEntity.mockRejectedValue(new Error('admin role required'))
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all time blocks?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete All Time Blocks'))

    await waitFor(() => expect(screen.queryByText(/Only an admin can delete time blocks — no time blocks were deleted/)).not.toBeNull())
  })

  it('disables Delete All for non-admin roles', async () => {
    render(<TimeBlocksScreen campId={CAMP_ID} role="staff" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    expect(screen.getByText('Delete All').disabled).toBe(true)
  })

  it('surfaces an error banner when deleteAll fails unexpectedly instead of silently closing', async () => {
    let blocksCalls = 0
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'time_blocks') {
        blocksCalls += 1
        // Call 1 = initial load; call 2 = deleteAll's re-fetch, which throws.
        return blocksCalls === 1 ? Promise.resolve([block()]) : Promise.reject(new Error('disk failure'))
      }
      return Promise.resolve([])
    })
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all time blocks?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete All Time Blocks'))

    await waitFor(() => expect(screen.queryByText(/Those time blocks could not be deleted/)).not.toBeNull())
  })
})

describe('TimeBlocksScreen — import', () => {
  it('imports rows from Excel, skipping duplicates (case-insensitive) and rows with a validation warning', async () => {
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    const file = new File(['dummy'], 'time_blocks.xlsx')
    const fileInput = document.querySelector('input[type="file"]')

    const rows = [
      { name: 'block 1', start_time: '09:00', end_time: '10:00', part_of_day: 'morning', sort_order: 1 }, // duplicate, case-insensitive
      { name: '', start_time: '', end_time: '', part_of_day: '', sort_order: 2 }, // missing name -> warning
      { name: 'Block 2', start_time: '10:00', end_time: '11:00', part_of_day: 'morning', sort_order: 2 }, // new, valid
    ]
    XLSX.utils.sheet_to_json.mockReturnValue(rows)
    XLSX.read.mockReturnValue({ SheetNames: ['Time Blocks'], Sheets: { 'Time Blocks': {} } })

    await userEvent.upload(fileInput, file)

    await waitFor(() => expect(screen.queryByText(/1 with warnings/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 2/))

    await waitFor(() => expect(screen.queryByText(/1 added/)).not.toBeNull())
    expect(screen.queryByText(/2 skipped/)).not.toBeNull()
    const namesWritten = localClient.write.mock.calls.filter(c => c[3] === 'name').map(c => c[4])
    expect(namesWritten).toEqual(['Block 2'])
  })
})

describe('TimeBlocksScreen — row-click to edit', () => {
  it('has no visible Edit button', async () => {
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())
    expect(screen.queryByText('Edit')).toBeNull()
  })

  it('Enter on a focused row enters edit mode', async () => {
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    const row = screen.getByRole('button', { name: 'Edit Block 1' })
    fireEvent.keyDown(row, { key: 'Enter' })

    expect(screen.getAllByDisplayValue('Block 1')[0]).not.toBeNull()
  })

  it('clicking Delete does not enter edit mode', async () => {
    render(<TimeBlocksScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Block 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(screen.queryByText('Delete "Block 1"?')).not.toBeNull())
    expect(screen.queryByDisplayValue('Block 1')).toBeNull()
  })
})
