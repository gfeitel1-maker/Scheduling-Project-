// @vitest-environment jsdom
//
// Q8/M4 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D3, §D5).
// Drives the REAL parse -> extractEntities -> ImportScreen -> buildCommitInputs
// path (only parseTextGrid is mocked, to hand in a hand-built grid) rather than
// stubbing extractEntities out, because the bug this guards lives inside
// extractEntities' own candidate tally.
//
// The fixture spells the same room two ways across two activities on one row
// ("pool" under Swim, "Pool" under Art) — the exact shape of the reported
// silent-drop: a case-folding candidate tally collapsed both spellings into
// one candidate.
//
// ADR 2026-08-17-onescreen-reconciliation-merge.md §2 — ImportScreen no longer
// ticks locations; every candidate is sent unconditionally. Q8's "nothing is
// ever minted or bound without an explicit director decision" now holds via
// buildPlan's createConfidenceTier (locations always tier:'low'), exercised
// separately in buildPlan.test.js. This file only proves ImportScreen sends
// BOTH exact-case spellings through, unconditionally, with the correct
// per-activity pairing — the case-consistency bug this file exists to guard.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const parsed = {
  pages: [
    {
      title: 'Bunk1',
      timeColumnLabeled: false,
      columns: ['Monday', 'Tuesday'],
      rows: [
        {
          label: '9:00',
          cells: ['Swim', 'Art'],
          locations: ['pool', 'Pool'],
        },
      ],
    },
  ],
}

vi.mock('../ingest/textGrid', async () => {
  const actual = await vi.importActual('../ingest/textGrid')
  return { ...actual, parseTextGrid: () => parsed }
})
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: () => ({ fixedEvents: [], dualUseNames: [] }) }))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
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
  localClient.list.mockResolvedValue([])
  localClient.ingestCommit.mockResolvedValue({ total: 1, fixedEvents: { created: 0, skipped: [], partial: [] } })
})

async function uploadFile() {
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
  await userEvent.upload(input, file)
  await waitFor(() => expect(screen.queryAllByText('pool').length).toBeGreaterThan(0))
}

async function commit() {
  await userEvent.click(screen.getByText(/Add \d+ record/))
  // The fixture has no tiers/groups/time_blocks set up yet, so
  // ReconciliationScreen's readiness gate (F3) surfaces required_gap cards
  // that must be dismissed (Skip for now) before "Use this setup" enables —
  // unrelated to what this test guards (Q8 case-consistency), so dismiss
  // whatever appears rather than special-casing the fixture.
  await waitFor(() => expect(screen.getByText(/Use this setup/)).toBeTruthy())
  for (const btn of screen.queryAllByText(/^Skip .* for now/)) {
    await userEvent.click(btn)
  }
  await userEvent.click(await screen.findByText('Use this setup'))
  await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
  return localClient.ingestCommit.mock.calls[0][0]
}

describe('ImportScreen — location candidate case-consistency (Q8 §D3/§D5)', () => {
  it('surfaces "pool" and "Pool" as two distinct candidates', async () => {
    await uploadFile()
    expect(screen.getByText('pool')).toBeTruthy()
    expect(screen.getByText('Pool')).toBeTruthy()
  })

  it('sends both spellings unconditionally, each bound to the activity that named it — no silent omission', async () => {
    await uploadFile()
    const inputs = await commit()
    expect(inputs.approved.locations).toContain('pool')
    expect(inputs.approved.locations).toContain('Pool')
    expect(inputs.activityRules.Swim.location).toBe('pool')
    expect(inputs.activityRules.Art.location).toBe('Pool')
  })
})
