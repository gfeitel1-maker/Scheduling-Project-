// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// T35 — the rule summary this test checks for is inferred from activityPages/
// seenCounts/dayCount, which real parsing would have to build a whole grid to
// exercise. Stubbing extractEntities/parseTextGrid keeps the test about
// "does the inferred rule render and drive the commit payload", not about the
// grid parser (which has its own tests).
vi.mock('../ingest/textGrid', () => ({ parseTextGrid: () => ({ pages: [{ title: 'x', columns: [], rows: [] }] }) }))
vi.mock('../ingest/extractEntities', async () => {
  const actual = await vi.importActual('../ingest/extractEntities')
  return {
    ...actual,
    extractEntities: () => ({
      orientation: { columns: 'days', pages: 'groups', confident: true },
      entities: {
        groups: ['Yeladim', 'Bogrim'],
        days_of_operation: ['Monday', 'Tuesday'],
        time_blocks: [],
        activities: ['Swim'],
        tiers: [],
        cohorts: [],
      },
      groupUnits: {},
      groupNameByTitle: {},
      activityPages: { swim: ['Yeladim'] },
      seenCounts: { activities: { Swim: 4 }, activityUnitShare: { swim: 0.9 } },
      counts: { groups: 2, days_of_operation: 2, activities: 1 },
    }),
  }
})
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: () => ({ fixedEvents: [] }) }))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    ingestCommit: vi.fn().mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } }),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'

beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockResolvedValue([])
  localClient.ingestCommit.mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } })
})

async function uploadFile() {
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
  await userEvent.upload(input, file)
  await waitFor(() => expect(screen.getAllByText(/Swim/).length).toBeGreaterThan(0))
}

describe('ImportScreen — inferred activity rules (T35)', () => {
  it('renders a rule summary for a proposed activity', async () => {
    await uploadFile()
    // Swim: 4 appearances / 1 matched group / 2 days = 2/wk; unitShare 0.9 -> High.
    expect(screen.getByText(/Groups: Yeladim/)).toBeTruthy()
    expect(screen.getByRole('option', { name: 'High', selected: true })).toBeTruthy()
  })

  it('sends resolved rules only for approved activities on commit', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText(/Add \d+ record/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    const [, , , , activityRules] = localClient.ingestCommit.mock.calls[0]
    expect(activityRules.Swim).toMatchObject({ min_per_week: 2, max_per_week: 3, priority: 'high' })
  })
})
