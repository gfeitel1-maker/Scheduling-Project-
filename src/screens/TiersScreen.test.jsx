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

import TiersScreen from './TiersScreen'
import { localClient } from '../localClient'
import * as XLSX from 'xlsx'

const CAMP_ID = 'camp-1'
const COHORT_ID = 'cohort-1'

function cohort(overrides = {}) {
  return { id: COHORT_ID, camp_id: CAMP_ID, name: 'Summer', sort_order: 1, ...overrides }
}

function tier(overrides = {}) {
  return { id: 'tier-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Yeladim', sort_order: 1, ...overrides }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'new-tier-id' })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset().mockImplementation(entity => {
    if (entity === 'cohorts') return Promise.resolve([cohort()])
    if (entity === 'tiers') return Promise.resolve([tier()])
    if (entity === 'groups') return Promise.resolve([])
    return Promise.resolve([])
  })
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  XLSX.utils.sheet_to_json.mockReset().mockReturnValue([])
  XLSX.read.mockReset().mockReturnValue({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })
})

describe('TiersScreen delete confirmation', () => {
  it('shows a styled confirm modal (not window.confirm) naming the unit before deleting', async () => {
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    expect(window.confirm).not.toHaveBeenCalled()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Delete "Yeladim"?')).not.toBeNull())
    expect(screen.queryByText('This unit has no groups, so nothing in your schedules is affected.')).not.toBeNull()

    fireEvent.click(screen.getByText('Delete Unit'))
    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'tiers', 'tier-1'))
  })

  it('cancels without deleting', async () => {
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Yeladim"?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete "Yeladim"?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('shows honest, count-aware copy when the unit still has groups', async () => {
    // The row's Delete button is gated on groupCount and stays disabled
    // whenever this device's local groupCounts is nonzero — but that count
    // can go stale mid-session (another device assigns a group to this
    // unit while the confirm dialog is already open on this one, and a
    // subsequent reload picks it up). The dialog body must independently
    // reflect the live count rather than trusting the button already
    // screened it out. Simulate that by opening the dialog while the
    // count is 0 (button enabled, reassurance copy shown), then forcing a
    // reload — via the unrelated Save action, which already calls load()
    // — that returns an updated group for this tier.
    let groupsCallCount = 0
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'tiers') return Promise.resolve([tier()])
      if (entity === 'groups') {
        groupsCallCount += 1
        return Promise.resolve(
          groupsCallCount === 1 ? [] : [{ id: 'g1', camp_id: CAMP_ID, tier_id: 'tier-1', name: 'Group A' }]
        )
      }
      return Promise.resolve([])
    })
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Yeladim"?')).not.toBeNull())
    expect(screen.queryByText('This unit has no groups, so nothing in your schedules is affected.')).not.toBeNull()

    fireEvent.click(screen.getByText('Edit'))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(screen.queryByText(/This unit still has 1 group assigned to it/)).not.toBeNull())
    expect(screen.queryByText('This unit has no groups, so nothing in your schedules is affected.')).toBeNull()
  })

  it('dismisses on Escape without deleting', async () => {
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Yeladim"?')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByText('Delete "Yeladim"?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('dismisses on backdrop click without deleting', async () => {
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Yeladim"?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete "Yeladim"?').closest('[style*="position: fixed"]'))

    expect(screen.queryByText('Delete "Yeladim"?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })
})

describe('TiersScreen — cohort-scoped load', () => {
  it('loads tiers scoped to campId AND cohort_id, sorted by sort_order', async () => {
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'tiers') return Promise.resolve([
        tier({ id: 't2', name: 'Bogrim', sort_order: 2 }),
        tier({ id: 't1', name: 'Yeladim', sort_order: 1 }),
        tier({ id: 't-wrong-cohort', name: 'Wrong Cohort', cohort_id: 'other-cohort' }),
        tier({ id: 't-wrong-camp', name: 'Wrong Camp', camp_id: 'other-camp' }),
      ])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('2 units')).not.toBeNull())
    expect(screen.queryByText('Wrong Cohort')).toBeNull()
    expect(screen.queryByText('Wrong Camp')).toBeNull()
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows[0].textContent).toContain('Yeladim')
    expect(rows[1].textContent).toContain('Bogrim')
  })
})

describe('TiersScreen — add', () => {
  it('adds a tier by writing each field via localClient.write, name first', async () => {
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 units')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Unit name (e.g. Yeladim)'), { target: { value: 'Bogrim' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const [, , , firstField] = localClient.write.mock.calls[0]
    expect(firstField).toBe('name')
    const fieldsWritten = localClient.write.mock.calls.map(c => c[3])
    expect(fieldsWritten).toEqual(expect.arrayContaining(['name', 'camp_id', 'cohort_id', 'sort_order']))
  })

  it('cleans up a partial row if a later field write fails during add', async () => {
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })
    localClient.write.mockImplementation((token, entity, id, field) => {
      if (field === 'sort_order') return Promise.resolve({ status: 'rejected' })
      return Promise.resolve({ status: 'applied' })
    })
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 units')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Unit name (e.g. Yeladim)'), { target: { value: 'Bogrim' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'tiers', 'new-tier-id'))
    await waitFor(() => expect(screen.queryByText(/That unit could not be added/)).not.toBeNull())
  })

  it('shows a collision-specific message when the underlying write fails with UNIQUE', async () => {
    // The add() button itself pre-checks names client-side (a different code
    // path than the shared write-collision handling below it), so drive this
    // through a name the client-side check would not catch — the write layer
    // failing with a UNIQUE error regardless of the pre-check.
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })
    localClient.write.mockImplementation((token, entity, id, field) => {
      if (field === 'sort_order') {
        return Promise.reject(new Error('UNIQUE constraint failed: tiers.camp_id, tiers.cohort_id, tiers.name'))
      }
      return Promise.resolve({ status: 'applied' })
    })
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('0 units')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Unit name (e.g. Yeladim)'), { target: { value: 'Bogrim' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(screen.queryByText(/already exists/)).not.toBeNull())
  })
})

describe('TiersScreen — save', () => {
  it('saves an edited tier by writing the changed fields via localClient.write', async () => {
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    const nameInput = screen.getAllByDisplayValue('Yeladim')[0]
    fireEvent.change(nameInput, { target: { value: 'Yeladim Tzeirim' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'tiers', 'tier-1', 'name', 'Yeladim Tzeirim')
    )
  })
})

describe('TiersScreen — deleteAll', () => {
  it('re-fetches fresh, cohort-scoped tiers via localClient.list before deleting, not the stale rows state', async () => {
    let tiersCallCount = 0
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'tiers') {
        tiersCallCount += 1
        // Call 1: initial load. Call 2: deleteAll's fresh refetch, with a row
        // another device synced in after page-load. Call 3: reload after delete.
        if (tiersCallCount === 1) return Promise.resolve([tier()])
        if (tiersCallCount === 2) return Promise.resolve([tier(), tier({ id: 'tier-2', name: 'Bogrim' })])
        return Promise.resolve([])
      }
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('1 unit')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledTimes(2))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'tiers', 'tier-1')
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'tiers', 'tier-2')
  })

  it('shows an admin-role-specific message when deleteAll is rejected for a non-admin', async () => {
    localClient.deleteEntity.mockRejectedValue(new Error('admin role required'))
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    await waitFor(() => expect(screen.queryByText(/Only an admin can delete units — no units were deleted/)).not.toBeNull())
  })

  it('disables Delete All for non-admin roles', async () => {
    render(<TiersScreen campId={CAMP_ID} role="staff" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim')).not.toBeNull())

    expect(screen.getByText('Delete All').disabled).toBe(true)
  })

  it('surfaces an error banner when deleteAll fails unexpectedly instead of silently closing', async () => {
    let tiersCalls = 0
    localClient.list.mockReset().mockImplementation(entity => {
      if (entity === 'cohorts') return Promise.resolve([cohort()])
      if (entity === 'tiers') {
        tiersCalls += 1
        // Call 1 = initial load; call 2 = deleteAll's re-fetch, which throws.
        return tiersCalls === 1 ? Promise.resolve([tier()]) : Promise.reject(new Error('disk failure'))
      }
      return Promise.resolve([])
    })
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    await waitFor(() => expect(screen.queryByText(/Those units could not be deleted/)).not.toBeNull())
  })
})

describe('TiersScreen — import', () => {
  it('imports rows from Excel, skipping duplicates (case-insensitive) and rows with a validation warning', async () => {
    render(<TiersScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim')).not.toBeNull())

    const file = new File(['dummy'], 'units.xlsx')
    const fileInput = document.querySelector('input[type="file"]')

    const rows = [
      { name: 'yeladim', sort_order: 1 }, // duplicate, case-insensitive
      { name: '', sort_order: 2 }, // missing name -> warning
      { name: 'Bogrim', sort_order: 2 }, // new, valid
    ]
    XLSX.utils.sheet_to_json.mockReturnValue(rows)
    XLSX.read.mockReturnValue({ SheetNames: ['Units'], Sheets: { Units: {} } })

    await userEvent.upload(fileInput, file)

    await waitFor(() => expect(screen.queryByText(/1 with warnings/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 2 units/))

    await waitFor(() => expect(screen.queryByText(/1 added/)).not.toBeNull())
    expect(screen.queryByText(/2 skipped/)).not.toBeNull()
    const namesWritten = localClient.write.mock.calls.filter(c => c[3] === 'name').map(c => c[4])
    expect(namesWritten).toEqual(['Bogrim'])
  })
})
