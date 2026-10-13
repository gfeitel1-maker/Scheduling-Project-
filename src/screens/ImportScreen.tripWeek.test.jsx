// @vitest-environment jsdom
//
// Board ruling 2026-10-13: a trip or whole day for some groups is never left without a week. With none open it
// goes to the camp's first week, and the review says so in one line ("Games Day placed on Week 1 · Change week").
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const parsed = {
  pages: [{ title: 'Bunk1', timeColumnLabeled: false, columns: ['Monday', 'Tuesday'], rows: [{ label: '9:00', cells: ['Swim', 'Art'] }] }],
}
const detection = {
  kind: 'subset-day', day: 'Monday', name: 'Games Day', groupIds: ['Bunk1'], blocks: ['9:00'],
  lexicalCue: 'day', wholeDay: true, confidence: 'high', defaultAnswer: 'event', missingGroups: [], alternate: false,
  claims: [{ groupName: 'Bunk1', dayName: 'Monday', blockLabel: '9:00' }],
}

vi.mock('../ingest/textGrid', async () => {
  const actual = await vi.importActual('../ingest/textGrid')
  return { ...actual, parseTextGrid: () => parsed }
})
vi.mock('../ingest/tripDetection.js', () => ({ detectTripsAndSpecialDays: () => [detection] }))
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: () => ({ fixedEvents: [], dualUseNames: [] }) }))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1', name: 'Camp' }),
    deleteEntity: vi.fn(),
    ingestCommit: vi.fn(),
    ingestReconcile: vi.fn().mockResolvedValue({ planItems: [], fixedEventsReport: {}, legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {} }),
    matchImportAnswers: vi.fn(),
    rememberImportAnswers: vi.fn(),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'

// Two weeks, listed out of order, none open: the trip goes to the first by sort order.
const weeks = [{ id: 'w2', name: 'Week 2', sort_order: 1 }, { id: 'w1', name: 'Week 1', sort_order: 0 }]
const baseOutcome = { total: 1, fixedEvents: { created: 0, skipped: [], partial: [] } }

beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockResolvedValue([])
  localClient.matchImportAnswers.mockResolvedValue({})
  localClient.rememberImportAnswers.mockResolvedValue({ ok: true })
  localClient.ingestCommit.mockResolvedValue(baseOutcome)
})

async function upload(weeksProp = weeks) {
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} weeks={weeksProp} />)
  const input = document.querySelector('input[type="file"]')
  await userEvent.upload(input, new File(['x'], 'schedule.txt', { type: 'text/plain' }))
  await screen.findByText(/Games Day, Monday/)
}

async function confirm() {
  await userEvent.click(screen.getByText(/Review \d+ record/))
  await waitFor(() => expect(screen.getByText(/Use this setup|Use what Shoresh understood|Import the rest|Add to camp|Apply \d+ decision/)).toBeTruthy())
  let skips = screen.queryAllByText(/^Skip .* for now/)
  while (skips.length > 0) {
    await userEvent.click(skips[0])
    skips = screen.queryAllByText(/^Skip .* for now/)
  }
  await userEvent.click(await screen.findByText(/Use this setup|Use what Shoresh understood|Import the rest|Add to camp|Apply \d+ decision/))
  await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
}

describe('ImportScreen: a trip binds to the first week when none is open (board ruling 2026-10-13)', () => {
  it('says where the trip went in one plain line and commits it as an event in that week', async () => {
    await upload()
    expect(screen.getByText(/Games Day placed on Week 1/)).toBeTruthy()
    expect(screen.queryByLabelText('Week for Games Day')).toBeNull()
    expect(screen.queryByText(/imports as an activity/)).toBeNull()
    await confirm()
    const sent = localClient.ingestCommit.mock.calls[0][0].fixedEvents
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Games Day', weekId: 'w1', trip: true })]))
  })

  it('Change week opens the picker, and the pick is what commits', async () => {
    await upload()
    await userEvent.click(screen.getByRole('button', { name: 'Change week' }))
    const select = screen.getByLabelText('Week for Games Day')
    expect(select.value).toBe('w1')
    await userEvent.selectOptions(select, 'w2')
    await confirm()
    const sent = localClient.ingestCommit.mock.calls[0][0].fixedEvents
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Games Day', weekId: 'w2' })]))
  })
})
