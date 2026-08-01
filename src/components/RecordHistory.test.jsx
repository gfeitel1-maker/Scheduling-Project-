// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: { getEntityHistory: vi.fn(), list: vi.fn() },
}))

import RecordHistory from './RecordHistory'
import { localClient } from '../localClient'

// T18 / CONSTITUTION Art. V. A history line exists to explain a change, so a
// value it cannot put into words is worse than no line at all — a raw uuid
// mid-sentence reads as a bug, not as information.

function entry(over = {}) {
  return {
    op_id: 'op1',
    field: 'name',
    value: 'Aleph',
    previous_value: 'Alef',
    author_name: 'Ruth',
    device_name: 'Lakeside iPad',
    timestamp: '2026-07-29T14:14:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockResolvedValue([])
})

describe('RecordHistory value rendering', () => {
  it('names a referenced record when it still exists', async () => {
    localClient.getEntityHistory.mockResolvedValue([
      entry({ field: 'tier_id', value: 'tier-1', previous_value: null }),
    ])
    localClient.list.mockResolvedValue([{ id: 'tier-1', name: 'Seniors' }])

    render(<RecordHistory entity="groups" entityId="g1" onClose={() => {}} />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Seniors/), { timeout: 3000 })
  })

  it('never prints a raw uuid when the referenced record has been deleted', async () => {
    localClient.getEntityHistory.mockResolvedValue([
      entry({ field: 'tier_id', value: '3ac1f0de-1111-4222-8333-444455556666', previous_value: null }),
    ])
    localClient.list.mockResolvedValue([])

    render(<RecordHistory entity="groups" entityId="g1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/since been deleted/)).toBeTruthy())
    expect(screen.queryByText(/3ac1f0de/)).toBeNull()
  })

  it('says yes and no rather than true and false', async () => {
    localClient.getEntityHistory.mockResolvedValue([
      entry({ field: 'is_outdoor', value: true, previous_value: false }),
    ])

    render(<RecordHistory entity="activities" entityId="a1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/yes/)).toBeTruthy())
    expect(screen.queryByText(/true/)).toBeNull()
  })

  it('does not print a list of uuids when a group list changes', async () => {
    localClient.getEntityHistory.mockResolvedValue([
      entry({
        field: 'eligible_group_ids',
        value: ['aaaaaaaa-1111-4222-8333-444455556666', 'bbbbbbbb-1111-4222-8333-444455556666'],
        previous_value: null,
      }),
    ])
    localClient.list.mockResolvedValue([])

    render(<RecordHistory entity="activities" entityId="a1" onClose={() => {}} />)
    // A count is a poor answer, but a list of uuids is not an answer at all.
    await waitFor(() => expect(screen.getByText(/2 records/)).toBeTruthy())
    expect(screen.queryByText(/aaaaaaaa/)).toBeNull()
  })

  it('still says "nothing" for an empty value', async () => {
    localClient.getEntityHistory.mockResolvedValue([
      entry({ field: 'notes', value: '', previous_value: 'Bring sunscreen' }),
    ])

    render(<RecordHistory entity="activities" entityId="a1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/nothing/)).toBeTruthy())
  })
})
