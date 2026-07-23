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

import GroupsScreen from './GroupsScreen'
import { localClient } from '../localClient'

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
})

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
    render(<GroupsScreen campId={CAMP_ID} onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())
    expect(screen.queryByText('Other camp group')).toBeNull()
    expect(localClient.list).toHaveBeenCalledWith('groups')
    expect(localClient.list).toHaveBeenCalledWith('tiers')
  })

  it('adding a group writes each field via localClient.write with the token and reloads', async () => {
    localClient.list.mockImplementation((entity) => Promise.resolve(entity === 'tiers' ? [tier()] : []))
    render(<GroupsScreen campId={CAMP_ID} onNavigate={() => {}} />)
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
    render(<GroupsScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    const nameInput = screen.getByDisplayValue('Yeladim 1')
    fireEvent.change(nameInput, { target: { value: 'Renamed' } })

    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group({ name: 'Renamed' })] : [tier()])
    )
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(screen.queryByText('Renamed')).not.toBeNull())
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'groups', 'group-1', 'name', 'Renamed')
  })

  it('deleting a group calls localClient.deleteEntity and reloads', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [])
    )
    render(<GroupsScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    localClient.list.mockImplementation(() => Promise.resolve([]))
    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'groups', 'group-1'))
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).toBeNull())
  })

  it('shows an admin-specific message when deleting a group fails due to role', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [])
    )
    localClient.deleteEntity.mockRejectedValue(new Error('admin role required'))
    render(<GroupsScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() =>
      expect(screen.queryByText('Only an admin can delete groups.')).not.toBeNull()
    )
  })

  it('shows the generic connectivity message for a non-role delete failure', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group()] : [])
    )
    localClient.deleteEntity.mockRejectedValue(new Error('network error'))
    render(<GroupsScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() =>
      expect(
        screen.queryByText('Failed to delete group — check your connection and try again')
      ).not.toBeNull()
    )
  })

  it('deleteAll surfaces a partial-failure count rather than silently succeeding or aborting', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group({ id: 'g1' }), group({ id: 'g2', name: 'Second' })] : [])
    )
    localClient.deleteEntity.mockImplementation((token, entity, id) => {
      if (id === 'g1') return Promise.resolve({ status: 'applied' })
      return Promise.reject(new Error('boom'))
    })
    render(<GroupsScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

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
    render(<GroupsScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    // Another device synced in g2 between page-load and the click — the
    // re-fetch inside deleteAll should pick it up even though the closed-
    // over `groups` state still only has g1.
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [group({ id: 'g1' }), group({ id: 'g2', name: 'Second' })] : [])
    )
    fireEvent.click(screen.getByText('Delete All'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'groups', 'g2'))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'groups', 'g1')
  })

  it('addGroup compensating-deletes the partially-created row when a later field write fails', async () => {
    localClient.list.mockImplementation((entity) => Promise.resolve(entity === 'tiers' ? [tier()] : []))
    render(<GroupsScreen campId={CAMP_ID} onNavigate={() => {}} />)
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
        screen.queryByText('Failed to add group — check your connection and try again')
      ).not.toBeNull()
    )
  })

  it('addGroup writes name first and shows a name-collision message on a UNIQUE failure', async () => {
    localClient.list.mockImplementation((entity) => Promise.resolve(entity === 'tiers' ? [tier()] : []))
    render(<GroupsScreen campId={CAMP_ID} onNavigate={() => {}} />)
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
    render(<GroupsScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Yeladim 1')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    await waitFor(() =>
      expect(
        screen.queryByText('Only an admin can delete groups — no groups were deleted.')
      ).not.toBeNull()
    )
  })
})
