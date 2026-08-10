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
