// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

import Sidebar from './Sidebar'

// docs/work/specs/2026-07-31-sidebar-and-setup-readiness-handoff.md §3, §5, §6, §11, §12.

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

describe('Sidebar: Roots hub with its collapsible entity children (Slice B)', () => {
  it('does not list Programs, because every camp is given one', () => {
    // Product owner, 2026-08-01: "hide programs from the sidebar and
    // auto-create main." A row a director can only ever look at is a question
    // they should not be asked.
    renderSidebar()
    expect(screen.getByText('Camp Set Up')).toBeTruthy()
    expect(screen.queryByText('Programs')).toBeNull()
  })

  it('shows Camp Set Up and Schedule — no third System section', () => {
    renderSidebar()
    expect(screen.getByText('Camp Set Up')).toBeTruthy()
    expect(screen.getByText('Schedule')).toBeTruthy()
    expect(screen.queryByText('System')).toBeNull()
  })

  it('shows Roots and its entity children by default', () => {
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

  it('the chevron toggles the child list without navigating', () => {
    const onNavigate = vi.fn()
    renderSidebar({ onNavigate })
    expect(screen.getByText('Groups')).toBeTruthy()

    fireEvent.click(screen.getByTitle('Collapse Roots'))
    expect(screen.queryByText('Groups')).toBeNull()
    expect(onNavigate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTitle('Expand Roots'))
    expect(screen.getByText('Groups')).toBeTruthy()
  })

  it('remembers whether Roots was collapsed', () => {
    const { unmount } = renderSidebar()
    fireEvent.click(screen.getByTitle('Collapse Roots'))
    unmount()

    renderSidebar()
    expect(screen.queryByText('Groups')).toBeNull()
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
    // T108 Phase 2 — the standalone Day Overrides nav entry/area is retired
    // (overrides are now authored in place on the schedule grid), so it is
    // no longer one of the optional rows this test checks.
    renderSidebar({ counts: { ...DEFAULT_COUNTS, anchors: 0, locations: 0 } })
    // Electives (Slice 1) and Events (Slice 1, docs/adr/2026-08-22-events-
    // overlay-placement.md) are the 4th and 5th optional entities, alongside
    // Locations, Fixed Events, and Special Days.
    expect(screen.getAllByText('optional').length).toBe(5)
    for (const label of ['Recurring Events', 'Locations', 'Special Days', 'Electives', 'Events']) {
      const row = screen.getByText(label).closest('button')
      expect(within(row).queryByText('!')).toBeNull()
    }
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
  it('carries the unmet count out to the collapsed header', () => {
    renderSidebar({ counts: { ...DEFAULT_COUNTS, days: 0, activities: 0 } })
    expect(screen.getByText('Days')).toBeTruthy()

    fireEvent.click(screen.getByText('Camp Set Up').closest('button'))

    expect(screen.queryByText('Days')).toBeNull()
    expect(screen.getByText('3 / 5')).toBeTruthy()
  })

  it('remembers which sections were collapsed', () => {
    const { unmount } = renderSidebar()
    expect(screen.getByText('Groups')).toBeTruthy()
    fireEvent.click(screen.getByText('Camp Set Up').closest('button'))
    unmount()

    renderSidebar()
    expect(screen.getByText('Camp Set Up')).toBeTruthy()
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
      sections: { setup: true, schedule: true }, offered: true,
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
