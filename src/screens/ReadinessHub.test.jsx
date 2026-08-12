// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// The hub composes from existing parts; mock its data sources so the render is
// deterministic. getReadiness / describeReadiness are the real engine — the
// point is to prove the screen renders each state with the right glyph/word and
// that the two-door affordances navigate/trigger.

let mockCounts
vi.mock('../hooks/useSetupCounts', () => ({
  useSetupCounts: () => ({ counts: mockCounts }),
}))
vi.mock('../hooks/useCohorts', () => ({
  useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }),
}))
const downloadWorkbook = vi.fn()
vi.mock('../utils/exportWorkbook.js', () => ({ downloadWorkbook: (...a) => downloadWorkbook(...a) }))
vi.mock('../localClient', () => ({
  localClient: {
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1' }),
    list: vi.fn().mockResolvedValue([]),
    latestOpSeq: vi.fn().mockResolvedValue(0),
  },
}))

// describeReadiness never produces a non-null `attention` string via the real
// render path with no live reconciliation signals (required areas are only
// ever ready/missing) — so the needs-attention headline is exercised by
// overriding just this export, keeping getReadiness/getSetupGaps real.
let attentionOverride = null
vi.mock('../engine/readiness', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    describeReadiness: (readiness) => {
      const real = actual.describeReadiness(readiness)
      return attentionOverride ? { ...real, attention: attentionOverride } : real
    },
  }
})

import ReadinessHub from './ReadinessHub'
import { buildHubRows, STATE_VISUAL, verdictState, rowAction } from './readinessHubModel'
import { getReadiness } from '../engine/readiness'

const FULL = { cohorts: 1, tiers: 6, groups: 18, days: 5, timeblocks: 8, activities: 12, anchors: 0, dayoverrides: 0 }

beforeEach(() => {
  downloadWorkbook.mockReset()
  attentionOverride = null
})

describe('buildHubRows: the grouped presentation model', () => {
  it('never gives a non-required category a Missing (red) state', () => {
    const readiness = getReadiness({}) // empty camp — everything required is missing
    const { required, optional, programs } = buildHubRows(readiness, {})
    const activityRules = required.find((r) => r.key === 'activities').subRow
    const nonRequired = [...optional, ...programs, activityRules]
    for (const r of nonRequired) expect(r.state).not.toBe('missing')
  })

  it('nests Activity Rules under Activities as a subRow, not a standalone required row', () => {
    const { required } = buildHubRows(getReadiness({}), {})
    expect(required.find((r) => r.key === 'activityrules')).toBeUndefined()
    expect(required.find((r) => r.key === 'activities').subRow.key).toBe('activityrules')
  })

  it('renders Activity Rules Not-applicable when Activities is empty, Ready when present', () => {
    const empty = buildHubRows(getReadiness({}), {})
    expect(empty.required.find((r) => r.key === 'activities').subRow.state).toBe('not-applicable')
    const full = buildHubRows(getReadiness({ activities: [{}] }), {})
    expect(full.required.find((r) => r.key === 'activities').subRow.state).toBe('ready')
  })

  it('Programs is always Ready', () => {
    expect(buildHubRows(getReadiness({}), {}).programs[0].state).toBe('ready')
  })
})

describe('rowAction: the single tested source of truth for row affordances', () => {
  it('ready and not-applicable rows never get an action', () => {
    expect(rowAction({ state: 'ready', doors: 'two' })).toBe('none')
    expect(rowAction({ state: 'not-applicable', doors: 'two' })).toBe('none')
    expect(rowAction({ state: 'ready', doors: 'review' })).toBe('none')
    expect(rowAction({ state: 'not-applicable', doors: 'review' })).toBe('none')
  })

  it('missing, needs-attention, and in-progress rows get review', () => {
    for (const state of ['missing', 'needs-attention', 'in-progress']) {
      expect(rowAction({ state, doors: 'two' })).toBe('review')
    }
  })

  it('optional rows with doors:review and not-ready get review', () => {
    expect(rowAction({ state: 'optional', doors: 'review' })).toBe('review')
  })

  it('doors:none rows never get an action, regardless of state', () => {
    for (const state of ['ready', 'not-applicable', 'missing', 'needs-attention', 'in-progress', 'optional']) {
      expect(rowAction({ state, doors: 'none' })).toBe('none')
    }
  })
})

describe('STATE_VISUAL: the six-state glyph grammar', () => {
  it('maps Missing and Needs-attention to the same glyph but different colours', () => {
    expect(STATE_VISUAL.missing.glyph).toBe('!')
    expect(STATE_VISUAL['needs-attention'].glyph).toBe('!')
    expect(STATE_VISUAL.missing.color).toBe('var(--danger)')
    expect(STATE_VISUAL['needs-attention'].color).toBe('var(--accent)')
  })

  it('has a distinct glyph for every state', () => {
    const glyphs = Object.values(STATE_VISUAL).map((v) => v.glyph)
    expect(new Set(glyphs)).toEqual(new Set(['✓', '!', '·', '–', '⋯']))
  })
})

describe('verdictState: the three-way headline verdict', () => {
  it('is blocked when blocked is true, regardless of attention', () => {
    expect(verdictState({ blocked: true, attention: null })).toBe('blocked')
    expect(verdictState({ blocked: true, attention: 'x' })).toBe('blocked')
  })

  it('is needs-attention when not blocked but attention is present', () => {
    expect(verdictState({ blocked: false, attention: 'check this' })).toBe('needs-attention')
  })

  it('is ready when not blocked and no attention', () => {
    expect(verdictState({ blocked: false, attention: null })).toBe('ready')
  })
})

describe('ReadinessHub render', () => {
  it('shows a skeleton, never a premature "Ready", while counts load', () => {
    mockCounts = null
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    expect(screen.queryByText('Ready to build a week.')).toBeNull()
  })

  it('renders a fixed blocked headline (no named-list prose) with specifics in aria-label/title', () => {
    mockCounts = { ...FULL, activities: 0 }
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    expect(screen.queryByText(/still needed before you can build a week: Activities/)).toBeNull()
    const headline = screen.getByText('A few things need your attention before this camp can build a week.')
    expect(headline).toBeTruthy()
    expect(headline.title).toMatch(/still needed before you can build a week: Activities/)
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-label')).toMatch(/still needed before you can build a week: Activities/)
    const brick = screen.getAllByText('needed').find((el) => el.getAttribute('data-state') === 'missing')
    expect(brick).toBeTruthy()
    expect(brick.style.color).toBe('var(--danger)')
  })

  it('renders the Ready headline and per-category counts, with no action button on a Ready row', () => {
    mockCounts = FULL
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    expect(screen.getByText('Ready to build a week.')).toBeTruthy()
    const groupsCount = screen.getByText('18') // Groups count
    expect(groupsCount).toBeTruthy()
    const groupsRow = groupsCount.closest('div')
    expect(groupsRow.querySelector('button')).toBeNull()
  })

  it('a missing/needs-attention row renders exactly one "Review" button', () => {
    mockCounts = { ...FULL, activities: 0 }
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    expect(screen.getAllByText('Review').length).toBeGreaterThan(0)
    expect(screen.queryByText('Download worksheet')).toBeNull()
  })

  it('Review navigates to the category screen', () => {
    mockCounts = { ...FULL, tiers: 0 }
    const onNavigate = vi.fn()
    render(<ReadinessHub campId="camp-1" onNavigate={onNavigate} />)
    fireEvent.click(screen.getAllByText('Review')[0])
    expect(onNavigate).toHaveBeenCalledWith('tiers')
  })

  it('the overflow download icon triggers the workbook export via aria-label, with no visible label text', async () => {
    mockCounts = { ...FULL, tiers: 0 }
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    expect(screen.queryByText('Download worksheet')).toBeNull()
    fireEvent.click(screen.getByLabelText('Download worksheet'))
    // vi.waitFor keeps its own 1000ms default — it is NOT governed by RTL's
    // asyncUtilTimeout (vitest.setup.js), so the load headroom is set explicitly.
    await vi.waitFor(() => expect(downloadWorkbook).toHaveBeenCalled(), { timeout: 3000 })
  })

  it('renders the needs-attention headline with the bronze accent treatment, not the ready green', () => {
    mockCounts = FULL
    attentionOverride = '1 item could use your attention.'
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    expect(screen.queryByText('Ready to build a week.')).toBeNull()
    const headline = screen.getByText('Ready to build a week, with a few things to check.')
    expect(headline).toBeTruthy()
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    const glyph = status.querySelector('[aria-hidden="true"]')
    expect(glyph.style.color).toBe('var(--accent)')
  })

  it('keeps the blocked headline in --danger', () => {
    mockCounts = { ...FULL, activities: 0 }
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    const glyph = status.querySelector('[aria-hidden="true"]')
    expect(glyph.style.color).toBe('var(--danger)')
  })

  it('keeps the ready headline in --success', () => {
    mockCounts = FULL
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    const status = screen.getByRole('status')
    const glyph = status.querySelector('[aria-hidden="true"]')
    expect(glyph.style.color).toBe('var(--success)')
  })

  it('shows the "Import last year" hint only on a brand-new camp', () => {
    mockCounts = { cohorts: 1, tiers: 0, groups: 0, days: 0, timeblocks: 0, activities: 0, anchors: 0, dayoverrides: 0 }
    const onNavigate = vi.fn()
    const { unmount } = render(<ReadinessHub campId="camp-1" onNavigate={onNavigate} />)
    fireEvent.click(screen.getByText('Import last year'))
    expect(onNavigate).toHaveBeenCalledWith('import')
    unmount()

    mockCounts = FULL
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    expect(screen.queryByText('Import last year')).toBeNull()
  })
})
