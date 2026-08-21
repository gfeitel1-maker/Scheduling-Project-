// @vitest-environment jsdom
//
// T108 Phase 2 (design §5.1, Designer spec §3). PulledCell renders a PULL
// override: bold "Pulled" label + icon, optional note, non-droppable (no
// draggable/droppable wiring), not clickable to edit.
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import PulledCell from './PulledCell'

const baseProps = {
  slot: { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', is_overridden: true, is_pull: true, activity_id: null },
  gridRow: '1 / span 1', gridColumn: '2 / span 1', ariaColIndex: 2, cellKey: 'g1|d1|b1',
  blockNames: ['Block 1'], column: 'Mon',
}

describe('PulledCell', () => {
  it('renders the Pulled label with data-overridden + data-overridden-kind="pull"', () => {
    const { container } = render(<PulledCell {...baseProps} />)
    const cell = container.querySelector('[role="gridcell"]')
    expect(cell.getAttribute('data-overridden')).toBe('true')
    expect(cell.getAttribute('data-overridden-kind')).toBe('pull')
    expect(container.textContent).toContain('Pulled')
  })

  it('renders an optional note', () => {
    const { container } = render(<PulledCell {...baseProps} slot={{ ...baseProps.slot, day_override_note: 'Trip to lake' }} />)
    expect(container.textContent).toContain('Trip to lake')
  })

  it('does not render a note element when none is authored (no empty placeholder)', () => {
    const { container } = render(<PulledCell {...baseProps} />)
    expect(container.querySelector('.cell-pulled-note')).toBeNull()
  })

  it('is not droppable — no drag/drop listeners or handlers are attached', () => {
    const { container } = render(<PulledCell {...baseProps} />)
    const cell = container.querySelector('[role="gridcell"]')
    expect(cell.getAttribute('data-drop-disabled')).toBe('')
    // No onClick handler means React never attaches a click listener that would
    // open an editor — verified indirectly: no cell-inline-editor markup exists
    // and clicking does nothing observable (no state, no editor to open).
    expect(container.querySelector('.cell-inline-editor-input')).toBeNull()
  })

  it('sets an accessible label including the pulled state', () => {
    const { container } = render(<PulledCell {...baseProps} />)
    const cell = container.querySelector('[role="gridcell"]')
    expect(cell.getAttribute('aria-label')).toContain('Pulled')
  })
})
