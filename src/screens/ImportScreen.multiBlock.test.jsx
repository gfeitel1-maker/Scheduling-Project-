// @vitest-environment jsdom
//
// Slice B (docs/adr/2026-08-24-merged-cell-multiblock-ingest.md, addendum).
// "Longer Blocks" candidates surface director-facing; nothing ships at
// commit until the director picks "Every week" (recurring, folded into
// fixedEvents with span_blocks) or "Just this once" (one-off, a
// multiBlockEvents catalog-only entry). Same "unticked = not written" rule
// this screen already uses for its other review sections.
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
        days_of_operation: ['Friday'],
        time_blocks: [],
        activities: [],
        tiers: [],
        cohorts: [],
      },
      groupUnits: {},
      groupNameByTitle: {},
      activityPages: {},
      seenCounts: { activities: {}, activityUnitShare: {} },
      counts: { groups: 1, days_of_operation: 1, activities: 0 },
    }),
  }
})
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: () => ({ fixedEvents: [], dualUseNames: [] }) }))
vi.mock('../ingest/multiBlockCandidates', () => ({
  inferMultiBlockCandidates: () => ({
    // Already aggregated shape (Governor round 2): one candidate carries the
    // UNION of days/groups a merge showed up on, not one row per raw
    // (group, day) detection.
    multiBlockCandidates: [
      {
        name: 'Ruach & Shabbat', start_block: '16:00', span_blocks: 3,
        days: ['Friday'], scope: { is_all_groups: true, groups: null },
      },
    ],
  }),
}))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))

const READY_ENTITIES = new Set(['tiers', 'groups', 'days_of_operation', 'time_blocks', 'activities'])
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn((entity) => Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : [])),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1', name: 'Camp' }),
    deleteEntity: vi.fn(),
    ingestCommit: vi.fn().mockResolvedValue({ total: 1, fixedEvents: { created: 0, skipped: [], partial: [] }, multiBlockEvents: { created: 0 } }),
    ingestReconcile: vi.fn().mockResolvedValue({ planItems: [], fixedEventsReport: {}, legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {} }),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'

beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockImplementation((entity) => Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : []))
  localClient.ingestCommit.mockResolvedValue({ total: 1, fixedEvents: { created: 0, skipped: [], partial: [] }, multiBlockEvents: { created: 0 } })
})

async function uploadFile() {
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
  await userEvent.upload(input, file)
  await waitFor(() => expect(screen.getByText('Longer Blocks')).toBeTruthy())
}

async function commit() {
  await userEvent.click(screen.getByText(/Add \d+ record/))
  await userEvent.click(await screen.findByText('Use this setup'))
  await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
  return localClient.ingestCommit.mock.calls[0][0]
}

describe('ImportScreen — Longer Blocks (Slice B)', () => {
  it('renders the candidate with its span and both decision buttons', async () => {
    await uploadFile()
    expect(screen.getByText('Ruach & Shabbat')).toBeTruthy()
    expect(screen.getByText(/3-block block/)).toBeTruthy()
    expect(screen.getByText('Every week')).toBeTruthy()
    expect(screen.getByText('Just this once')).toBeTruthy()
  })

  it('an undecided candidate ships in neither fixedEvents nor multiBlockEvents', async () => {
    await uploadFile()
    const inputs = await commit()
    expect(inputs.fixedEvents ?? []).toEqual([])
    expect(inputs.multiBlockEvents ?? []).toEqual([])
  })

  it('picking "Every week" routes the candidate into fixedEvents with span_blocks set, ONE anchor (all-groups), not one per group', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText('Every week'))
    const inputs = await commit()
    expect(inputs.fixedEvents).toEqual([
      {
        name: 'Ruach & Shabbat',
        time_block: '16:00',
        days: ['Friday'],
        scope: { is_all_groups: true, groups: null },
        confidence: 'high',
        span_blocks: 3,
      },
    ])
    expect(inputs.multiBlockEvents ?? []).toEqual([])
  })

  it('picking "Just this once" routes the candidate into multiBlockEvents, not fixedEvents', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText('Just this once'))
    const inputs = await commit()
    expect(inputs.fixedEvents ?? []).toEqual([])
    expect(inputs.multiBlockEvents).toHaveLength(1)
    expect(inputs.multiBlockEvents[0].name).toBe('Ruach & Shabbat')
    expect(inputs.multiBlockEvents[0].notes).toMatch(/Friday, 3 blocks starting 16:00/)
  })
})
