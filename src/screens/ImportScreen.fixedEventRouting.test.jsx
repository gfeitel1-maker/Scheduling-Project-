// @vitest-environment jsdom
//
// ADR 2026-08-09 Decision 1 — a fixed-event name pinned to a period must not
// also silently create a free-choice catalog activity, unless it's genuinely
// dual-use — in which case it's a reviewable exception, not a silent drop.
// dualUseNames from inferFixedEvents is a SEED for this screen's tick-seeding
// only; buildPlan never sees it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../ingest/textGrid', () => ({ parseTextGrid: () => ({ pages: [{ title: 'x', columns: [], rows: [] }] }) }))
vi.mock('../ingest/extractEntities', async () => {
  const actual = await vi.importActual('../ingest/extractEntities')
  return {
    ...actual,
    extractEntities: () => ({
      orientation: { columns: 'days', pages: 'groups', confident: true },
      entities: {
        groups: ['Yeladim'],
        days_of_operation: ['Monday', 'Tuesday'],
        time_blocks: [],
        // 'Lunch' is pin-only (fixed only); 'Ceramics' is dual-use (also a
        // free-choice elective elsewhere).
        activities: ['Lunch', 'Ceramics'],
        tiers: [],
        cohorts: [],
      },
      groupUnits: {},
      groupNameByTitle: {},
      activityPages: { lunch: ['Yeladim'], ceramics: ['Yeladim'] },
      seenCounts: { activities: { Lunch: 4, Ceramics: 4 }, activityUnitShare: { lunch: 0.9, ceramics: 0.9 } },
      counts: { groups: 1, days_of_operation: 2, activities: 2 },
    }),
  }
})
vi.mock('../ingest/fixedEvents', () => ({
  inferFixedEvents: () => ({
    fixedEvents: [
      { name: 'Lunch', time_block: '12:00-12:30', days: ['Monday', 'Tuesday'], scope: { is_all_groups: true, groups: null }, confidence: 'high' },
      { name: 'Ceramics', time_block: '10:00-10:30', days: ['Monday', 'Tuesday'], scope: { is_all_groups: true, groups: null }, confidence: 'high' },
    ],
    dualUseNames: ['Ceramics'],
  }),
}))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    // useSetupCounts calls getCamp() in a mount effect on every ImportScreen
    // render, so the mock must implement it or every test throws in that effect.
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1', name: 'Camp' }),
    deleteEntity: vi.fn(),
    ingestCommit: vi.fn().mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } }),
    ingestReconcile: vi.fn().mockResolvedValue({ planItems: [], fixedEventsReport: {}, legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {} }),
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
  await waitFor(() => expect(screen.getAllByText(/Ceramics/).length).toBeGreaterThan(0))
}

describe('ImportScreen — fixed-event routing default (ADR 2026-08-09 Decision 1)', () => {
  it('defaults a pin-only name unticked with the fixed-event note', async () => {
    await uploadFile()
    const lunchButton = screen.getByText('Lunch').closest('button')
    expect(lunchButton.textContent).not.toContain('✓')
    expect(screen.getByText(/Scheduled as a fixed event — not added to the activity catalog\./)).toBeTruthy()
  })

  it('defaults a dual-use name ticked with the dual-use note', async () => {
    await uploadFile()
    const ceramicsButton = screen.getAllByText(/Ceramics/)
      .map((el) => el.closest('button'))
      .find((btn) => btn)
    expect(ceramicsButton.textContent).toContain('✓')
    expect(screen.getByText(/Also appears as a fixed event\./)).toBeTruthy()
  })

  it('ticking the pin-only row overrides the default and includes it in the commit', async () => {
    await uploadFile()
    const lunchButton = screen.getByText('Lunch').closest('button')
    await userEvent.click(lunchButton)
    expect(lunchButton.textContent).toContain('✓')

    await userEvent.click(screen.getByText(/Add \d+ record/))
    await userEvent.click(await screen.findByText('Use this setup'))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    const [{ approved }] = localClient.ingestCommit.mock.calls[0]
    expect(approved.activities).toContain('Lunch')
  })

  it('leaving the pin-only row unticked excludes it from the commit', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText(/Add \d+ record/))
    await userEvent.click(await screen.findByText('Use this setup'))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    const [{ approved }] = localClient.ingestCommit.mock.calls[0]
    expect(approved.activities).not.toContain('Lunch')
    expect(approved.activities).toContain('Ceramics')
  })
})
