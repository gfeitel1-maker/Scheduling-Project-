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

import ReadinessHub from './ReadinessHub'
import { buildHubRows, STATE_VISUAL } from './readinessHubModel'
import { getReadiness } from '../engine/readiness'

const FULL = { cohorts: 1, tiers: 6, groups: 18, days: 5, timeblocks: 8, activities: 12, anchors: 0, dayoverrides: 0 }

beforeEach(() => {
  downloadWorkbook.mockReset()
})

describe('buildHubRows: the grouped presentation model', () => {
  it('never gives a non-required category a Missing (red) state', () => {
    const readiness = getReadiness({}) // empty camp — everything required is missing
    const { required, optional, programs } = buildHubRows(readiness, {})
    const nonRequired = [...optional, ...programs, required.find((r) => r.key === 'activityrules')]
    for (const r of nonRequired) expect(r.state).not.toBe('missing')
  })

  it('renders Activity Rules Not-applicable when Activities is empty, Ready when present', () => {
    const empty = buildHubRows(getReadiness({}), {})
    expect(empty.required.find((r) => r.key === 'activityrules').state).toBe('not-applicable')
    const full = buildHubRows(getReadiness({ activities: [{}] }), {})
    expect(full.required.find((r) => r.key === 'activityrules').state).toBe('ready')
  })

  it('Programs is always Ready', () => {
    expect(buildHubRows(getReadiness({}), {}).programs[0].state).toBe('ready')
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

describe('ReadinessHub render', () => {
  it('shows a skeleton, never a premature "Ready", while counts load', () => {
    mockCounts = null
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    expect(screen.queryByText('Ready to build a week.')).toBeNull()
  })

  it('renders the blocking headline and a brick "needed" row when a required area is empty', () => {
    mockCounts = { ...FULL, activities: 0 }
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    expect(screen.getByText(/still needed before you can build a week: Activities/)).toBeTruthy()
    const brick = screen.getAllByText('needed').find((el) => el.getAttribute('data-state') === 'missing')
    expect(brick).toBeTruthy()
    expect(brick.style.color).toBe('var(--danger)')
  })

  it('renders the Ready headline and per-category counts when setup is complete', () => {
    mockCounts = FULL
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    expect(screen.getByText('Ready to build a week.')).toBeTruthy()
    expect(screen.getByText('18')).toBeTruthy() // Groups count
  })

  it('Review on screen navigates to the category screen', () => {
    mockCounts = FULL
    const onNavigate = vi.fn()
    render(<ReadinessHub campId="camp-1" onNavigate={onNavigate} />)
    fireEvent.click(screen.getAllByText('Review on screen')[0])
    expect(onNavigate).toHaveBeenCalledWith('tiers')
  })

  it('Download worksheet triggers the workbook export', async () => {
    mockCounts = FULL
    render(<ReadinessHub campId="camp-1" onNavigate={() => {}} />)
    fireEvent.click(screen.getAllByText('Download worksheet')[0])
    await vi.waitFor(() => expect(downloadWorkbook).toHaveBeenCalled())
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
