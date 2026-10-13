// @vitest-environment jsdom
//
// F3/F4 slice 3b — screen-level pins for the whole-camp-day card: a recalled 'special_day' answer pre-selects
// but never commits on its own; post-commit outcomes read as plain-words notices; a hand-picked answer is
// written to answer memory.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const parsed = {
  pages: [{ title: 'Bunk1', timeColumnLabeled: false, columns: ['Monday', 'Tuesday'], rows: [{ label: '9:00', cells: ['Swim', 'Art'] }] }],
}
const detection = {
  kind: 'all-camp-day', day: 'Monday', name: 'Color War', groupIds: ['Bunk1'], blocks: ['9:00'],
  lexicalCue: null, wholeDay: true, confidence: 'medium', defaultAnswer: null, missingGroups: [], alternate: false,
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

const weeks = [{ id: 'w1', name: 'Week 1' }]
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
  await screen.findByText(/Color War, Monday, every group/)
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

const isActive = (btn) => btn.style.border.includes('var(--primary)')

describe('ImportScreen — whole-camp day (slice 3b)', () => {
  it('a remembered special_day answer pre-selects but commits nothing until the director confirms', async () => {
    localClient.matchImportAnswers.mockImplementation(async ({ others }) =>
      Object.fromEntries(others.map((o) => [o.id, { answer: { verdict: 'special_day' } }])))
    await upload()
    expect(localClient.matchImportAnswers.mock.calls[0][0].others[0]).toMatchObject({ qkind: 'special_day', name: 'Color War', day: 'Monday' })
    expect(isActive(screen.getByText('Special day'))).toBe(true)
    expect(isActive(screen.getByText('Events'))).toBe(false)
    expect(localClient.ingestCommit).not.toHaveBeenCalled()
    await confirm()
    expect(localClient.ingestCommit.mock.calls[0][0].wholeCampDays).toEqual([
      expect.objectContaining({ name: 'Color War', day: 'Monday', weekId: 'w1' }),
    ])
  })

  it('shows plain-words notices for a kept, skipped and unplaced outcome after commit', async () => {
    localClient.ingestCommit.mockResolvedValue({
      ...baseOutcome,
      wholeCampDays: [
        { name: 'Color War', day: 'Monday', keptExisting: true },
        { name: 'Olympics', day: 'Tuesday', skipped: 'its groups are not in this camp' },
      ],
      placementsDropped: [{ dayLabel: 'Wednesday' }],
    })
    await upload()
    await userEvent.click(screen.getByText('Special day'))
    await confirm()
    await screen.findByText(/Color War on Monday was not made a special day: that day already has a special day/)
    expect(screen.getByText(/Olympics on Tuesday was not made a special day: its groups are not in this camp\./)).toBeTruthy()
    expect(screen.getByText(/A special day placed on Wednesday was unplaced/)).toBeTruthy()
  })

  it('records a hand-picked answer to answer memory', async () => {
    await upload()
    expect(isActive(screen.getByText('Special day'))).toBe(false)
    await userEvent.click(screen.getByText('Special day'))
    await confirm()
    await waitFor(() => expect(localClient.rememberImportAnswers).toHaveBeenCalled())
    expect(localClient.rememberImportAnswers.mock.calls[0][0].entries).toEqual([
      expect.objectContaining({ other: expect.objectContaining({ qkind: 'special_day', name: 'Color War', day: 'Monday' }), answer: { verdict: 'special_day' } }),
    ])
  })

  it('a fresh camp with no weeks is still offered the item, bound to the Week 1 the import will create', async () => {
    await upload([])
    expect(screen.queryByText(/Add a week on the Schedule screen/)).toBeNull()
    const select = screen.getByLabelText('Week for Color War')
    expect(select.value).toBe('schedule-week:camp-1:1')
    expect([...select.options].map((o) => o.textContent)).toEqual(['Week 1 (new)'])
    await userEvent.click(screen.getByText('Special day'))
    expect(screen.getByText(/Replaces the whole day for every group on Monday, Week 1\./)).toBeTruthy()
    await confirm()
    expect(localClient.ingestCommit.mock.calls[0][0].wholeCampDays).toEqual([
      expect.objectContaining({ name: 'Color War', day: 'Monday', weekId: 'schedule-week:camp-1:1' }),
    ])
  })
})
