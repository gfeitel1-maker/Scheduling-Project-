// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// jsdom has no matchMedia by default; stub it so useNarrowViewport doesn't
// throw. `matches` reflects the WIDE (>breakpoint) case unless overridden.
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
    attributeSubject: vi.fn(),
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
    fixed_events: [{ id: 'an1', name: 'Flagpole' }],
    cohorts: [],
  }
  return { ...base, ...overrides }
}

beforeEach(() => {
  localClient.list.mockReset()
  localClient.getCamp.mockReset().mockResolvedValue({ id: CAMP_ID })
  localClient.latestOpSeq.mockReset().mockResolvedValue(5)
  downloadWorkbook.mockReset()
  stubMatchMedia(false) // wide viewport by default
})

afterEach(() => {
  delete window.matchMedia
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

  it('surfaces a failure message when the worksheet download fails', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))
    downloadWorkbook.mockImplementation(() => {
      throw new Error('boom')
    })

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Download worksheet')).not.toBeNull())
    fireEvent.click(screen.getByText('Download worksheet'))

    await waitFor(() =>
      expect(screen.queryByText((text) => text.startsWith('The worksheet could not be created.'))).not.toBeNull()
    )
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
      fixed_events: [{ id: 'an1', name: 'Flagpole' }],
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

  it('aligns the rail section label with the bento section label, both at --space-5', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Activities')).not.toBeNull())

    const gridSection = screen.getByText('What has taken root').closest('section')
    const attentionLabel = screen.getByText('Needs your attention')
    expect(gridSection.style.marginTop).toBe('var(--space-5)')
    expect(attentionLabel.style.marginTop).toBe('var(--space-5)')
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

  it('renders "Needs your attention" inside a landmark named after the section (T236)', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Activities')).not.toBeNull())

    expect(screen.getByRole('complementary', { name: 'Needs your attention' })).not.toBeNull()
  })

  it('at wide viewport, renders the attention rail after the bento in DOM order and makes it sticky (T236)', async () => {
    stubMatchMedia(false) // wide: not narrow
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Activities')).not.toBeNull())

    const bentoSection = screen.getByText('What has taken root').closest('section')
    const rail = screen.getByRole('complementary', { name: 'Needs your attention' })

    expect(bentoSection.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(rail.style.position).toBe('sticky')
  })

  it('at narrow viewport, orders the attention rail before the bento in what actually renders (T236)', async () => {
    stubMatchMedia(true) // narrow
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Activities')).not.toBeNull())

    const bentoSection = screen.getByText('What has taken root').closest('section')
    const rail = screen.getByRole('complementary', { name: 'Needs your attention' })

    // The two columns are flex children of one row; visual order is governed
    // by the `order` CSS property, not DOM order (DOM order stays constant
    // across breakpoints). Assert on `order`, the thing that actually
    // determines what the director sees, not a DOM-order proxy that would
    // lie once flex `order` is in play.
    const railOrder = Number(rail.style.order || 0)
    const bentoOrder = Number(bentoSection.parentElement.style.order || 0)
    expect(railOrder).toBeLessThan(bentoOrder)

    // Sticky is turned off when stacked.
    expect(rail.style.position).toBe('static')
    expect(rail.style.top).toBe('auto')
  })

  it('renders the empty state inside the rail when there are no attention rows (T236)', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Nothing needs you right now.')).not.toBeNull())

    const rail = screen.getByRole('complementary', { name: 'Needs your attention' })
    expect(rail.contains(screen.getByTestId('attention-empty-check'))).toBe(true)
    expect(rail.contains(screen.getByText('Nothing needs you right now.'))).toBe(true)
  })

  it('keeps the bottom actions inside rootsMain so their position follows the bento column, not the rail (round-2 fix 1)', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Import last year')).not.toBeNull())

    const importButton = screen.getByText('Import last year')
    const rootsMain = screen.getByText('What has taken root').closest('section').parentElement
    expect(rootsMain.contains(importButton)).toBe(true)

    const rail = screen.getByRole('complementary', { name: 'Needs your attention' })
    expect(rail.contains(importButton)).toBe(false)
  })

  it('derives the narrow-layout breakpoint from the real sidebar width, not a hardcoded copy (round-2 fix 2)', async () => {
    const { SIDEBAR_WIDTH_PX } = await import('../components/layout/Sidebar.jsx')
    const { NARROW_BREAKPOINT_PX } = await import('./RootsHomeScreen.jsx')
    expect(NARROW_BREAKPOINT_PX).toBe(SIDEBAR_WIDTH_PX + 48 + 300 + 24 + 562)
  })

  // ——— T304 ——————————————————————————————————————————————————————————————
  // A read that failed must never render as a camp that is empty or settled.
  // The defect these pin: `localClient.list(entity).catch(() => [])` made every
  // failure indistinguishable from "none of these exist", so a staff session
  // whose `campers` read was DENIED saw "Nothing needs you right now." on a camp
  // with unnamed submissions waiting — the same screen the bug had shown all along.

  it('does not claim nothing needs attention when a collection could not be read', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) =>
      entity === 'campers'
        ? Promise.reject(new Error('admin role required'))
        : Promise.resolve(collections[entity] ?? []),
    )

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByTestId('attention-unread-notice')).not.toBeNull())

    // The all-clear is a claim about collections that were read. This one wasn't.
    expect(screen.queryByText('Nothing needs you right now.')).toBeNull()
    expect(screen.queryByTestId('attention-empty-check')).toBeNull()
  })

  // NON-VACUITY for the test above. Asserting the ABSENCE of the all-clear
  // passes just as happily if the rail stopped rendering, if the screen threw,
  // or if the notice were pinned on permanently. The healthy camp must still
  // get its all-clear and must NOT get the notice.
  it('still gives the calm all-clear, and no notice, when every collection reads', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Nothing needs you right now.')).not.toBeNull())

    expect(screen.queryByTestId('attention-unread-notice')).toBeNull()
  })

  // The notice is a caveat on the LIST, not a substitute for an empty one —
  // a partial read makes a NON-empty rail incomplete too. Suppressing it
  // whenever some other row happened to appear would rebuild the silence one
  // case narrower, which is the shape of defect this ticket exists to remove.
  it('shows the notice alongside real attention rows, not only instead of the empty state', async () => {
    const collections = collectionsFor({ tiers: [] })
    localClient.list.mockImplementation((entity) =>
      entity === 'campers'
        ? Promise.reject(new Error('admin role required'))
        : Promise.resolve(collections[entity] ?? []),
    )

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Age divisions')).not.toBeNull())

    expect(screen.queryByTestId('attention-unread-notice')).not.toBeNull()
  })

  it('renders an unreadable card count as an em dash, never as 0', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) =>
      entity === 'activities'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(collections[entity] ?? []),
    )

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    const unread = await screen.findByTestId('card-count-unread-activities')

    expect(unread.textContent).toBe('\u2014')
    // The wrong number is the defect, not the missing one: this camp has one
    // activity, and "0 Activities" would be a confident lie about it.
    expect(unread.textContent).not.toBe('0')
    expect(unread.getAttribute('aria-label')).toMatch(/couldn/i)
  })

  // days_and_blocks sums TWO collections, so either one being unreadable makes
  // the sum unknown. A card that quietly reported only the half it managed to
  // read would be the same defect with better arithmetic.
  it('treats a two-collection card as unreadable when either half fails', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) =>
      entity === 'time_blocks'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(collections[entity] ?? []),
    )

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    const unread = await screen.findByTestId('card-count-unread-days_and_blocks')
    expect(unread.textContent).toBe('\u2014')
  })

  // NON-VACUITY for the two above: the em-dash path must not be what every card
  // takes. A healthy card still prints its real number and carries no unread marker.
  it('positive control: a readable card still prints its real count', async () => {
    const collections = collectionsFor()
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))

    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Activities')).not.toBeNull())

    expect(screen.queryByTestId('card-count-unread-activities')).toBeNull()
    expect(screen.queryByTestId('card-count-unread-days_and_blocks')).toBeNull()
  })

})

// T306 — THE ROW THAT ASKED A QUESTION AND COULD NOT TAKE THE ANSWER.
//
// attentionList.js builds "We have this camper's choices but not their name — who is
// this?" and puts the subject's id inside the row id. But screenForAttentionRow had no
// case for sourceKind 'unattributed-camper', so it fell through to
// screenForNode('Campers'), DOMAIN_SCREEN has no Campers key, it returned null, and
// RootsHomeScreen rendered the row as a plain div with no onClick. Inert for EVERY
// role, admin included. These drive the RENDERED row.
describe('T306 — naming an unnamed submission from the Roots home', () => {
  const SUBJECT = { id: 'sub-1', display_name: 'planner', is_unattributed: 1, external_id: 'hash-a' }

  function renderWithUnnamedSubject(overrides = {}) {
    const collections = collectionsFor({ campers: [SUBJECT], ...overrides })
    localClient.list.mockImplementation((entity) => Promise.resolve(collections[entity] ?? []))
    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
  }

  it('renders the unnamed-subject row as something a director can act on', async () => {
    renderWithUnnamedSubject()
    // The row is a BUTTON. Before T306 this same row rendered as a div with no
    // onClick, so this assertion is the inversion of the defect rather than a
    // restatement of the old behaviour.
    const row = await screen.findByRole('button', { name: /but not their name/i })
    expect(row).not.toBeNull()
  })

  it('names the subject the row carries, and refreshes so the row does not linger', async () => {
    localClient.attributeSubject.mockResolvedValue({ ok: true, camperId: 'camper-real' })
    renderWithUnnamedSubject()
    fireEvent.click(await screen.findByRole('button', { name: /but not their name/i }))

    const input = await screen.findByLabelText(/Camper.s name/i)
    fireEvent.change(input, { target: { value: '  Aviva Feldspar  ' } })
    const callsBefore = localClient.list.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /Save name/i }))

    // THE SUBJECT ID, not a name lookup: the row id carries which subject this is,
    // and naming the wrong one would attribute a different child's answers.
    await waitFor(() =>
      expect(localClient.attributeSubject).toHaveBeenCalledWith({
        subjectId: 'sub-1',
        displayName: 'Aviva Feldspar',
      }),
    )
    // A write made on this device never crosses the sync channel, so without an
    // explicit reload the named camper's row would sit there and the director would
    // read their own success as a failure.
    await waitFor(() => expect(localClient.list.mock.calls.length).toBeGreaterThan(callsBefore))
    expect(screen.queryByLabelText(/Camper.s name/i)).toBeNull()
  })

  it('SURFACES a refusal the op returns rather than reading it as success', async () => {
    // attributeElectiveSubject declines an already-named camper by RETURN VALUE, not
    // by throwing. A caller that only try/catches closes the dialog and reports
    // success — the swallowed-failure class this repo keeps ruling against.
    localClient.attributeSubject.mockResolvedValue({
      ok: false,
      error: 'Ari Green is not an unattributed subject, so there is no name to fill in.',
    })
    renderWithUnnamedSubject()
    fireEvent.click(await screen.findByRole('button', { name: /but not their name/i }))
    fireEvent.change(await screen.findByLabelText(/Camper.s name/i), { target: { value: 'Ari Green' } })
    fireEvent.click(screen.getByRole('button', { name: /Save name/i }))

    // The op's OWN sentence, not a generic message: it names the reason.
    await waitFor(() => expect(screen.queryByText(/not an unattributed subject/i)).not.toBeNull())
    // And the dialog stays open, because nothing was saved.
    expect(screen.queryByLabelText(/Camper.s name/i)).not.toBeNull()
  })
})
