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
    // T61 — present so the "the renderer deletes nothing" test can assert it
    // was never reached, not because this screen may call it.
    deleteEntity: vi.fn(),
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
    const [{ activityRules }] = localClient.ingestCommit.mock.calls[0]
    expect(activityRules.Swim).toMatchObject({ min_per_week: 2, max_per_week: 3, priority: 'high' })
  })

  // T61 — the Replace teardown moved into the main process. The renderer must
  // no longer delete anything itself; it says which mode and awaits once.
  it('commits in add mode without deleting a single row itself', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText(/Add \d+ record/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    expect(localClient.ingestCommit.mock.calls[0][0].mode).toBe('add')
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('tells the director to use the main computer when the handler refuses on a Client', async () => {
    // The refusal names the one thing they can do about it; the generic
    // "not something the app recognised" fallback would bury that.
    localClient.ingestCommit.mockRejectedValue(new Error('Import can only be run on the main computer.'))
    await uploadFile()
    await userEvent.click(screen.getByText(/Add \d+ record/))
    await waitFor(() => expect(screen.getByText(/main computer/)).toBeTruthy())
    expect(screen.getByText(/Nothing was imported/)).toBeTruthy()
  })

  // Round 2 (Red Hat HIGH) — replaceScope (electron/ops/ingest.js) tears down
  // WHERE camp_id = ? with no cohort filter, but the confirmation used to be
  // computed from a Program-filtered set (T33 duplicate detection). On a
  // multi-Program camp the director confirmed a small Program-scoped number
  // while every Program's setup was destroyed underneath it. The confirmation
  // must show the camp-wide count that Replace actually deletes.
  it('shows the camp-wide existing count, not the active-Program count, in the Replace confirmation', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') {
        // 1 in the active Program (cohort-1), 2 total across the camp.
        return Promise.resolve([
          { id: 't1', cohort_id: 'cohort-1' },
          { id: 't2', cohort_id: 'cohort-2' },
          { id: 't3', cohort_id: 'cohort-2' },
        ])
      }
      if (entity === 'time_blocks') {
        // 0 in the active Program, 2 total across the camp.
        return Promise.resolve([
          { id: 'b1', cohort_id: 'cohort-2' },
          { id: 'b2', cohort_id: 'cohort-2' },
        ])
      }
      return Promise.resolve([])
    })
    await uploadFile()
    // Program-scoped total would be 1 (one tier, no time blocks); camp-wide
    // total is 5. The confirmation must say 5, never 1.
    expect(screen.getByText(/Your camp already has/).textContent).toContain('5')
    expect(screen.queryByText(/Your camp already has\s*1\s/)).toBeNull()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.getByText(/across the entire camp — every Program/).textContent).toContain('5')
  })

  // Round 2 (second reviewer) — the commit button label was still gated on
  // the Program-scoped count, so a multi-Program camp whose active Program
  // holds zero REPLACEABLE rows saw the Replace confirmation panel (driven by
  // the camp-wide count) but a button that still read "Add N records", even
  // though clicking it sends mode: 'replace' and tears down every Program.
  it('reads Replace, not Add, when the active Program has no rows but the camp does', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') {
        // 0 in the active Program (cohort-1), 2 total across the camp.
        return Promise.resolve([
          { id: 't1', cohort_id: 'cohort-2' },
          { id: 't2', cohort_id: 'cohort-2' },
        ])
      }
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.getByText(/Replace with/)).toBeTruthy()
    expect(screen.queryByText(/Add \d+ record/)).toBeNull()
  })

  // T61 round 3 (Red Hat) — replaceScope wipes template_slots/overlays for
  // BOTH schedule routes, camp-wide, but the director previously learned the
  // count only from the after-the-fact success banner. It must appear in the
  // pre-confirm warning, naming both routes by their real nav labels.
  it('warns about cleared slots on both routes when the camp has placed slots', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      if (entity === 'template_slots') return Promise.resolve([{ id: 's1' }, { id: 's2' }, { id: 's3' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.getByText(/Manual Build/)).toBeTruthy()
    expect(screen.getByText(/Generated Schedule/)).toBeTruthy()
    expect(screen.getByText(/3 slots/)).toBeTruthy()
  })

  it('does not warn about slots when the camp has none placed', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.queryByText(/Manual Build/)).toBeNull()
    expect(screen.queryByText(/Generated Schedule/)).toBeNull()
  })

  it('names all five entities Replace destroys', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    const replaceSentence = screen.getByText(/This will replace all/)
    for (const name of ['Units', 'Groups', 'Days', 'Time Blocks', 'Activities']) {
      expect(replaceSentence.textContent).toContain(name)
    }
  })
})
