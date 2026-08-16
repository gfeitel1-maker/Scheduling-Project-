// @vitest-environment jsdom
//
// Q8/M4 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D3, §D5).
// Drives the REAL parse -> extractEntities -> buildPreview -> ImportScreen
// tick/gate -> buildCommitInputs path (only parseTextGrid is mocked, to hand
// in a hand-built grid) rather than stubbing extractEntities out, because the
// bug this guards lives inside extractEntities' own candidate tally.
//
// The fixture spells the same room two ways across two activities on one row
// ("pool" under Swim, "Pool" under Art) — the exact shape of the reported
// silent-drop: a case-folding candidate tally collapsed both spellings into
// one candidate, so ticking it bound only the activity whose exact text
// matched the surfaced spelling and left the other silently unbound.
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
  await waitFor(() => expect(screen.queryAllByText(/Seen in this file as a room\./).length).toBeGreaterThan(0))
}

// The candidate buttons render {name} as their own leading text node, so
// distinguishing "pool" from "Pool" by exact case needs a case-sensitive
// match on the button's own text rather than RTL's getByText (which would
// see both as substring matches of one another).
function locationButton(name) {
  return screen.getAllByRole('button').find((b) => b.textContent.startsWith(name))
}

async function commit() {
  await userEvent.click(screen.getByText(/Add \d+ record/))
  await userEvent.click(await screen.findByText(/Commit \d+ record/))
  await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
  return localClient.ingestCommit.mock.calls[0][0]
}

describe('ImportScreen — location candidate case-consistency (Q8 §D3/§D5)', () => {
  it('surfaces "pool" and "Pool" as two distinct, independently tickable candidates', async () => {
    await uploadFile()
    expect(locationButton('pool')).toBeTruthy()
    expect(locationButton('Pool')).toBeTruthy()
  })

  it('ticking both candidates binds every activity that named that room, in either spelling — no silent omission', async () => {
    await uploadFile()
    await userEvent.click(locationButton('pool'))
    await userEvent.click(locationButton('Pool'))
    const inputs = await commit()
    expect(inputs.approved.locations).toContain('pool')
    expect(inputs.approved.locations).toContain('Pool')
    expect(inputs.activityRules.Swim.location).toBe('pool')
    expect(inputs.activityRules.Art.location).toBe('Pool')
  })

  it('ticking only one spelling binds only the activity whose exact text matches it', async () => {
    await uploadFile()
    await userEvent.click(locationButton('pool'))
    const inputs = await commit()
    expect(inputs.activityRules.Swim.location).toBe('pool')
    expect(inputs.activityRules.Art.location).toBeUndefined()
  })

  it('propose-only gate: a captured location left unticked creates no location row and binds no activity', async () => {
    await uploadFile()
    // Neither candidate ticked (default state).
    const inputs = await commit()
    expect(inputs.approved.locations).toEqual([])
    expect(inputs.activityRules.Swim?.location).toBeUndefined()
    expect(inputs.activityRules.Art?.location).toBeUndefined()
  })
})
