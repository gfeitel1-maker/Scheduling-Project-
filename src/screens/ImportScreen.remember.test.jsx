// @vitest-environment jsdom
//
// S1b — the "Remember this" checkbox on the held-import identity card
// (docs/adr/2026-08-09-s1b-host-local-aliases.md). Mirrors the T73 held-UI test
// pattern (ImportScreen.held.test.jsx): drive localClient.ingestCommit
// deterministically, then assert the exact confirmAlias calls the successful
// finish sends.

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
        groups: [],
        days_of_operation: ['Monday'],
        time_blocks: [],
        activities: ['Art', 'Swim'],
        tiers: [],
        cohorts: [],
      },
      groupUnits: {},
      groupNameByTitle: {},
      activityPages: {},
      seenCounts: { activities: { Art: 5, Swim: 4 } },
      counts: { days_of_operation: 1, activities: 2 },
    }),
  }
})
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: () => ({ fixedEvents: [] }) }))
vi.mock('../ingest/activityRules', () => ({ inferActivityRules: () => new Map() }))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    // useSetupCounts calls getCamp() in a mount effect on every ImportScreen
    // render, so the mock must implement it or every test throws in that effect.
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1', name: 'Camp' }),
    ingestCommit: vi.fn(),
    confirmAlias: vi.fn().mockResolvedValue({ id: 'alias-1', superseded: null }),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'

// Two candidates → the "which one" chooser, so a "Use “X”" pick is the 'same'
// choice the checkbox gates on (matches ImportScreen.held.test.jsx's fixture).
const ambiguousArt = {
  op: 'conflict', entity: 'activities', entity_id: null, reason: 'ambiguous_identity',
  fields: {}, _name: 'Art',
  evidence: { tier: 'exact_name', candidates: [{ id: 'art-1', name: 'Art' }, { id: 'art-2', name: 'art ' }] },
}
// A candidate that does NOT share the raw incoming name, so "add as new" is offered.
const ambiguousArtNoDup = {
  ...ambiguousArt,
  evidence: { tier: 'exact_name', candidates: [{ id: 'art-1', name: 'art ' }, { id: 'art-2', name: 'ART' }] },
}
// A second, independent ambiguous identity so a queue of two identity items
// exists: after answering one, HeldResolution auto-advances to the OTHER
// (still-unanswered) item rather than straight to the Finish card, leaving the
// first item's rail row clickable to refocus it (mirrors how
// ImportScreen.held.test.jsx refocuses a StaleCard via its rail row).
const ambiguousSwim = {
  op: 'conflict', entity: 'activities', entity_id: null, reason: 'ambiguous_identity',
  fields: {}, _name: 'Swim',
  evidence: { tier: 'exact_name', candidates: [{ id: 'swim-1', name: 'Swim' }, { id: 'swim-2', name: 'swim ' }] },
}
const staleMonday = {
  op: 'conflict', entity: 'days_of_operation', entity_id: 'd-mon', reason: 'stale', _name: 'Monday',
  fields: { sort_order: { from: 3, to: 1, source: 'import', conflict: { reason: 'stale' } } },
  evidence: { tier: 'exact_name', matched_name: 'Monday' },
}
const heldOutcome = (conflicts) => ({ held: true, conflicts, created: {}, total: 0, updated: 0, fixedEvents: { created: 0, skipped: [], partial: [] } })
const successOutcome = { held: false, conflicts: [], created: {}, total: 1, updated: 0, fixedEvents: { created: 0, skipped: [], partial: [] } }

beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockResolvedValue([])
  localClient.confirmAlias.mockResolvedValue({ id: 'alias-1', superseded: null })
})

async function uploadAndHold(conflicts) {
  localClient.ingestCommit.mockResolvedValueOnce(heldOutcome(conflicts))
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
  await userEvent.upload(input, file)
  await waitFor(() => expect(screen.getAllByText(/Art/).length).toBeGreaterThan(0))
  await userEvent.click(screen.getByText(/Add \d+ record/))
  await userEvent.click(await screen.findByText(/Commit \d+ record/))
  await waitFor(() => expect(screen.getByText(/Almost there/)).toBeTruthy())
  await userEvent.click(screen.getByText(/Review the \d+ item/))
}

describe('S1b — Remember-this checkbox on the identity card', () => {
  it('appears, default checked, only after a "same"/existing choice is made', async () => {
    await uploadAndHold([ambiguousArt, ambiguousSwim])
    // Before any choice, no checkbox.
    expect(screen.queryByRole('checkbox')).toBeNull()
    await userEvent.click(screen.getByText(/Use “Art”/))
    // Answering Art auto-advances to the still-unanswered Swim item; refocus
    // Art via its rail row to see the checkbox its own answer now carries.
    await userEvent.click(screen.getByRole('button', { name: /Is “Art” the same as before\?/ }))
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox.checked).toBe(true)
  })

  it('does not appear for the "create new" choice', async () => {
    await uploadAndHold([ambiguousArtNoDup, ambiguousSwim])
    await userEvent.click(screen.getByText(/add “Art” as new/))
    await userEvent.click(screen.getByRole('button', { name: /Is “Art” the same as before\?/ }))
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('unchecking it excludes that mapping from confirmAlias on a successful finish', async () => {
    await uploadAndHold([ambiguousArt, ambiguousSwim])
    await userEvent.click(screen.getByText(/Use “Art”/))
    await userEvent.click(screen.getByRole('button', { name: /Is “Art” the same as before\?/ }))
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByText(/Use “Swim”/))
    localClient.ingestCommit.mockResolvedValueOnce(successOutcome)
    await userEvent.click(screen.getByText(/Finish import/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(2))
    // Swim (left checked) is remembered; Art (unchecked) is not.
    await waitFor(() => expect(localClient.confirmAlias).toHaveBeenCalledTimes(1))
    expect(localClient.confirmAlias).toHaveBeenCalledWith({
      entity_type: 'activities', cohort_id: null, source_label: 'Swim', entity_id: 'swim-1',
    })
  })

  it('left checked (default), calls confirmAlias with the mapped args after a successful finish', async () => {
    await uploadAndHold([ambiguousArt])
    await userEvent.click(screen.getByText(/Use “Art”/))
    localClient.ingestCommit.mockResolvedValueOnce(successOutcome)
    await userEvent.click(screen.getByText(/Finish import/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(localClient.confirmAlias).toHaveBeenCalledTimes(1))
    expect(localClient.confirmAlias).toHaveBeenCalledWith({
      entity_type: 'activities',
      cohort_id: null, // activities is not cohort-scoped
      source_label: 'Art',
      entity_id: 'art-1',
    })
  })

  it('does NOT call confirmAlias when the re-commit comes back held again (peer race)', async () => {
    await uploadAndHold([ambiguousArt])
    await userEvent.click(screen.getByText(/Use “Art”/))
    localClient.ingestCommit.mockResolvedValueOnce(heldOutcome([staleMonday]))
    await userEvent.click(screen.getByText(/Finish import/))
    await waitFor(() => expect(screen.getByText(/One more came up while you were working/)).toBeTruthy())
    expect(localClient.confirmAlias).not.toHaveBeenCalled()
  })

  it('a confirmAlias rejection does not fail the finish (best-effort)', async () => {
    await uploadAndHold([ambiguousArt])
    await userEvent.click(screen.getByText(/Use “Art”/))
    localClient.confirmAlias.mockRejectedValueOnce(new Error('confirmAlias: target_locked'))
    localClient.ingestCommit.mockResolvedValueOnce(successOutcome)
    await userEvent.click(screen.getByText(/Finish import/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalledTimes(2))
    // The import result still lands — the finish surface tears down to the
    // normal success banner, not the error banner.
    await waitFor(() => expect(screen.getByText(/Imported 1 record/)).toBeTruthy())
    expect(screen.queryByText(/Nothing was imported\. Your camp is exactly as it was/)).toBeNull()
  })
})
