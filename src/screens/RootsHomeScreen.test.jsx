// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    getCamp: vi.fn(),
    latestOpSeq: vi.fn(),
    listOpenReconciliationDecisions: vi.fn(() => Promise.resolve([])),
    dismissOpenReconciliationDecisions: vi.fn(() => Promise.resolve({ ok: true, dismissed: 0 })),
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
    // The arrow renders in its own <span> (WS4 polish — only the arrow nudges
    // on hover), so the accessible name is checked via role rather than exact
    // text, which doesn't match across sibling elements.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Schedule →' })).not.toBeNull())

    expect(screen.queryByText(/STANDING/i)).toBeNull()
    expect(screen.queryByText(/Ready to build a week/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Schedule →' }))
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

  it('renders name chips on the large/wide cards but not on the small cards, with overflow', async () => {
    const collections = collectionsFor({
      activities: [
        { id: 'a1', name: 'Kayak' },
        { id: 'a2', name: 'Archery' },
        { id: 'a3', name: 'Arts & Crafts' },
        { id: 'a4', name: 'Ropes Course' },
        { id: 'a5', name: 'Sailing' },
      ],
      groups: [{ id: 'g1', name: 'Falcons', tier_id: 't1' }],
      anchor_activities: [{ id: 'an1', name: 'Flagpole' }],
      tiers: [{ id: 't1', name: 'Seniors' }],
      locations: [{ id: 'l1', name: 'Field' }],
    })
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Activities')).not.toBeNull())

    // Large card (Activities) caps at 4 names, overflow pill for the rest.
    expect(screen.queryByText('Kayak')).not.toBeNull()
    expect(screen.queryByText('Ropes Course')).not.toBeNull()
    expect(screen.queryByText('Sailing')).toBeNull()
    expect(screen.queryByText('+1 more')).not.toBeNull()

    // Large card (Groups) shows its chip.
    expect(screen.queryByText('Falcons')).not.toBeNull()

    // Wide card (Anchors) shows its chip.
    expect(screen.queryByText('Flagpole')).not.toBeNull()

    // Small cards (Age Divisions / Locations) stay count-only, no chips.
    expect(screen.queryByText('Seniors')).toBeNull()
    expect(screen.queryByText('Field')).toBeNull()
  })

  it('colors the card count with the rooted (secondary) token only when count > 0', async () => {
    const collections = collectionsFor({ tiers: [] })
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Age Divisions')).not.toBeNull())

    const zeroCount = screen.getByText('Age Divisions').closest('div').parentElement.querySelector('span:last-child')
    expect(zeroCount.style.color).toBe('var(--text-secondary)')

    const rootedCount = screen.getByText('Groups').closest('div').parentElement.querySelector('span:last-child')
    expect(rootedCount.style.color).toBe('var(--secondary)')
  })

  it('renders attention domain tags with the accent (bronze) color mix, not the secondary green', async () => {
    const collections = collectionsFor({ tiers: [] })
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Age divisions')).not.toBeNull())

    const domainChip = screen.getByText('Structure')
    // jsdom doesn't parse color-mix() into CSSOM, so assert on the raw
    // inline style attribute rather than the computed .style.background.
    expect(domainChip.getAttribute('style')).toContain('var(--accent)')
    expect(domainChip.getAttribute('style')).not.toContain('var(--secondary)')
  })

  it('weights the Schedule bar as the forward door, distinct from the bento cards (WS4b)', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Schedule →' })).not.toBeNull())

    const scheduleBar = screen.getByRole('button', { name: 'Schedule →' })
    const style = scheduleBar.getAttribute('style')
    expect(style).toContain('color-mix(in srgb, var(--primary)')
    expect(style).not.toBe(null)

    const card = screen.getByText('Activities').closest('div').parentElement
    // The bento card keeps the plain WS4a surface fill — no primary tint —
    // so the door reads as visually distinct from a sixth bento card.
    expect(card.getAttribute('style')).not.toContain('color-mix(in srgb, var(--primary)')
  })

  it('renders a colored arrow glyph on the Schedule door at the larger door-affordance size', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Schedule →' })).not.toBeNull())

    const arrow = screen.getByText('→')
    expect(arrow.style.color).toBe('var(--primary)')
    expect(arrow.style.fontSize).toBe('17px')
  })

  it('steps the count typography to 18px tabular-nums on chip-bearing cards, keeps small cards at 14.5px', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Activities')).not.toBeNull())

    const activitiesCount = screen.getByText('Activities').closest('div').parentElement.querySelector('span:last-child')
    expect(activitiesCount.style.fontSize).toBe('18px')
    expect(activitiesCount.style.fontVariantNumeric).toBe('tabular-nums')

    const tiersCount = screen.getByText('Age Divisions').closest('div').parentElement.querySelector('span:last-child')
    expect(tiersCount.style.fontSize).toBe('')
  })

  it('shows a check icon and gentle mount motion in the empty "needs your attention" state', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Nothing needs you right now.')).not.toBeNull())

    expect(screen.getByTestId('attention-empty-check')).not.toBeNull()
  })

  it('spaces the dense grid apart from the attention section using --space-6, keeps --space-5 above the grid', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Activities')).not.toBeNull())

    const gridSection = screen.getByText('What has taken root').closest('section')
    const attentionSection = screen.getByText('Needs your attention').closest('section')
    expect(gridSection.style.marginTop).toBe('var(--space-5)')
    expect(attentionSection.style.marginTop).toBe('var(--space-6)')
  })

  it('places every bento card at a deterministic, explicit grid position (no auto-placement gap)', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Activities')).not.toBeNull())

    const expected = {
      'Activities': { gridColumn: '1 / span 2', gridRow: '1 / span 2' },
      'Groups': { gridColumn: '1 / span 2', gridRow: '3 / span 2' },
      'Age Divisions': { gridColumn: '3', gridRow: '1' },
      'Locations': { gridColumn: '3', gridRow: '2' },
      'Days & Blocks': { gridColumn: '3', gridRow: '3' },
      'Anchors': { gridColumn: '1 / span 3', gridRow: '5' },
    }
    for (const [label, coords] of Object.entries(expected)) {
      const card = screen.getByText(label).closest('div').parentElement
      expect(card.style.gridColumn).toBe(coords.gridColumn)
      expect(card.style.gridRow).toBe(coords.gridRow)
    }
  })
})
