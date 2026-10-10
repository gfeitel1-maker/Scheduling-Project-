// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ActivityPalette from './ActivityPalette'

const activities = [
  { id: 'a1', name: 'Swimming', min_per_week: 3, max_per_week: 5 },
  { id: 'a2', name: 'Archery', min_per_week: 2, max_per_week: 4 },
  { id: 'a3', name: 'Free Play', min_per_week: null, max_per_week: null },
  { id: 'a4', name: 'Arts and Crafts', min_per_week: 1, max_per_week: 2 },
]

// a1 Swimming: 3 slots scheduled -> met target (3 >= 3) -> Placed
// a2 Archery: 1 slot scheduled -> below target (1 < 2) -> Still needed
// a3 Free Play: no target -> always Placed/available
// a4 Arts and Crafts: 0 slots -> below target (0 < 1) -> Still needed
const slots = [
  { activity_id: 'a1', is_fixed_event: false },
  { activity_id: 'a1', is_fixed_event: false },
  { activity_id: 'a1', is_fixed_event: false },
  { activity_id: 'a2', is_fixed_event: false },
]

function renderPalette(extraProps = {}) {
  return render(
    <ActivityPalette
      activities={activities}
      slots={slots}
      groups={[{ id: 'g1', tier_id: 't1' }]}
      draggable
      {...extraProps}
    />
  )
}

describe('ActivityPalette — Ledger + Filter', () => {
  it('renders a labeled filter input', () => {
    renderPalette()
    expect(screen.getByRole('textbox', { name: /filter/i })).not.toBeNull()
  })

  it('narrows visible chips by name as the user types', async () => {
    renderPalette()
    const input = screen.getByRole('textbox', { name: /filter/i })
    await userEvent.type(input, 'arch')
    expect(screen.getByText('Archery')).not.toBeNull()
    expect(screen.queryByText('Swimming')).toBeNull()
    expect(screen.queryByText('Free Play')).toBeNull()
    expect(screen.queryByText('Arts and Crafts')).toBeNull()
  })

  it('filter match is case-insensitive substring', async () => {
    renderPalette()
    const input = screen.getByRole('textbox', { name: /filter/i })
    await userEvent.type(input, 'SWIM')
    expect(screen.getByText('Swimming')).not.toBeNull()
    expect(screen.queryByText('Archery')).toBeNull()
  })

  it('groups an activity below target into "Still needed"', () => {
    renderPalette()
    const needed = screen.getByTestId('palette-zone-needed')
    expect(within(needed).getByText('Archery')).not.toBeNull()
    expect(within(needed).getByText('Arts and Crafts')).not.toBeNull()
  })

  it('groups an activity that met target into "Placed"', () => {
    renderPalette()
    const placed = screen.getByTestId('palette-zone-placed')
    expect(within(placed).getByText('Swimming')).not.toBeNull()
  })

  it('never puts a targetless activity in "Still needed"', () => {
    renderPalette()
    const needed = screen.getByTestId('palette-zone-needed')
    const placed = screen.getByTestId('palette-zone-placed')
    expect(within(needed).queryByText('Free Play')).toBeNull()
    expect(within(placed).getByText('Free Play')).not.toBeNull()
  })

  it('DOM order: "Still needed" zone precedes "Placed" zone', () => {
    renderPalette()
    const needed = screen.getByTestId('palette-zone-needed')
    const placed = screen.getByTestId('palette-zone-placed')
    expect(needed.compareDocumentPosition(placed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps chips draggable — palette activity attribute present when draggable', () => {
    renderPalette({ draggable: true })
    const chip = screen.getByText('Swimming').closest('[data-palette-activity]')
    expect(chip).not.toBeNull()
    expect(chip.getAttribute('data-palette-activity')).toBe('a1')
  })

  it('shows a quiet no-matches state when the filter yields nothing', async () => {
    renderPalette()
    const input = screen.getByRole('textbox', { name: /filter/i })
    await userEvent.type(input, 'zzzznomatch')
    expect(screen.getByText(/no matches/i)).not.toBeNull()
    expect(screen.queryByTestId('palette-zone-needed')).toBeNull()
    expect(screen.queryByTestId('palette-zone-placed')).toBeNull()
  })
})

// Packaged-app audit #24: the counter is the WEEK's count against the weekly
// range, scoped to the selected group, or the whole camp with no group.
describe('ActivityPalette — weekly counter', () => {
  const swim = [{ id: 'a1', name: 'Swimming', min_per_week: 3, max_per_week: 5 }]
  const week = ['d1', 'd2', 'd3', 'd4', 'd5'].flatMap(day => [
    { group_id: 'g1', day_id: day, activity_id: 'a1', is_fixed_event: 0 },
    { group_id: 'g2', day_id: day, activity_id: 'a1', is_fixed_event: 0 },
  ])
  const twoGroups = [{ id: 'g1', tier_id: 't1' }, { id: 'g2', tier_id: 't1' }]
  const counter = () => screen.getByTestId('palette-count-a1').textContent

  it('counts the selected group across the whole week, not one day', () => {
    render(<ActivityPalette activities={swim} slots={week} groupId="g1" groups={twoGroups} />)
    expect(counter()).toBe('5 / 3–5 wk')
  })

  it('counts the whole camp against the camp-wide range with no group', () => {
    render(<ActivityPalette activities={swim} slots={week} groupId={null} groups={twoGroups} />)
    expect(counter()).toBe('10 / 6–10 wk')
  })

  it('scales the camp-wide range by the groups ELIGIBLE for the activity', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, tier_id: 't1' }))
    const narrow = [{ ...swim[0], eligible_group_ids: ['g1', 'g2'] }]
    render(<ActivityPalette activities={narrow} slots={week} groupId={null} groups={eight} />)
    expect(counter()).toBe('10 / 6–10 wk')
  })

  it('counts a double block once — span heads only', () => {
    const double = [
      { group_id: 'g1', day_id: 'd1', activity_id: 'a1', is_fixed_event: 0, is_span_head: 1 },
      { group_id: 'g1', day_id: 'd1', activity_id: 'a1', is_fixed_event: 0, is_span_head: 0 },
    ]
    render(<ActivityPalette activities={swim} slots={double} groupId="g1" groups={twoGroups} />)
    expect(counter()).toBe('1 / 3–5 wk')
  })

  it('one counter, no second target line', () => {
    render(<ActivityPalette activities={swim} slots={week} groupId="g1" groups={twoGroups} />)
    expect(screen.queryByText(/this week/)).toBeNull()
  })
})

describe('ActivityPalette — Elective sets section (audit-2 A9)', () => {
  const electiveSets = [
    { id: 'es-1', name: 'Afternoon Electives', is_reusable: 1 },
    { id: 'es-2', name: 'Imported one-off', is_reusable: 0 },
  ]

  it('lists the reusable elective sets under their own heading, each a draggable chip', () => {
    renderPalette({ electiveSets })
    const section = screen.getByTestId('palette-zone-electives')
    expect(within(section).getByText('Elective sets')).toBeTruthy()
    const chip = within(section).getByText('Afternoon Electives').closest('[data-palette-elective]')
    expect(chip.getAttribute('data-palette-elective')).toBe('es-1')
    expect(within(section).queryByText('Imported one-off')).toBeNull()
  })

  it('counts how many cells of the week each set holds', () => {
    renderPalette({ electiveSets, slots: [...slots, { elective_set_id: 'es-1', is_fixed_event: false }, { elective_set_id: 'es-1', is_fixed_event: false }] })
    expect(screen.getByTestId('palette-elective-count-es-1').textContent).toBe('2 wk')
  })

  // Audit E3 (2026-10-10) — with 18 activities the sets sat below the fold of a
  // 70vh scroller. A camp has a handful of sets and many activities, so the sets
  // go FIRST, above the activities heading and filter.
  it('puts the elective sets above the activities, so they are visible without scrolling', () => {
    renderPalette({ electiveSets })
    const sets = screen.getByTestId('palette-zone-electives')
    const filter = screen.getByLabelText('Filter activities')
    const firstActivity = screen.getByText('Swimming')
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING
    expect(sets.compareDocumentPosition(filter) & FOLLOWING).toBeTruthy()
    expect(sets.compareDocumentPosition(firstActivity) & FOLLOWING).toBeTruthy()
  })

  it('renders no section when the camp has no reusable sets', () => {
    renderPalette({ electiveSets: [electiveSets[1]] })
    expect(screen.queryByTestId('palette-zone-electives')).toBeNull()
  })

  it('counts a recurring-event cell that is linked to the activity (restored import)', () => {
    const fixedCells = [
      { group_id: 'g1', day_id: 'd1', activity_id: 'a2', is_fixed_event: 1, fixed_event_id: 'fe1' },
      { group_id: 'g1', day_id: 'd2', activity_id: 'a2', is_fixed_event: 1, fixed_event_id: 'fe1' },
    ]
    renderPalette({ slots: fixedCells })
    expect(screen.getByTestId('palette-count-a2').textContent).toMatch(/^2 \//)
  })

  it('does not count a recurring-event cell that links to no activity', () => {
    renderPalette({ slots: [{ group_id: 'g1', day_id: 'd1', activity_id: null, is_fixed_event: 1, fixed_event_id: 'fe9' }] })
    expect(screen.getByTestId('palette-count-a2').textContent).toMatch(/^0 \//)
  })
})
