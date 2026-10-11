// @vitest-environment jsdom
//
// F3/F4 slice 4 review: the one-day card's week / day selects and its error copy, driven through the real
// parse -> propose -> plan -> placement path (only parseTextGrid is mocked, to hand in a grid).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const grid = {
  pages: [{
    title: '"Among Us" Maccabiah Schedule 2022',
    columns: ['Lil Chai', 'Chaverim', 'Shalom', 'Giborim'],
    rows: [
      { label: '9:15', cells: ['Opening', 'Opening', 'Opening', 'Opening'] },
      { label: '10:15', cells: ['Pool - Unit Heads', 'Stem - Sylvia', 'Values - Laura', 'Gym - Tomer'] },
    ],
  }],
}
vi.mock('../ingest/textGrid', async () => {
  const actual = await vi.importActual('../ingest/textGrid')
  return { ...actual, parseTextGrid: vi.fn(() => grid) }
})
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn().mockResolvedValue({ status: 'applied' }),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1', name: 'Camp' }),
    deleteEntity: vi.fn(),
    ingestCommit: vi.fn(),
    ingestReconcile: vi.fn(),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'

const GROUPS = [{ id: 'g1', name: 'Lil Chai' }, { id: 'g2', name: 'Chaverim' }, { id: 'g3', name: 'Shalom' }, { id: 'g4', name: 'Giborim' }]
const DAYS = [{ id: 'dM', label: 'Monday' }, { id: 'dT', label: 'Tuesday' }]
const WEEKS = [{ id: 'w1', name: 'Week 1' }, { id: 'w2', name: 'Week 2' }]
let activities

beforeEach(() => {
  vi.clearAllMocks()
  activities = []
  localClient.list.mockImplementation((entity) => Promise.resolve({ groups: GROUPS, days_of_operation: DAYS, activities }[entity] ?? []))
  localClient.ingestReconcile.mockResolvedValue({ activityAliases: [] })
  localClient.ingestCommit.mockResolvedValue({ specialDay: { created: true, name: 'x' } })
})

async function upload(props, fileName = 'Tuesday maccabiah.txt') {
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} {...props} />)
  await userEvent.upload(document.querySelector('input[type="file"]'), new File(['x'], fileName, { type: 'text/plain' }))
  return screen.findByRole('button', { name: /Build this special day/i })
}

describe('ImportScreen one-day card — week and day selects', () => {
  it('several weeks, none open: the resolved day is pre-filled, the week is empty, and the flag says to pick a week', async () => {
    await upload({ weeks: WEEKS })
    expect(screen.getByLabelText('Special day week').value).toBe('')
    expect(screen.getByLabelText('Special day weekday').value).toBe('dT')
    expect(screen.getByText(/Pick a week to place the day on Tuesday/)).toBeTruthy()
  })

  it('picking the week then building sends that (week, day) placement', async () => {
    const build = await upload({ weeks: WEEKS })
    await userEvent.selectOptions(screen.getByLabelText('Special day week'), 'w2')
    await userEvent.click(build)
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    expect(localClient.ingestCommit.mock.calls[0][0].specialDay.placement).toEqual({ weekId: 'w2', dayId: 'dT' })
  })

  it('the open week and the printed weekday place the day with both selects filled', async () => {
    await upload({ weeks: WEEKS, weekId: 'w2' })
    expect(screen.getByLabelText('Special day week').value).toBe('w2')
    expect(screen.getByLabelText('Special day weekday').value).toBe('dT')
    expect(screen.getByText('Placed on')).toBeTruthy()
  })

  it('a camp with no weeks is offered Week 1 (new) and binds to the deterministic id', async () => {
    const build = await upload({ weeks: [] })
    const week = screen.getByLabelText('Special day week')
    expect(week.value).toBe('schedule-week:camp-1:1')
    expect([...week.options].map((o) => o.textContent)).toContain('Week 1 (new)')
    await userEvent.click(build)
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    expect(localClient.ingestCommit.mock.calls[0][0].specialDay.placement).toEqual({ weekId: 'schedule-week:camp-1:1', dayId: 'dT' })
  })
})

describe('ImportScreen one-day card — error copy', () => {
  it('keptExisting reads as "that day already has a special day", naming the day and offering a way out', async () => {
    localClient.ingestCommit.mockResolvedValue({ specialDay: { created: false, keptExisting: true, placed: false } })
    const build = await upload({ weeks: WEEKS, weekId: 'w1' })
    await userEvent.click(build)
    expect(await screen.findByText(/That day already has a special day on it, so ""Among Us" Maccabiah Schedule 2022" was not built\. Pick another day, or leave it unplaced\./)).toBeTruthy()
    expect(screen.queryByText(/Special day built/i)).toBeNull()
  })

  it('an already-built day with nothing new says nothing was built', async () => {
    localClient.ingestCommit.mockResolvedValue({ specialDay: { created: false } })
    const build = await upload({ weeks: WEEKS, weekId: 'w1' })
    await userEvent.click(build)
    expect(await screen.findByText(/already exists, so nothing was built\./)).toBeTruthy()
  })
})

describe('ImportScreen one-day card — the preview matches names the way the commit does', () => {
  it('an aliased name is not listed as a new activity; a punctuation variant of an existing one is not either', async () => {
    activities = [{ id: 'a1', name: 'Gym Time' }, { id: 'a2', name: 'Pool' }]
    localClient.ingestReconcile.mockResolvedValue({ activityAliases: [['opening', 'a1']] })
    await upload({ weeks: WEEKS, weekId: 'w1' })
    expect(screen.getByText((_, el) => /adds 3 new activities/i.test(el?.textContent ?? ''), { selector: 'p' })).toBeTruthy()
  })
})
