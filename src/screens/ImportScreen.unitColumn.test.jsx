// @vitest-environment jsdom
//
// ADR 2026-08-09 Decision 2 — the reviewable per-group unit column's three
// explicit states (unset / set / explicitly cleared) must route to the right
// place in buildCommitInputs()'s output: unset -> links.groups from the
// file's own inference only; set -> links.groups + humanEditedFields; cleared
// -> record.clears (via the `clears` input), NOT links.groups, + humanEditedFields.
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
        groups: ['Chagalls'],
        days_of_operation: ['Monday'],
        time_blocks: [],
        activities: [],
        tiers: ['Kfar A'],
        cohorts: [],
      },
      // The file itself infers no unit for Chagalls — this fixture is about
      // the director's OWN pick/clear, not the parser's inference.
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
// Fix round 2026-08-17 — ReconciliationScreen's "Use this setup" button
// (the new one-screen flow's commit trigger) is gated on readiness's 5
// required areas being 'ready' (getReadiness, src/engine/readiness.js), NOT
// just on this file's own decisions. An all-[] `list` mock left every
// required area at 'needs-attention', so the button stayed disabled forever
// and localClient.ingestCommit was never called — entity-aware so tiers/
// groups/days_of_operation/time_blocks/activities each report one existing
// row (readiness green) while every other table stays empty, same as before.
const READY_ENTITIES = new Set(['tiers', 'groups', 'days_of_operation', 'time_blocks', 'activities'])
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn((entity) => Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : [])),
    // useSetupCounts calls getCamp() in a mount effect on every ImportScreen
    // render, so the mock must implement it or every test throws in that effect.
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
  localClient.list.mockImplementation((entity) => Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : []))
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

describe('ImportScreen — reviewable unit column (ADR 2026-08-09 Decision 2)', () => {
  it('unset (default): no override reaches the commit, links.groups has no entry (file inferred none)', async () => {
    await uploadFile()
    const inputs = await commit()
    expect(inputs.links.groups.Chagalls).toBeUndefined()
    expect(inputs.clears.groups.Chagalls).toBeUndefined()
    expect(inputs.humanEditedFields.groups.Chagalls).toBeUndefined()
  })

  it('set: picking an existing tier routes to links.groups AND humanEditedFields', async () => {
    await uploadFile()
    const select = document.querySelector('select')
    await userEvent.selectOptions(select, 'Kfar A')
    const inputs = await commit()
    expect(inputs.links.groups.Chagalls).toBe('Kfar A')
    expect(inputs.clears.groups.Chagalls).toBeUndefined()
    expect(inputs.humanEditedFields.groups.Chagalls).toEqual(['unit'])
  })

  it('cleared: "No unit" routes to clears.groups (NOT links.groups) AND humanEditedFields', async () => {
    await uploadFile()
    const select = document.querySelector('select')
    await userEvent.selectOptions(select, '__clear__')
    const inputs = await commit()
    expect(inputs.links.groups.Chagalls).toBeUndefined()
    expect(inputs.clears.groups.Chagalls).toEqual(['unit'])
    expect(inputs.humanEditedFields.groups.Chagalls).toEqual(['unit'])
  })

  it('a typed "+ New unit…" name routes to links.groups, humanEditedFields, and approved.tiers', async () => {
    await uploadFile()
    const select = document.querySelector('select')
    await userEvent.selectOptions(select, '__new__')
    const textInput = document.querySelector('input[placeholder="Unit name"]')
    await userEvent.type(textInput, 'Brand New Unit')
    const inputs = await commit()
    expect(inputs.links.groups.Chagalls).toBe('Brand New Unit')
    expect(inputs.humanEditedFields.groups.Chagalls).toEqual(['unit'])
    expect(inputs.approved.tiers).toContain('Brand New Unit')
  })
})
