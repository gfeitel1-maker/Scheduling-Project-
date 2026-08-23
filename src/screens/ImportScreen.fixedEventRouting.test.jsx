// @vitest-environment jsdom
//
// ADR 2026-08-09 Decision 1 — a fixed-event name pinned to a period must not
// also silently create a free-choice catalog activity, unless it's genuinely
// dual-use — in which case it needs a director's confirmation, not a silent
// drop. dualUseNames from inferFixedEvents is a SEED for pinOnlyActivityNames
// only; buildPlan never sees dualUseNames itself.
//
// Fix round 2026-08-17 — REWRITTEN, not obsolete-deleted: ADR
// 2026-08-17-onescreen-reconciliation-merge.md §2 removed ImportScreen's
// per-activity tick UI entirely ("Nothing is ticked here anymore" —
// ImportScreen.jsx ~404). Every proposed name, pin-only or not, now ships
// unconditionally in `approved.activities` — the old assertions on a
// clickable "Lunch"/"Ceramics" button with a ✓ and inline dual-use/pin-only
// copy test UI that no longer exists. What still must hold, and is the real
// guarantee this file protects, is `pinOnlyActivityNames`: a pin-only
// fixed-event name is still marked so buildPlan can force its create tier to
// 'low' (never a silent mint) while a genuinely dual-use name is not.
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
        // 'Lunch' is pin-only high-confidence (fixed only); 'Ceramics' is
        // dual-use (also a free-choice elective elsewhere); 'Free Swim' is
        // pin-only LOW-confidence (fixed only, but a thinner Asserted
        // hypothesis — ADR §4.1: still Asserted, not a demotion to Obligation).
        activities: ['Lunch', 'Ceramics', 'Free Swim'],
        tiers: [],
        cohorts: [],
      },
      groupUnits: {},
      groupNameByTitle: {},
      activityPages: { lunch: ['Yeladim'], ceramics: ['Yeladim'], 'free swim': ['Yeladim'] },
      seenCounts: {
        activities: { Lunch: 4, Ceramics: 4, 'Free Swim': 4 },
        activityUnitShare: { lunch: 0.9, ceramics: 0.9, 'free swim': 0.9 },
      },
      counts: { groups: 1, days_of_operation: 2, activities: 3 },
    }),
  }
})
vi.mock('../ingest/fixedEvents', () => ({
  inferFixedEvents: () => ({
    fixedEvents: [
      { name: 'Lunch', time_block: '12:00-12:30', days: ['Monday', 'Tuesday'], scope: { is_all_groups: true, groups: null }, confidence: 'high' },
      { name: 'Ceramics', time_block: '10:00-10:30', days: ['Monday', 'Tuesday'], scope: { is_all_groups: true, groups: null }, confidence: 'high' },
      { name: 'Free Swim', time_block: '15:00-15:30', days: ['Monday', 'Tuesday'], scope: { is_all_groups: true, groups: null }, confidence: 'low' },
    ],
    dualUseNames: ['Ceramics'],
  }),
}))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))

// Readiness (getReadiness, real function) gates ReconciliationScreen's "Use
// this setup" button on the 5 required areas being 'ready' — entity-aware so
// tiers/groups/days_of_operation/time_blocks/activities each report one
// existing row, same as ImportScreen.unitColumn.test.jsx's fix.
const READY_ENTITIES = new Set(['tiers', 'groups', 'days_of_operation', 'time_blocks', 'activities'])
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn((entity) => Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : [])),
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
  localClient.list.mockImplementation((entity) => Promise.resolve(READY_ENTITIES.has(entity) ? [{ id: `${entity}-1` }] : []))
  localClient.ingestCommit.mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } })
})

async function uploadFile() {
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
  await userEvent.upload(input, file)
  await waitFor(() => expect(screen.getAllByText(/Ceramics/).length).toBeGreaterThan(0))
}

async function commit() {
  await userEvent.click(screen.getByText(/Add \d+ record/))
  await userEvent.click(await screen.findByText('Use this setup'))
  await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
  return localClient.ingestCommit.mock.calls[0][0]
}

describe('ImportScreen — fixed-event routing (ADR 2026-08-09 Decision 1)', () => {
  it('shows both fixed events as chips, and both proposed activity names, unconditionally (no tick UI)', async () => {
    await uploadFile()
    expect(screen.getAllByText('Lunch').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Ceramics/).length).toBeGreaterThan(0)
  })

  it('a pin-only name (not dual-use) is marked in pinOnlyActivityNames and still ships in approved.activities', async () => {
    await uploadFile()
    const inputs = await commit()
    expect(inputs.pinOnlyActivityNames).toContain('Lunch')
    expect(inputs.approved.activities).toContain('Lunch')
  })

  it('a genuinely dual-use name is NOT marked pin-only, and still ships in approved.activities', async () => {
    await uploadFile()
    const inputs = await commit()
    expect(inputs.pinOnlyActivityNames).not.toContain('Ceramics')
    expect(inputs.approved.activities).toContain('Ceramics')
  })

  it('every inferred fixed event ships unconditionally in the commit inputs', async () => {
    await uploadFile()
    const inputs = await commit()
    expect(inputs.fixedEvents.map((fe) => fe.name).sort()).toEqual(['Ceramics', 'Free Swim', 'Lunch'])
  })

  // Classifier-sequencing fix (docs/adr/2026-08-23-activity-recurrence-tiers-ingestion.md
  // §4.1/§6 step 3): a pin-only (non-dual-use) fixed event must not also carry
  // a spurious inferred Obligation (min_per_week) rule — that was two
  // uncoordinated classification passes double-classifying the same name. A
  // dual-use name legitimately keeps its Obligation rule (ADR OQ1).
  it('a pin-only fixed event gets no inferred activity rule, while a dual-use one still does', async () => {
    await uploadFile()
    const inputs = await commit()
    expect(inputs.activityRules.Lunch).toBeUndefined()
    expect(inputs.activityRules.Ceramics).toBeDefined()
  })

  // Red Hat CONFIRMED HIGH follow-up: ADR §4.1's Asserted denylist is high OR
  // low confidence — a low-confidence fixed event is still an Asserted-shaped
  // hypothesis, not a demotion to Obligation. `pinOnlySet` (which feeds the
  // separate tier:'low' pin mechanism) is high-confidence-only and is the
  // WRONG set for this exclusion; ImportScreen must use a set built from ALL
  // inferred fixed-event names minus dual-use, regardless of confidence.
  it('a LOW-confidence pin-only fixed event also gets no inferred activity rule', async () => {
    await uploadFile()
    const inputs = await commit()
    expect(inputs.activityRules['Free Swim']).toBeUndefined()
    // still ships unconditionally per ADR 2026-08-09 Decision 1 (unchanged)
    expect(inputs.fixedEvents.map((fe) => fe.name)).toContain('Free Swim')
  })
})
