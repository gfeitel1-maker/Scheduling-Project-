// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RosterList from './RosterList.jsx'

function entry(overrides = {}) {
  return { entityId: 'e1', name: 'Row', state: 'understood', decisionId: null, group: null, ...overrides }
}

describe('RosterList', () => {
  it('renders a flat list with no search box below threshold', () => {
    const roster = Array.from({ length: 5 }, (_, i) => entry({ entityId: `e${i}`, name: `Row ${i}` }))
    render(<RosterList roster={roster} threshold={8} />)

    expect(screen.queryByPlaceholderText(/Find in/)).toBeFalsy()
    for (let i = 0; i < 5; i++) expect(screen.getByText(`Row ${i}`)).toBeTruthy()
  })

  it('shows a search box above threshold and filters by name', () => {
    const roster = Array.from({ length: 12 }, (_, i) => entry({ entityId: `e${i}`, name: `Group ${i}` }))
    render(<RosterList roster={roster} threshold={8} />)

    const input = screen.getByPlaceholderText('Find in 12...')
    fireEvent.change(input, { target: { value: 'Group 7' } })

    expect(screen.getByText('Group 7')).toBeTruthy()
    expect(screen.queryByText('Group 0')).toBeFalsy()
  })

  it('pins non-understood entries above the fold, unaffected by the search filter', () => {
    const roster = [
      entry({ entityId: 'e1', name: 'Alpha', state: 'attention' }),
      ...Array.from({ length: 10 }, (_, i) => entry({ entityId: `u${i}`, name: `Understood ${i}` })),
    ]
    render(<RosterList roster={roster} threshold={8} />)

    const input = screen.getByPlaceholderText(/Find in/)
    fireEvent.change(input, { target: { value: 'zzz-no-match' } })

    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.queryByText('Understood 0')).toBeFalsy()
  })

  it('groups entries by groupField, with a real bucket for null groups (Groups child, real ADR case)', () => {
    const roster = [
      entry({ entityId: 'g1', name: 'Shoresh', group: 'Age Division: Amitim' }),
      entry({ entityId: 'g2', name: 'Bogrim', group: 'Age Division: Sollelim' }),
      entry({ entityId: 'g3', name: 'Wanderers', group: '(no age division)' }),
    ]
    render(<RosterList roster={roster} threshold={0} groupField="group" />)

    expect(screen.getByText('Age Division: Amitim (1)')).toBeTruthy()
    expect(screen.getByText('Age Division: Sollelim (1)')).toBeTruthy()
    expect(screen.getByText('(no age division) (1)')).toBeTruthy()
  })

  it('renders flat (no grouping chrome) when groupField is absent, e.g. Activities (no backing category field)', () => {
    const roster = [
      entry({ entityId: 'a1', name: 'Kayak' }),
      entry({ entityId: 'a2', name: 'Archery' }),
    ]
    render(<RosterList roster={roster} threshold={0} />)

    expect(screen.getByText('Kayak')).toBeTruthy()
    expect(screen.getByText('Archery')).toBeTruthy()
    expect(screen.queryByRole('group')).toBeFalsy()
  })

  it('does not collide on React key when two resolved proposed-new entries share entityId: null', () => {
    const roster = [
      entry({ entityId: null, decisionId: 'd1', name: 'Ohel' }),
      entry({ entityId: null, decisionId: 'd2', name: 'Teva' }),
    ]
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<RosterList roster={roster} threshold={0} />)

    expect(screen.getByText('Ohel')).toBeTruthy()
    expect(screen.getByText('Teva')).toBeTruthy()
    const keyWarning = errorSpy.mock.calls.some((args) => String(args[0]).includes('same key'))
    expect(keyWarning).toBe(false)
    errorSpy.mockRestore()
  })

  it('groups entries under a caller-supplied nullGroupLabel, not a hardcoded default', () => {
    const roster = [
      entry({ entityId: 'x1', name: 'Loner', group: null }),
    ]
    render(<RosterList roster={roster} threshold={0} groupField="group" nullGroupLabel="(ungrouped)" />)

    expect(screen.getByText('(ungrouped) (1)')).toBeTruthy()
  })

  // Slice 4 (docs/adr/2026-08-19-roots-census-and-persistent-inspector.md
  // §(e), open question 4) — a roster row click navigates like the panel's
  // "Open in..." button, general not entity-specific.
  it('clicking a row fires onRowClick with that entity', () => {
    const roster = [entry({ entityId: 'e1', name: 'Bogrim' })]
    const onRowClick = vi.fn()
    render(<RosterList roster={roster} threshold={0} onRowClick={onRowClick} />)

    fireEvent.click(screen.getByText('Bogrim'))
    expect(onRowClick).toHaveBeenCalledTimes(1)
    expect(onRowClick).toHaveBeenCalledWith(roster[0])
  })

  it('Enter and Space on a focused row fire onRowClick too', () => {
    const roster = [entry({ entityId: 'e1', name: 'Bogrim' })]
    const onRowClick = vi.fn()
    render(<RosterList roster={roster} threshold={0} onRowClick={onRowClick} />)

    const row = screen.getByText('Bogrim').closest('[role="button"]')
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })
    expect(onRowClick).toHaveBeenCalledTimes(2)
  })

  it('rows are plain, unclickable, and have no button role when onRowClick is not provided', () => {
    const roster = [entry({ entityId: 'e1', name: 'Bogrim' })]
    render(<RosterList roster={roster} threshold={0} />)

    expect(screen.queryByRole('button', { name: /Bogrim/ })).toBeFalsy()
  })
})
