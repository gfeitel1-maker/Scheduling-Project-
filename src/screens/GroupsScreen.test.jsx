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

import GroupsScreen from './GroupsScreen'
import { localClient } from '../localClient'
import * as XLSX from 'xlsx'

const CAMP_ID = 'camp-1'

function group(overrides = {}) {
  return {
    id: 'group-1',
    camp_id: CAMP_ID,
    name: 'Yeladim 1',
    tier_id: null,
    availability: 'all',
    ...overrides,
  }
}

function tier(overrides = {}) {
  return {
    id: 'tier-1',
    camp_id: CAMP_ID,
    name: 'Yeladim',
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
  vi.stubGlobal('crypto', { randomUUID: () => 'new-group-id' })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.previewDelete.mockReset().mockResolvedValue(preview())
  localClient.deleteRecord.mockReset().mockResolvedValue({ ok: true, cleared: 75 })
})

// docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md — the count is
// counted, and shown before the action.
function preview(overrides = {}) {
  return {
    ok: true,
    entity: 'groups',
    entity_id: 'group-1',
    name: 'Yeladim 1',
    destructive: true,
    slot_count: 75,
    routes: [],
    unprotected_count: 0,
    anchor_count: 0,
    overlay_count: 0,
    weather_dependent_count: 0,
    ...overrides,
  }
}

describe('GroupsScreen', () => {
  it('loads groups and tiers scoped to campId via localClient.list', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'groups') {
        return Promise.resolve([
          group({ id: 'g1', name: 'Yeladim 1' }),
          group({ id: 'g2', name: 'Other camp group', camp_id: 'other-camp' }),
        ])
      }
      if (entity === 'tiers') return Promise.resolve([tier()])
      return Promise.resolve([])
    })
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())
    expect(screen.queryByText('Other camp group')).toBeNull()
    expect(localClient.list).toHaveBeenCalledWith('groups')
    expect(localClient.list).toHaveBeenCalledWith('tiers')
  })

  it('adding a group writes each field via localClient.write with the token and reloads', async () => {
    localClient.list.mockImplementation((entity) => Promise.resolve(entity === 'tiers' ? [tier()] : []))
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No groups yet')).not.toBeNull())

    localClient.list.mockImplementation((entity) =>
      Promise.resolve(
        entity === 'groups' ? [group({ id: 'new-group-id', name: 'New Group' })] : [tier()]
      )
    )

    fireEvent.change(screen.getByPlaceholderText('Group name'), { target: { value: 'New Group' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(screen.queryByText('New Group')).not.toBeNull())

    expect(localClient.write).toHaveBeenCalledWith(
      'token-abc', 'groups', 'new-group-id', 'camp_id', CAMP_ID
    )
    expect(localClient.write).toHaveBeenCalledWith(
      'token-abc', 'groups', 'new-group-id', 'name', 'New Group'
    )
  })

  it('editing a group writes the changed fields and reloads', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [tier()])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Edit Yeladim 1' }))
    const nameInput = screen.getByDisplayValue('Yeladim 1')
    fireEvent.change(nameInput, { target: { value: 'Renamed' } })

    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group({ name: 'Renamed' })] : [tier()])
    )
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(screen.queryByText('Renamed')).not.toBeNull())
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'groups', 'group-1', 'name', 'Renamed')
  })

  it('states the real count BEFORE anything happens, and clears only on confirm', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    // The number is on screen and nothing has been deleted yet.
    await waitFor(() => expect(screen.queryByText(/used in 75 places/)).not.toBeNull())
    expect(localClient.deleteRecord).not.toHaveBeenCalled()

    localClient.list.mockImplementation(() => Promise.resolve([]))
    fireEvent.click(screen.getByText('Delete and clear 75 places'))

    await waitFor(() =>
      expect(localClient.deleteRecord).toHaveBeenCalledWith('groups', 'group-1', 75)
    )
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).toBeNull())
  })

  it('tells the director where the week went, in words, not "a snapshot"', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText(/bring the week back later from Versions/)).not.toBeNull())
    expect(screen.queryByText(/snapshot/i)).toBeNull()
  })

  it('says nothing was deleted when the schedule could not be saved first', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [])
    )
    localClient.deleteRecord.mockResolvedValue({ error: 'snapshot-failed' })
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText(/used in 75 places/)).not.toBeNull())
    fireEvent.click(screen.getByText('Delete and clear 75 places'))

    await waitFor(() => expect(screen.queryByText(/[Nn]othing was deleted/)).not.toBeNull())
    expect(screen.queryByText(/connection/i)).toBeNull()
    expect(screen.queryByText('Yeladim 1')).not.toBeNull()
  })

  it('re-asks with the new number when the count changed under the director', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [])
    )
    localClient.deleteRecord.mockResolvedValue({ error: 'count-changed', slot_count: 76 })
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText(/used in 75 places/)).not.toBeNull())
    fireEvent.click(screen.getByText('Delete and clear 75 places'))

    await waitFor(() => expect(screen.queryByText(/76 places/)).not.toBeNull())
  })

  it('shows an admin-specific message when the check is rejected for a non-admin', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [])
    )
    localClient.previewDelete.mockRejectedValue(new Error('admin role required'))
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() =>
      expect(screen.queryByText('Only an admin can delete groups.')).not.toBeNull()
    )
  })

  it('names the network only when the failure really was the network', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [])
    )
    localClient.previewDelete.mockRejectedValue(new Error('network error'))
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() =>
      expect(screen.queryByText(/Your devices could not reach each other/)).not.toBeNull()
    )
  })

  it('shows a styled confirm modal (not window.confirm) before Delete All, and confirming deletes', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group({ id: 'g1' })] : [])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    expect(window.confirm).not.toHaveBeenCalled()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Delete all groups?')).not.toBeNull())
    expect(screen.queryByText('They can be restored from Trash.')).not.toBeNull()

    fireEvent.click(screen.getByText('Delete All Groups'))
    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'groups', 'g1'))
  })

  it('cancels Delete All without deleting', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group({ id: 'g1' })] : [])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all groups?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete all groups?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('deleteAll surfaces a partial-failure count rather than silently succeeding or aborting', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group({ id: 'g1' }), group({ id: 'g2', name: 'Second' })] : [])
    )
    localClient.deleteEntity.mockImplementation((token, entity, id) => {
      if (id === 'g1') return Promise.resolve({ status: 'applied' })
      return Promise.reject(new Error('boom'))
    })
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all groups?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete All Groups'))

    await waitFor(() =>
      expect(screen.queryByText('Deleted 1 of 2 groups (1 failed — see console).')).not.toBeNull()
    )
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'groups', 'g1')
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'groups', 'g2')
  })

  it('deleteAll re-fetches groups immediately before deleting, catching rows synced in after page-load', async () => {
    // Initial load only sees g1 (stale render-time snapshot).
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group({ id: 'g1' })] : [])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    // Another device synced in g2 between page-load and the click — the
    // re-fetch inside deleteAll should pick it up even though the closed-
    // over `groups` state still only has g1.
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group({ id: 'g1' }), group({ id: 'g2', name: 'Second' })] : [])
    )
    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all groups?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete All Groups'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'groups', 'g2'))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'groups', 'g1')
  })

  it('addGroup compensating-deletes the partially-created row when a later field write fails', async () => {
    localClient.list.mockImplementation((entity) => Promise.resolve(entity === 'tiers' ? [tier()] : []))
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No groups yet')).not.toBeNull())

    localClient.write.mockImplementation((token, entity, id, field) => {
      if (field === 'name') return Promise.resolve({ status: 'applied' })
      return Promise.reject(new Error('disk failure'))
    })

    fireEvent.change(screen.getByPlaceholderText('Group name'), { target: { value: 'New Group' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() =>
      expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'groups', 'new-group-id')
    )
    await waitFor(() =>
      expect(
        screen.queryByText(/That group could not be added\./)
      ).not.toBeNull()
    )
  })

  it('addGroup writes name first and shows a name-collision message on a UNIQUE failure', async () => {
    localClient.list.mockImplementation((entity) => Promise.resolve(entity === 'tiers' ? [tier()] : []))
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No groups yet')).not.toBeNull())

    localClient.write.mockRejectedValue(new Error('UNIQUE constraint failed: groups.camp_id, groups.name'))

    fireEvent.change(screen.getByPlaceholderText('Group name'), { target: { value: 'Dup' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() =>
      expect(
        screen.queryByText('A group with this name already exists — choose a different name.')
      ).not.toBeNull()
    )
    // name must be the first field written, so the collision is caught
    // before any other field write and before ensureExists ever creates the row.
    expect(localClient.write.mock.calls[0]).toEqual(['token-abc', 'groups', 'new-group-id', 'name', 'Dup'])
  })

  it('deleteAll shows an admin-specific message when every delete fails due to role', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group({ id: 'g1' }), group({ id: 'g2', name: 'Second' })] : [])
    )
    localClient.deleteEntity.mockRejectedValue(new Error('admin role required'))
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all groups?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete All Groups'))

    await waitFor(() =>
      expect(
        screen.queryByText('Only an admin can delete groups — no groups were deleted.')
      ).not.toBeNull()
    )
  })

  it('surfaces an error banner when deleteAll fails unexpectedly instead of silently closing', async () => {
    localClient.list.mockImplementation(entity =>
      Promise.resolve(entity === 'groups' ? [group({ id: 'g1' })] : [])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    // Open the confirm modal, then make the re-fetch inside confirmDeleteAll
    // throw — an unexpected failure must surface an error banner, not close
    // the modal and look like a successful delete.
    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all groups?')).not.toBeNull())
    localClient.list.mockRejectedValue(new Error('disk failure'))
    fireEvent.click(screen.getByText('Delete All Groups'))

    await waitFor(() =>
      expect(screen.queryByText(/Those groups could not be deleted/)).not.toBeNull()
    )
  })
})

describe('GroupsScreen — import', () => {
  it('imports rows from Excel, resolving age division names and skipping duplicates and rows with a warning', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group({ id: 'g1', name: 'Yeladim 1' })] : [tier({ id: 'tier-1', name: 'Yeladim' })])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    const file = new File(['dummy'], 'groups.xlsx')
    const fileInput = document.querySelector('input[type="file"]')

    const rows = [
      { name: 'yeladim 1', tier_name: 'Yeladim', availability: 'all' }, // duplicate, case-insensitive
      { name: '', tier_name: '', availability: 'all' }, // missing name -> warning
      { name: 'Bogrim 1', tier_name: 'Yeladim', availability: 'morning' }, // new, valid
    ]
    XLSX.utils.sheet_to_json.mockReturnValue(rows)

    await userEvent.upload(fileInput, file)

    await waitFor(() => expect(screen.queryByText(/1 with warnings/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 2/))

    await waitFor(() => expect(screen.queryByText(/1 added/)).not.toBeNull())
    expect(screen.queryByText(/2 skipped/)).not.toBeNull()
    const namesWritten = localClient.write.mock.calls.filter(c => c[3] === 'name').map(c => c[4])
    expect(namesWritten).toEqual(['Bogrim 1'])
    const availWritten = localClient.write.mock.calls.filter(c => c[3] === 'availability').map(c => c[4])
    expect(availWritten).toEqual(['morning'])
  })

  it('flags an import row whose age division name does not match any existing age division', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [] : [tier({ id: 'tier-1', name: 'Yeladim' })])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No groups yet')).not.toBeNull())

    const file = new File(['dummy'], 'groups.xlsx')
    const fileInput = document.querySelector('input[type="file"]')

    XLSX.utils.sheet_to_json.mockReturnValue([
      { name: 'Ghost Group', tier_name: 'Nonexistent Age Division', availability: 'all' },
    ])

    await userEvent.upload(fileInput, file)

    await waitFor(() => expect(screen.queryByText('Age Division "Nonexistent Age Division" not found')).not.toBeNull())
  })
})

describe('GroupsScreen — row-click to edit', () => {
  it('has no visible Edit button', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [tier()])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())
    expect(screen.queryByText('Edit')).toBeNull()
  })

  it('Enter on a focused row enters edit mode', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [tier()])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    const row = screen.getByRole('button', { name: 'Edit Yeladim 1' })
    fireEvent.keyDown(row, { key: 'Enter' })

    expect(screen.getByDisplayValue('Yeladim 1')).not.toBeNull()
  })

  it('clicking Delete does not enter edit mode', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [tier()])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(localClient.previewDelete).toHaveBeenCalled())
    expect(screen.queryByDisplayValue('Yeladim 1')).toBeNull()
  })

  it('clicking History does not enter edit mode', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [tier()])
    )
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('History'))

    expect(screen.queryByDisplayValue('Yeladim 1')).toBeNull()
  })

  it('shows the no-age-divisions caution through the shared bronze --accent primitive, not hardcoded amber', async () => {
    localClient.list.mockImplementation(() => Promise.resolve([]))
    render(<GroupsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    const banner = await waitFor(() =>
      screen.getByText('No age divisions found. Set up age divisions first so you can assign groups to them.')
    )
    expect(banner.style.background).toMatch(/var\(--accent\)/)
    expect(banner.style.background).not.toMatch(/#FFF8E7/i)
  })

  it('toggling the WeekToggle does not enter edit mode', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [tier()])
    )
    render(
      <GroupsScreen
        campId={CAMP_ID}
        role="admin"
        onNavigate={() => {}}
        weekId="week-1"
        weeks={[{ id: 'week-1', name: 'Week 1' }]}
      />
    )
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByRole('switch'))

    expect(screen.queryByDisplayValue('Yeladim 1')).toBeNull()
  })
})
