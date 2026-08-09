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

import TiersScreen from './TiersScreen'
import { localClient } from '../localClient'

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
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  localClient.list.mockReset().mockImplementation(entity => {
    if (entity === 'cohorts') return Promise.resolve([cohort()])
    if (entity === 'tiers') return Promise.resolve([tier()])
    if (entity === 'groups') return Promise.resolve([])
    return Promise.resolve([])
  })
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
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
})
