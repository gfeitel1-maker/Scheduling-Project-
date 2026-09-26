// @vitest-environment jsdom
//
// T257 — the import tier dropdown could not reach the SECOND of two
// same-named age divisions: `tierNames` discarded ids before deduping into a
// `Set`, so two existing tiers sharing a name collapsed into one <option>.
// This is the non-vacuity test for the actual dropdown-collapse defect
// (finding 1 of the ticket's test list): plant two same-named tiers with
// different ids, and confirm BOTH render as distinct, independently
// selectable options that resolve to their own ids at commit.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../ingest/textGrid', () => ({ parseTextGrid: () => ({ pages: [{ title: 'x', columns: [], rows: [{ label: '9:00', cells: [] }] }] }) }))
vi.mock('../ingest/extractEntities', async () => {
  const actual = await vi.importActual('../ingest/extractEntities')
  return {
    ...actual,
    extractEntities: () => ({
      orientation: { columns: 'days', pages: 'groups', confident: true },
      entities: {
        groups: ['Chagalls'],
        days_of_operation: ['Monday'],
        time_blocks: [],
        activities: [],
        tiers: [], // no proposed tiers in this fixture — both options are EXISTING
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
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))

const READY_ENTITIES = new Set(['tiers', 'groups', 'days_of_operation', 'time_blocks', 'activities'])
// Two same-named tiers, different ids — the exact collision the ticket names.
const TIER_LOW = { id: 'tier-aaa-low', name: 'Bunk B', cohort_id: 'cohort-1' }
const TIER_HIGH = { id: 'tier-zzz-high', name: 'Bunk B', cohort_id: 'cohort-1' }
const EXISTING_GROUPS = [
  { id: 'g-existing-1', name: 'Existing Group On Low', tier_id: TIER_LOW.id },
]

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn((entity) => {
      if (entity === 'tiers') return Promise.resolve([TIER_LOW, TIER_HIGH])
      if (entity === 'groups') return Promise.resolve(EXISTING_GROUPS)
      return Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : [])
    }),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1', name: 'Camp' }),
    deleteEntity: vi.fn(),
    ingestCommit: vi.fn().mockResolvedValue({ total: 1, fixedEvents: { created: 0, skipped: [], partial: [] } }),
    ingestReconcile: vi.fn().mockResolvedValue({ planItems: [], fixedEventsReport: {}, legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {} }),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'

beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockImplementation((entity) => {
    if (entity === 'tiers') return Promise.resolve([TIER_LOW, TIER_HIGH])
    if (entity === 'groups') return Promise.resolve(EXISTING_GROUPS)
    return Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : [])
  })
  localClient.ingestCommit.mockResolvedValue({ total: 1, fixedEvents: { created: 0, skipped: [], partial: [] } })
})

async function uploadFile() {
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
  await userEvent.upload(input, file)
  await waitFor(() => expect(document.querySelector('select')).toBeTruthy())
}

async function commit() {
  await userEvent.click(screen.getByText(/Add \d+ record/))
  await userEvent.click(await screen.findByText('Use this setup'))
  await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
  return localClient.ingestCommit.mock.calls[0][0]
}

describe('ImportScreen tier dropdown reaches the SECOND same-named division (T257)', () => {
  it('renders both same-named tiers as distinct options, disambiguated by group count', async () => {
    await uploadFile()
    const select = document.querySelector('select')
    const optionTexts = [...select.querySelectorAll('option')].map((o) => o.textContent)
    // TIER_LOW has 1 group on it (EXISTING_GROUPS), TIER_HIGH has 0 — the
    // disambiguation label must make the two distinguishable in the UI, not
    // just at the data layer.
    expect(optionTexts).toContain('Bunk B — 1 group')
    expect(optionTexts).toContain('Bunk B — 0 groups')
  })

  it('picking the HIGH-id option resolves to that id, not the low one, at commit', async () => {
    await uploadFile()
    const select = document.querySelector('select')
    await userEvent.selectOptions(select, TIER_HIGH.id)
    const inputs = await commit()
    expect(inputs.links.groups.Chagalls).toEqual({ kind: 'existing', id: TIER_HIGH.id, name: 'Bunk B' })
  })

  it('picking the LOW-id option resolves to that id (the other half of the pair stays reachable too)', async () => {
    await uploadFile()
    const select = document.querySelector('select')
    await userEvent.selectOptions(select, TIER_LOW.id)
    const inputs = await commit()
    expect(inputs.links.groups.Chagalls).toEqual({ kind: 'existing', id: TIER_LOW.id, name: 'Bunk B' })
  })
})
