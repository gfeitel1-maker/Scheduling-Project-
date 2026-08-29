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
  { activity_id: 'a1', is_anchor: false },
  { activity_id: 'a1', is_anchor: false },
  { activity_id: 'a1', is_anchor: false },
  { activity_id: 'a2', is_anchor: false },
]

function renderPalette(extraProps = {}) {
  return render(
    <ActivityPalette
      activities={activities}
      slots={slots}
      showTargets
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
