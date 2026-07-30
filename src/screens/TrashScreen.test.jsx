// @vitest-environment jsdom
//
// The director's side of docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md:
// deleted records are readable by name, a restore that is waiting says so
// rather than looking failed, and children are offered explicitly.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    listDeleted: vi.fn(),
    listPendingRestores: vi.fn(),
    restoreEntity: vi.fn(),
    getEntityHistory: vi.fn(),
    list: vi.fn(),
  },
}))

import TrashScreen from './TrashScreen'
import { localClient } from '../localClient'

function deletedGroup(overrides = {}) {
  return {
    entity: 'groups',
    entity_id: 'g1',
    name: 'Aleph',
    deleted_at: '2026-07-29T14:14:00.000Z',
    deleted_by_user_id: 'u1',
    deleted_by_name: 'Ruth',
    deleted_on_device_name: 'Lakeside iPad',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  localClient.listDeleted.mockResolvedValue([])
  localClient.listPendingRestores.mockResolvedValue([])
  localClient.list.mockResolvedValue([])
  localClient.getEntityHistory.mockResolvedValue([])
})

describe('TrashScreen', () => {
  it('says nothing is deleted, and what the screen is for, when it is empty', async () => {
    render(<TrashScreen role="admin" />)
    expect(await screen.findByText('Nothing deleted')).toBeTruthy()
    expect(screen.getByText('Deleted records appear here and can be restored.')).toBeTruthy()
  })

  it('shows the record by name, in plain words, never by uuid or table name', async () => {
    localClient.listDeleted.mockResolvedValue([deletedGroup()])
    render(<TrashScreen role="admin" />)

    expect(await screen.findByText('Aleph')).toBeTruthy()
    expect(screen.getByText('Group')).toBeTruthy()
    expect(screen.queryByText('groups')).toBeNull()
    expect(screen.queryByText('g1')).toBeNull()
    expect(screen.getByText(/Ruth/)).toBeTruthy()
  })

  it('offers Restore to an admin and withholds it from staff, saying why', async () => {
    localClient.listDeleted.mockResolvedValue([deletedGroup()])
    const { unmount } = render(<TrashScreen role="admin" />)
    expect(await screen.findByText('Restore')).toBeTruthy()
    unmount()

    render(<TrashScreen role="staff" />)
    expect(await screen.findByText('Only an admin can restore records.')).toBeTruthy()
    expect(screen.queryByText('Restore')).toBeNull()
  })

  it('reports a queued restore as waiting, not as a failure', async () => {
    localClient.listDeleted.mockResolvedValue([deletedGroup()])
    localClient.restoreEntity.mockResolvedValue({ queued: true })
    render(<TrashScreen role="admin" />)

    fireEvent.click(await screen.findByText('Restore'))

    expect(await screen.findByText(/Waiting for the main computer/)).toBeTruthy()
  })

  it('offers deleted children as a second, explicit action and does not act on its own', async () => {
    localClient.listDeleted.mockResolvedValue([
      deletedGroup({ entity: 'tiers', entity_id: 't1', name: 'Unit B' }),
    ])
    localClient.restoreEntity.mockResolvedValue({
      ok: true,
      restored_fields: 3,
      deleted_children: [{ entity: 'groups', entity_id: 'g1', name: 'Aleph' }],
    })
    render(<TrashScreen role="admin" />)

    fireEvent.click(await screen.findByText('Restore'))

    expect(await screen.findByText(/deleted with/)).toBeTruthy()
    expect(screen.getByText('Bring those back too')).toBeTruthy()
    // One call so far: the parent only. Nothing cascaded.
    expect(localClient.restoreEntity).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Bring those back too'))
    await waitFor(() => expect(localClient.restoreEntity).toHaveBeenCalledTimes(2))
    expect(localClient.restoreEntity).toHaveBeenLastCalledWith('groups', 'g1')
  })

  it('explains a refusal in the director\'s words, with no enum key on screen', async () => {
    localClient.listDeleted.mockResolvedValue([deletedGroup()])
    localClient.restoreEntity.mockResolvedValue({ error: 'no-history' })
    render(<TrashScreen role="admin" />)

    fireEvent.click(await screen.findByText('Restore'))

    expect(await screen.findByText(/does not hold enough of this record’s history/)).toBeTruthy()
    expect(screen.queryByText('no-history')).toBeNull()
  })

  it('shows a restore still waiting on the main computer, and one that has failed', async () => {
    localClient.listPendingRestores.mockResolvedValue([
      { pendingId: 'p1', entity: 'groups', entity_id: 'g1', last_error: null },
      { pendingId: 'p2', entity: 'tiers', entity_id: 't1', last_error: 'not-restorable' },
    ])
    render(<TrashScreen role="admin" />)

    expect(await screen.findByText(/Will be restored as soon as this device reaches/)).toBeTruthy()
    expect(screen.getByText('This kind of record is not restorable here.')).toBeTruthy()
  })

  it('opens the record\'s history without needing it to be restored first', async () => {
    localClient.listDeleted.mockResolvedValue([deletedGroup()])
    localClient.getEntityHistory.mockResolvedValue([
      {
        seq: 2, field: 'name', value: 'Aleph', previous_value: 'Alef',
        timestamp: '2026-07-29T14:00:00.000Z', author_name: 'Ruth', device_name: 'Lakeside iPad',
      },
    ])
    render(<TrashScreen role="admin" />)

    fireEvent.click(await screen.findByText('History'))

    expect(await screen.findByText(/Ruth changed name from Alef to Aleph/)).toBeTruthy()
  })
})
