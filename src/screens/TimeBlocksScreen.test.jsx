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

import TimeBlocksScreen from './TimeBlocksScreen'
import { localClient } from '../localClient'

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
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  localClient.list.mockReset().mockImplementation(entity => {
    if (entity === 'cohorts') return Promise.resolve([cohort()])
    if (entity === 'time_blocks') return Promise.resolve([block()])
    return Promise.resolve([])
  })
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
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
