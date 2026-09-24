// @vitest-environment jsdom
//
// T237 — the Roots attention rows become interactive (click navigates),
// cap at what fits the viewport (measured, not a constant), order
// alphabetically, and their overflow affordance navigates into the
// reconciliation flow rather than expanding in place.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

function stubMatchMedia(matches) {
  window.matchMedia = vi.fn((query) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

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
  localClient.listOpenReconciliationDecisions.mockReset().mockResolvedValue([])
  localClient.dismissOpenReconciliationDecisions.mockReset().mockResolvedValue({ ok: true, dismissed: 0 })
  stubMatchMedia(false)
  window.innerHeight = 900
})

afterEach(() => {
  delete window.matchMedia
})

describe('RootsHomeScreen attention rows — T237', () => {
  it('navigates a structure row to the screen rootMapNav resolves for its domainTag', async () => {
    const collections = collectionsFor({ tiers: [] })
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))
    const onNavigate = vi.fn()

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.queryByText('Age divisions')).not.toBeNull())

    // Structure rows carry no childKey, so this resolves via DOMAIN_SCREEN's
    // domain-level fallback ('Structure' -> 'groups'), not a tiers-specific
    // target (rootMapNav.js).
    fireEvent.click(screen.getByRole('button', { name: /Age divisions/ }))
    expect(onNavigate).toHaveBeenCalledWith('groups')
  })

  it('navigates a reconciliation row to the reconciliation screen', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))
    localClient.listOpenReconciliationDecisions.mockResolvedValue([
      { id: 'dec-1', kind: 'confirm_value', domain_key: 'Scheduling', child_key: 'Activities', entity_id: 'a9', entity_name: 'Waterfront', reason: 'No location matched.' },
    ])
    const onNavigate = vi.fn()

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.queryByText('Waterfront')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /Waterfront/ }))
    expect(onNavigate).toHaveBeenCalledWith('reconciliation')
  })

  it('orders attention rows alphabetically by name', async () => {
    const collections = collectionsFor({ tiers: [], groups: [] })
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Age divisions')).not.toBeNull())

    // Scoped to the rail — the bento grid above it also has a "Groups" card
    // label, which an unscoped query would pick up first (DOM order), lying
    // about the rail's own order.
    const rail = screen.getByRole('complementary', { name: 'Needs your attention' })
    const names = within(rail).getAllByText(/Age divisions|Groups/).map((el) => el.textContent)
    expect(names).toEqual(['Age divisions', 'Groups'])
  })

  it('the overflow affordance navigates to the reconciliation flow rather than expanding in place', async () => {
    // Force a tiny budget so every row but one overflows: a near-zero
    // window.innerHeight leaves no measured room, guaranteeing the overflow
    // chip appears regardless of jsdom's zeroed layout metrics. useMeasuredRowCap
    // always shows at least one row when there is at least one item (T237
    // Fix 5 — a rail with content never renders as "zero rows, only overflow"),
    // so with two attention rows the first (alphabetically) shows and the rest
    // overflow.
    window.innerHeight = 0
    const collections = collectionsFor({ tiers: [], groups: [] })
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))
    const onNavigate = vi.fn()

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.queryByTestId('attention-overflow')).not.toBeNull())

    const rail = screen.getByRole('complementary', { name: 'Needs your attention' })
    expect(within(rail).queryByText('Age divisions')).not.toBeNull()
    expect(within(rail).queryByText('Groups')).toBeNull()
    fireEvent.click(screen.getByTestId('attention-overflow'))
    expect(onNavigate).toHaveBeenCalledWith('reconciliation')
  })
})
