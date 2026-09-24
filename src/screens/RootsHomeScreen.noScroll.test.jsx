// @vitest-environment jsdom
//
// T237 — pins the rail's real property, not a row count: the attention rail
// must not introduce page scroll (scrollHeight <= clientHeight), at more
// than one viewport height, with the cap coming from measured layout.
//
// jsdom does not run a real layout engine — every element's
// getBoundingClientRect() is zeroed by default, so `scrollHeight ===
// clientHeight` would trivially hold (0 === 0) for ANY implementation,
// including a broken one. This mocks getBoundingClientRect for the rail's
// list container and its row children with fixed, known dimensions — the
// SAME geometry useMeasuredRowCap (src/styles/shared.js) itself reads — so
// the resulting row count is driven by the real algorithm under test, and
// scrollHeight/clientHeight are then reconstructed from that real,
// algorithm-chosen output plus the known per-row height, rather than typed
// in as a fixed number.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

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
const RAIL_TOP = 140 // a plausible offset below the page header/bento
const ROW_HEIGHT = 90 // a plausible rendered row height (name + wrapping "why" line)
const OVERFLOW_HEIGHT = 40

// A LOT of open reconciliation decisions — enough that at NO plausible
// viewport height do they all fit, so the cap is always doing real work.
function manyOpenDecisions(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `dec-${i}`,
    kind: 'confirm_value',
    domain_key: 'Scheduling',
    child_key: 'Activities',
    entity_id: `a${i}`,
    entity_name: `Row ${String(i).padStart(2, '0')}`,
    reason: 'Needs review.',
  }))
}

function mockRailLayout() {
  const orig = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    const rail = document.querySelector('[data-testid="attention-rail-list"]')
    if (this === rail) {
      return { top: RAIL_TOP, bottom: RAIL_TOP, left: 0, right: 0, width: 0, height: 0, x: 0, y: RAIL_TOP, toJSON() {} }
    }
    if (rail && this.parentElement === rail) {
      const h = this.dataset.testid === 'attention-overflow' ? OVERFLOW_HEIGHT : ROW_HEIGHT
      return { top: 0, bottom: h, left: 0, right: 0, width: 0, height: h, x: 0, y: 0, toJSON() {} }
    }
    return orig.call(this)
  }
  return () => {
    Element.prototype.getBoundingClientRect = orig
  }
}

beforeEach(() => {
  localClient.list.mockReset().mockResolvedValue([])
  localClient.getCamp.mockReset().mockResolvedValue({ id: CAMP_ID })
  localClient.latestOpSeq.mockReset().mockResolvedValue(5)
  localClient.listOpenReconciliationDecisions.mockReset().mockResolvedValue(manyOpenDecisions(30))
  localClient.dismissOpenReconciliationDecisions.mockReset().mockResolvedValue({ ok: true, dismissed: 0 })
  stubMatchMedia(false)
})

afterEach(() => {
  delete window.matchMedia
})

async function renderAndMeasure(innerHeight) {
  // Two renders within one test (the "compare two viewport heights" case
  // below) must not leave two mounted trees at once — the layout mock
  // looks up the rail via a single document.querySelector, which would
  // pick up the wrong instance otherwise.
  cleanup()
  window.innerHeight = innerHeight
  const restoreLayout = mockRailLayout()
  try {
    render(<RootsHomeScreen campId={CAMP_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByTestId('attention-rail-list')).not.toBeNull())
    // Let useMeasuredRowCap's layout effect settle before reading the DOM.
    const railList = await waitFor(() => {
      const el = screen.getByTestId('attention-rail-list')
      expect(el.children.length).toBeGreaterThan(0)
      return el
    })
    const children = Array.from(railList.children)
    const scrollHeight = RAIL_TOP + children.reduce(
      (sum, el) => sum + (el.dataset.testid === 'attention-overflow' ? OVERFLOW_HEIGHT : ROW_HEIGHT),
      0,
    )
    return { scrollHeight, rowCount: children.filter((el) => el.dataset.testid !== 'attention-overflow').length }
  } finally {
    restoreLayout()
  }
}

describe('RootsHomeScreen attention rail — no page scroll (T237)', () => {
  it('keeps scrollHeight <= clientHeight at 1280x720', async () => {
    const clientHeight = 720
    const { scrollHeight, rowCount } = await renderAndMeasure(clientHeight)
    expect(scrollHeight).toBeLessThanOrEqual(clientHeight)
    expect(rowCount).toBeLessThan(30) // real cap did work, not "show everything"
  })

  it('keeps scrollHeight <= clientHeight at a much shorter viewport, with fewer rows than at 720 (not a hardcoded count)', async () => {
    const tall = await renderAndMeasure(720)
    const short = await renderAndMeasure(340)

    expect(short.scrollHeight).toBeLessThanOrEqual(340)
    expect(tall.scrollHeight).toBeLessThanOrEqual(720)
    expect(short.rowCount).toBeLessThan(tall.rowCount)
  })
})
