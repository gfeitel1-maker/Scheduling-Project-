// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

import Sidebar from './Sidebar'

// docs/adr/2026-08-28-stage-aware-nav-landing.md Decision 3,
// docs/work/specs/2026-08-28-lifecycle-ia-program.md §3 — the five-stage
// lifecycle IA: Roots is a fixed, chevron-less top row; the former Camp Set
// Up/Schedule two-section model is replaced by three collapsible stages —
// Germination / Sprouts / Plants.

const DEFAULT_COUNTS = {
  cohorts: 1, tiers: 4, groups: 14, days: 5, timeblocks: 6, activities: 8,
  anchors: 0, dayoverrides: 0, locations: 0,
}

let storage
beforeEach(() => {
  storage = {}
  vi.stubGlobal('localStorage', {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = v },
    removeItem: (k) => { delete storage[k] },
  })
})

function renderSidebar(props = {}) {
  return render(
    <Sidebar
      current="groups"
      onNavigate={() => {}}
      campId="camp-1"
      role="admin"
      badges={{}}
      counts={DEFAULT_COUNTS}
      startedRoutes={0}
      campName="Camp Test"
      syncStatus={null}
      projectPath={null}
      isDevDb={false}
      buildLabel={null}
      backupStatus={null}
      handleBackupNow={() => {}}
      offerShown={false}
      setOfferShown={() => {}}
      {...props}
    />
  )
}

describe('Sidebar: Roots — fixed, chevron-less top row (ADR Decision 3)', () => {
  it('does not list Programs, because every camp is given one', () => {
    // Product owner, 2026-08-01: "hide programs from the sidebar and
    // auto-create main." A row a director can only ever look at is a question
    // they should not be asked.
    renderSidebar()
    expect(screen.getByText('Roots')).toBeTruthy()
    expect(screen.queryByText('Programs')).toBeNull()
  })

  it('shows Germination, Sprouts and Plants — no third System section', () => {
    renderSidebar()
    expect(screen.getByText('Germination')).toBeTruthy()
    expect(screen.getByText('Sprouts')).toBeTruthy()
    expect(screen.getByText('Plants')).toBeTruthy()
    expect(screen.queryByText('System')).toBeNull()
    expect(screen.queryByText('Camp Set Up')).toBeNull()
    expect(screen.queryByText('Schedule')).toBeNull()
  })

  it('shows Roots always, alongside the stage rows', () => {
    renderSidebar()
    expect(screen.getByText('Roots')).toBeTruthy()
    expect(screen.getByText('Groups')).toBeTruthy()
    expect(screen.getByText('Activities')).toBeTruthy()
  })

  it('clicking Roots navigates to the roots screen', () => {
    const onNavigate = vi.fn()
    renderSidebar({ onNavigate })
    fireEvent.click(screen.getByText('Roots').closest('button'))
    expect(onNavigate).toHaveBeenCalledWith('roots')
  })

  it('carries no chevron/toggle button for Roots — it has no fold state', () => {
    renderSidebar()
    expect(screen.queryByTitle('Collapse Roots')).toBeNull()
    expect(screen.queryByTitle('Expand Roots')).toBeNull()
  })

  it('marks a complete area with a tick and its count', () => {
    renderSidebar()
    expect(screen.getByText('14')).toBeTruthy()
    const groupsRow = screen.getByText('Groups').closest('button')
    expect(within(groupsRow).getByText('✓')).toBeTruthy()
  })

  it('marks a missing required area as needed, never as a count of zero', () => {
    renderSidebar({ counts: { ...DEFAULT_COUNTS, days: 0 } })
    expect(screen.getByText('needed')).toBeTruthy()
    const daysRow = screen.getByText('Days').closest('button')
    expect(within(daysRow).getByText('!')).toBeTruthy()
    expect(within(daysRow).queryByText('0')).toBeNull()
  })

  it('never shows the blocking mark on an optional area', () => {
    // A camp with no locations is finished, not unfinished. Marking it
    // otherwise trains directors to ignore the mark that matters.
    // Fixed Events/Recurring Events are not among these: they are
    // `expected`, not `optional` (see the dedicated describe block below) —
    // they read "attention", not "optional", though they still never show '!'.
    renderSidebar({ counts: { ...DEFAULT_COUNTS, anchors: 0, locations: 0 } })
    // Electives (Slice 1) and Events (Slice 1, docs/adr/2026-08-22-events-
    // overlay-placement.md) are the 3rd and 4th optional entities, alongside
    // Locations and Special Days.
    expect(screen.getAllByText('optional').length).toBe(4)
    for (const label of ['Locations', 'Special Days', 'Electives', 'Events']) {
      const row = screen.getByText(label).closest('button')
      expect(within(row).queryByText('!')).toBeNull()
    }
  })
})

describe('Sidebar: Fixed Events and Recurring Events are two separate, expected rows (not merely optional)', () => {
  it('reads "attention" (not "optional", not the blocking "needed") when a camp has zero recurring events', () => {
    renderSidebar({ counts: { ...DEFAULT_COUNTS, anchors: 0 } })
    const anchorsRow = screen.getByText('Recurring Events').closest('button')
    expect(within(anchorsRow).getByText('attention')).toBeTruthy()
    expect(within(anchorsRow).queryByText('!')).toBeNull()
    expect(within(anchorsRow).queryByText('optional')).toBeNull()
  })

  it('reads its count, like a required area, once it has recurring events', () => {
    renderSidebar({ counts: { ...DEFAULT_COUNTS, anchors: 3 } })
    const anchorsRow = screen.getByText('Recurring Events').closest('button')
    expect(within(anchorsRow).getByText('3')).toBeTruthy()
    expect(within(anchorsRow).getByText('✓')).toBeTruthy()
  })

  it('lists Fixed Events as its own row, distinct from Recurring Events', () => {
    const onNavigate = vi.fn()
    renderSidebar({ onNavigate })
    expect(screen.getByText('Fixed Events')).toBeTruthy()
    fireEvent.click(screen.getByText('Fixed Events').closest('button'))
    expect(onNavigate).toHaveBeenCalledWith('fixedevents')
  })
})

describe('Sidebar: Events and Special Days read as one family under a shared heading (override-family-model ADR §6c)', () => {
  it('renders a "Special Events" heading among the Sprouts rows', () => {
    renderSidebar()
    expect(screen.getByText('Special Events')).toBeTruthy()
  })

  it('keeps Events and Special Days as their own navigable rows under the heading', () => {
    const onNavigate = vi.fn()
    renderSidebar({ onNavigate })
    fireEvent.click(screen.getByText('Events').closest('button'))
    expect(onNavigate).toHaveBeenCalledWith('events')

    fireEvent.click(screen.getByText('Special Days').closest('button'))
    expect(onNavigate).toHaveBeenCalledWith('specialdays')
  })

  it('does not treat the heading itself as a navigable row', () => {
    const onNavigate = vi.fn()
    renderSidebar({ onNavigate })
    fireEvent.click(screen.getByText('Special Events'))
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('gives the heading no count, checkmark, or optional affordance', () => {
    renderSidebar()
    const heading = screen.getByText('Special Events')
    expect(within(heading.closest('div')).queryByText('optional')).toBeNull()
    expect(within(heading.closest('div')).queryByText('✓')).toBeNull()
  })
})

describe('Sidebar: neither schedule is canonical — both routes stay distinct rows (ADR §3, guard against re-collapse)', () => {
  it('renders both routes as their own rows, with identical style props', () => {
    renderSidebar({ current: 'trash' })
    const generated = screen.getByText('Generated Schedule').closest('button')
    const manual = screen.getByText('Manual Build').closest('button')
    expect(generated).toBeTruthy()
    expect(manual).toBeTruthy()
    // Style equality is the assertion: any visual difference between the two
    // reads as one being the real schedule.
    expect(generated.getAttribute('style')).toBe(manual.getAttribute('style'))
  })

  it('does not render a single collapsed "Schedule" row in place of the two routes', () => {
    renderSidebar({ current: 'trash' })
    expect(screen.queryByRole('button', { name: 'Schedule' })).toBeNull()
  })

  it('gives neither route a mark or a count that the other lacks', () => {
    renderSidebar({ current: 'trash' })
    const generated = screen.getByText('Generated Schedule').closest('button')
    const manual = screen.getByText('Manual Build').closest('button')
    expect(generated.textContent).toBe('Generated Schedule')
    expect(manual.textContent).toBe('Manual Build')
  })
})

describe('Sidebar: Plants is pinned — its schedule rows can never be hidden (WS5 S1)', () => {
  // Owner, 2026-08-29: "the 4 sidebar rows should be visible so you can see
  // which one you are in." Route legibility lives in the sidebar highlight,
  // so the section that holds the four schedule rows must never collapse them
  // out of view — otherwise a director can be inside Generated with nothing
  // on screen telling them so. Germination/Sprouts keep their collapse (the
  // tuck-away-setup affordance); only Plants is pinned.
  const PLANTS_ROWS = ['Generated Schedule', 'Manual Build', 'Special Schedules', 'Elective Schedules']

  it('carries no collapse/expand toggle for Plants', () => {
    renderSidebar()
    expect(screen.queryByTitle('Collapse Plants')).toBeNull()
    expect(screen.queryByTitle('Expand Plants')).toBeNull()
  })

  it('shows all four schedule rows by default', () => {
    renderSidebar()
    for (const label of PLANTS_ROWS) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('shows the four rows even when persisted state marks Plants collapsed', () => {
    // Stale localStorage from before Plants was pinned must not hide the rows.
    storage['shoresh-sidebar-state'] = JSON.stringify({
      sections: { germination: true, sprouts: true, plants: false }, offered: true,
    })
    renderSidebar()
    for (const label of PLANTS_ROWS) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('still highlights the active schedule row so the current route is legible', () => {
    renderSidebar({ current: 'schedule:generated' })
    const generated = screen.getByText('Generated Schedule').closest('button')
    const manual = screen.getByText('Manual Build').closest('button')
    // The active row diverges in style from an inactive sibling — that
    // divergence IS the "which schedule am I in" signal.
    expect(generated.getAttribute('style')).not.toBe(manual.getAttribute('style'))
    expect(generated.getAttribute('style')).toContain('var(--primary)')
  })
})

describe('Sidebar: System items live behind the Settings gear', () => {
  it('does not show Camp/Conflicts/Trash/LAN & Devices in the main nav', () => {
    renderSidebar()
    expect(screen.queryByText('Camp')).toBeNull()
    expect(screen.queryByText('Conflicts')).toBeNull()
    expect(screen.queryByText('Trash')).toBeNull()
    expect(screen.queryByText('LAN & Devices')).toBeNull()
  })

  it('reveals them from the Settings gear', () => {
    renderSidebar()
    fireEvent.click(screen.getByTitle('Settings'))
    expect(screen.getByText('Camp')).toBeTruthy()
    expect(screen.getByText('Conflicts')).toBeTruthy()
    expect(screen.getByText('Trash')).toBeTruthy()
    expect(screen.getByText('LAN & Devices')).toBeTruthy()
  })

  it('lists Re-import last year in the Settings gear (Slice C: import recedes here once a camp has data)', () => {
    renderSidebar()
    fireEvent.click(screen.getByTitle('Settings'))
    expect(screen.getByText('Re-import last year')).toBeTruthy()
  })

  it('navigating to Re-import last year from the gear routes to the import screen', () => {
    const onNavigate = vi.fn()
    renderSidebar({ onNavigate })
    fireEvent.click(screen.getByTitle('Settings'))
    fireEvent.click(screen.getByText('Re-import last year'))
    expect(onNavigate).toHaveBeenCalledWith('import')
  })

  it('hides LAN & Devices from a non-admin role', () => {
    renderSidebar({ role: 'staff' })
    fireEvent.click(screen.getByTitle('Settings'))
    expect(screen.getByText('Camp')).toBeTruthy()
    expect(screen.queryByText('LAN & Devices')).toBeNull()
  })

  it('keeps the conflicts badge visible on the gear so nothing time-sensitive hides', () => {
    renderSidebar({ badges: { conflicts: 2 } })
    expect(screen.getByTitle('Settings').textContent).toMatch(/2/)
  })

  it('navigating from the gear closes the menu', () => {
    const onNavigate = vi.fn()
    renderSidebar({ onNavigate })
    fireEvent.click(screen.getByTitle('Settings'))
    fireEvent.click(screen.getByText('Trash'))
    expect(onNavigate).toHaveBeenCalledWith('trash')
    expect(screen.queryByText('Trash')).toBeNull()
  })
})

describe('Sidebar: collapsing never hides a problem', () => {
  it('carries the unmet count out to the collapsed Germination header', () => {
    renderSidebar({ counts: { ...DEFAULT_COUNTS, days: 0 } })
    expect(screen.getByText('Days')).toBeTruthy()

    fireEvent.click(screen.getByText('Germination').closest('button'))

    expect(screen.queryByText('Days')).toBeNull()
    expect(screen.getByText('3 / 4')).toBeTruthy()
  })

  it('remembers which sections were collapsed', () => {
    const { unmount } = renderSidebar()
    expect(screen.getByText('Groups')).toBeTruthy()
    fireEvent.click(screen.getByText('Germination').closest('button'))
    unmount()

    renderSidebar()
    expect(screen.getByText('Germination')).toBeTruthy()
    expect(screen.queryByText('Groups')).toBeNull()
  })
})

describe('Sidebar: the tuck-away offer', () => {
  it('does not show when offerShown is false', () => {
    renderSidebar({ offerShown: false })
    expect(screen.queryByText(/Setup looks complete/)).toBeNull()
  })

  it('shows the offer when offerShown is true and sidebar.offered is false', () => {
    renderSidebar({ offerShown: true })
    expect(screen.getByText(/Setup looks complete/)).toBeTruthy()
  })

  it('remembers "keep open" as firmly as "tuck away"', () => {
    // A director who said no must not be asked again next week. That is the
    // same silent imposition in slower motion. sidebar.offered=true means
    // offerOpen=false even when offerShown=true.
    storage['shoresh-sidebar-state'] = JSON.stringify({
      sections: { germination: true, sprouts: true, plants: true }, offered: true,
    })
    renderSidebar({ offerShown: true })
    expect(screen.queryByText(/Setup looks complete/)).toBeNull()
  })
})

describe('Sidebar: scale', () => {
  it('does not grow a row per group', () => {
    // A camp runs 1 to 100 groups. Rows are per area, so the count is fixed.
    const { unmount } = renderSidebar({ counts: { ...DEFAULT_COUNTS, groups: 1 } })
    expect(screen.getByText('Groups')).toBeTruthy()
    const few = screen.getAllByRole('button').length
    unmount()

    renderSidebar({ counts: { ...DEFAULT_COUNTS, groups: 100 } })
    expect(screen.getByText('100')).toBeTruthy()
    expect(screen.getAllByRole('button').length).toBe(few)
  })
})
