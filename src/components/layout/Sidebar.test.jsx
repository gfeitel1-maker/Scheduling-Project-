// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

vi.mock('../../localClient', () => ({
  localClient: {
    list: vi.fn(),
    getCamp: vi.fn(),
    onOpApplied: vi.fn(() => () => {}),
    getCurrentProject: vi.fn(),
    backupProject: vi.fn(),
  },
}))

import Sidebar from './Sidebar'
import { localClient } from '../../localClient'

// docs/work/specs/2026-07-31-sidebar-and-setup-readiness-handoff.md §3, §5, §6, §11, §12.

const TABLE = {
  cohorts: 'cohorts', tiers: 'tiers', groups: 'groups', days: 'days_of_operation',
  timeblocks: 'time_blocks', activities: 'activities',
  anchors: 'anchor_activities', dayoverrides: 'day_override_templates',
}

function mockCounts(over = {}) {
  const counts = {
    cohorts: 1, tiers: 4, groups: 14, days: 5, timeblocks: 6, activities: 8,
    anchors: 0, dayoverrides: 0, ...over,
  }
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `x${i}`, camp_id: 'camp-1' }))
  const store = {}
  for (const [area, table] of Object.entries(TABLE)) store[table] = rows(counts[area])
  localClient.list.mockImplementation((t) => Promise.resolve(store[t] ?? []))
}

let storage
beforeEach(() => {
  vi.clearAllMocks()
  storage = {}
  vi.stubGlobal('localStorage', {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = v },
    removeItem: (k) => { delete storage[k] },
  })
  localClient.getCamp.mockResolvedValue({ name: 'Camp Test' })
  localClient.onOpApplied.mockReturnValue(() => {})
  localClient.getCurrentProject.mockResolvedValue({ path: null, isDev: true, build: null })
  localClient.backupProject.mockResolvedValue({ status: 'ok' })
  mockCounts()
})

function renderSidebar(props = {}) {
  return render(
    <Sidebar current="groups" onNavigate={() => {}} campId="camp-1" role="admin" badges={{}} {...props} />
  )
}

describe('Sidebar: the three sections', () => {
  it('does not list Programs, because every camp is given one', async () => {
    // Product owner, 2026-08-01: "hide programs from the sidebar and
    // auto-create main." A row a director can only ever look at is a question
    // they should not be asked.
    renderSidebar()
    await waitFor(() => expect(screen.getByText('Camp Set Up')).toBeTruthy())
    expect(screen.queryByText('Programs')).toBeNull()
  })

  it('shows Camp Set Up, Schedule and System', async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByText('Camp Set Up')).toBeTruthy())
    expect(screen.getByText('Schedule')).toBeTruthy()
    expect(screen.getByText('System')).toBeTruthy()
  })

  it('marks a complete area with a tick and its count', async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByText('14')).toBeTruthy())
    const groupsRow = screen.getByText('Groups').closest('button')
    expect(within(groupsRow).getByText('✓')).toBeTruthy()
  })

  it('marks a missing required area as needed, never as a count of zero', async () => {
    mockCounts({ days: 0 })
    renderSidebar()
    await waitFor(() => expect(screen.getByText('needed')).toBeTruthy())
    const daysRow = screen.getByText('Days').closest('button')
    expect(within(daysRow).getByText('!')).toBeTruthy()
    expect(within(daysRow).queryByText('0')).toBeNull()
  })

  it('never shows the blocking mark on an optional area', async () => {
    // A camp with no day overrides is finished, not unfinished. Marking it
    // otherwise trains directors to ignore the mark that matters.
    mockCounts({ anchors: 0, dayoverrides: 0 })
    renderSidebar()
    await waitFor(() => expect(screen.getAllByText('optional').length).toBe(2))
    for (const label of ['Fixed Events', 'Day Overrides']) {
      const row = screen.getByText(label).closest('button')
      expect(within(row).queryByText('!')).toBeNull()
    }
  })
})

describe('Sidebar: neither schedule is canonical', () => {
  it('renders both routes with identical style props', async () => {
    renderSidebar({ current: 'trash' })
    await waitFor(() => expect(screen.getByText('Generated Schedule')).toBeTruthy())
    const generated = screen.getByText('Generated Schedule').closest('button')
    const manual = screen.getByText('Manual Build').closest('button')
    // Style equality is the assertion: any visual difference between the two
    // reads as one being the real schedule.
    expect(generated.getAttribute('style')).toBe(manual.getAttribute('style'))
  })

  it('gives neither route a mark or a count that the other lacks', async () => {
    renderSidebar({ current: 'trash' })
    await waitFor(() => expect(screen.getByText('Generated Schedule')).toBeTruthy())
    const generated = screen.getByText('Generated Schedule').closest('button')
    const manual = screen.getByText('Manual Build').closest('button')
    expect(generated.textContent).toBe('Generated Schedule')
    expect(manual.textContent).toBe('Manual Build')
  })
})

describe('Sidebar: collapsing never hides a problem', () => {
  it('carries the unmet count out to the collapsed header', async () => {
    mockCounts({ days: 0, activities: 0 })
    renderSidebar()
    await waitFor(() => expect(screen.getByText('Days')).toBeTruthy())

    fireEvent.click(screen.getByText('Camp Set Up').closest('button'))

    expect(screen.queryByText('Days')).toBeNull()
    expect(screen.getByText('3 / 5')).toBeTruthy()
  })

  it('rolls the conflicts badge up to a collapsed System header', async () => {
    renderSidebar({ badges: { conflicts: 2 } })
    await waitFor(() => expect(screen.getByText('Conflicts')).toBeTruthy())

    fireEvent.click(screen.getByText('System').closest('button'))
    expect(screen.queryByText('Conflicts')).toBeNull()
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('remembers which sections were collapsed', async () => {
    const { unmount } = renderSidebar()
    await waitFor(() => expect(screen.getByText('Groups')).toBeTruthy())
    fireEvent.click(screen.getByText('Camp Set Up').closest('button'))
    unmount()

    renderSidebar()
    await waitFor(() => expect(screen.getByText('Camp Set Up')).toBeTruthy())
    expect(screen.queryByText('Groups')).toBeNull()
  })
})

describe('Sidebar: the tuck-away offer', () => {
  it('does not ask on load, however complete the camp is', async () => {
    // Setup never folds itself silently, and never greets a returning director
    // with a question they already answered by finishing.
    renderSidebar()
    await waitFor(() => expect(screen.getByText('Groups')).toBeTruthy())
    expect(screen.queryByText(/Setup looks complete/)).toBeNull()
  })

  it('does not ask while anything is still needed', async () => {
    mockCounts({ days: 0 })
    renderSidebar()
    await waitFor(() => expect(screen.getByText('needed')).toBeTruthy())
    expect(screen.queryByText(/Setup looks complete/)).toBeNull()
  })

  it('remembers "keep open" as firmly as "tuck away"', async () => {
    // A director who said no must not be asked again next week. That is the
    // same silent imposition in slower motion.
    storage['shoresh-sidebar-state'] = JSON.stringify({
      sections: { setup: true, schedule: true, system: true }, offered: true,
    })
    renderSidebar()
    await waitFor(() => expect(screen.getByText('Groups')).toBeTruthy())
    expect(screen.queryByText(/Setup looks complete/)).toBeNull()
  })
})

describe('Sidebar: scale', () => {
  it('does not grow a row per group', async () => {
    // A camp runs 1 to 100 groups. Rows are per area, so the count is fixed.
    mockCounts({ groups: 1 })
    const { unmount } = renderSidebar()
    await waitFor(() => expect(screen.getByText('Groups')).toBeTruthy())
    const few = screen.getAllByRole('button').length
    unmount()

    mockCounts({ groups: 100 })
    renderSidebar()
    await waitFor(() => expect(screen.getByText('100')).toBeTruthy())
    expect(screen.getAllByRole('button').length).toBe(few)
  })
})
