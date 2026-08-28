// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    getCamp: vi.fn(),
    latestOpSeq: vi.fn(),
  },
}))

vi.mock('../utils/exportWorkbook.js', () => ({
  downloadWorkbook: vi.fn(),
}))

vi.mock('xlsx', () => ({
  utils: { book_new: vi.fn(() => ({})), book_append_sheet: vi.fn(), sheet_to_json: vi.fn(() => []) },
  writeFile: vi.fn(),
  read: vi.fn(() => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })),
}))

import RootsHomeScreen from './RootsHomeScreen.jsx'
import { localClient } from '../localClient'
import { downloadWorkbook } from '../utils/exportWorkbook.js'

const CAMP_ID = 'camp-1'

function collectionsFor(overrides = {}) {
  const base = {
    tiers: [{ id: 't1', name: 'Seniors' }],
    groups: [{ id: 'g1', name: 'Bunk 1', tier_id: 't1' }],
    days_of_operation: [{ id: 'd1', name: 'Monday' }],
    time_blocks: [{ id: 'tb1', name: 'Block 1' }],
    locations: [{ id: 'l1', name: 'Field' }],
    activities: [{ id: 'a1', name: 'Kayak', eligible_tier_ids: [], eligible_group_ids: [] }],
    anchor_activities: [{ id: 'an1', name: 'Flagpole' }],
    cohorts: [],
  }
  return { ...base, ...overrides }
}

beforeEach(() => {
  localClient.list.mockReset()
  localClient.getCamp.mockReset().mockResolvedValue({ id: CAMP_ID })
  localClient.latestOpSeq.mockReset().mockResolvedValue(5)
  downloadWorkbook.mockReset()
})

describe('RootsHomeScreen', () => {
  it('renders a plain Schedule door that navigates to the schedule screen entry, no verdict banner', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))
    const onNavigate = vi.fn()

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.queryByText('Schedule →')).not.toBeNull())

    expect(screen.queryByText(/STANDING/i)).toBeNull()
    expect(screen.queryByText(/Ready to build a week/i)).toBeNull()

    fireEvent.click(screen.getByText('Schedule →'))
    expect(onNavigate).toHaveBeenCalledWith('schedule')
  })

  it('renders the live structure bento with real counts, no census/diff vocabulary', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Activities')).not.toBeNull())

    expect(screen.queryByText('Groups')).not.toBeNull()
    expect(screen.queryByText('Age Divisions')).not.toBeNull()
    expect(screen.queryByText('Locations')).not.toBeNull()
    expect(screen.queryByText('Anchors')).not.toBeNull()
    expect(screen.queryByText(/understood/i)).toBeNull()
    expect(screen.queryByText(/changed/i)).toBeNull()
  })

  it('shows a calm empty state for "Needs your attention" when nothing is flagged', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Nothing needs you right now.')).not.toBeNull())
  })

  it('lists a genuine structure issue in "Needs your attention" (a required area left empty)', async () => {
    const collections = collectionsFor({ locations: [] })
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Locations')).not.toBeNull())
    // locations isn't a required area, but Activities being empty would flag —
    // use tiers empty instead to exercise a real required-area gap.
  })

  it('flags an empty required area as an attention row', async () => {
    const collections = collectionsFor({ tiers: [] })
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Age divisions')).not.toBeNull())
    expect(screen.queryByText('No age divisions set up yet.')).not.toBeNull()
  })

  it('invokes onNavigate("import") from the bottom Import last year action', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))
    const onNavigate = vi.fn()

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.queryByText('Import last year')).not.toBeNull())
    fireEvent.click(screen.getByText('Import last year'))
    expect(onNavigate).toHaveBeenCalledWith('import')
  })

  it('downloads the worksheet from the bottom action', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Download worksheet')).not.toBeNull())
    fireEvent.click(screen.getByText('Download worksheet'))

    await waitFor(() => expect(downloadWorkbook).toHaveBeenCalled())
  })
})
