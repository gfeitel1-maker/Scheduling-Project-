// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import WeekSwitcher from './WeekSwitcher'

const weeks = [
  { id: 'w1', camp_id: 'camp-1', name: 'Week 1', sort_order: 0, is_archived: 0 },
]

describe('WeekSwitcher create loading state', () => {
  it('disables the Add button and shows progress while createWeek is in flight', async () => {
    let resolveCreate
    const onCreate = vi.fn(() => new Promise(resolve => { resolveCreate = resolve }))
    render(<WeekSwitcher weeks={weeks} weekId="w1" onSelect={() => {}} onCreate={onCreate} />)

    fireEvent.click(screen.getByText('Week 1 ▾'))
    fireEvent.click(screen.getByText('+ New Week'))

    const input = screen.getByPlaceholderText('Week name…')
    fireEvent.change(input, { target: { value: 'Week 2' } })

    const addButton = screen.getByText('Add')
    fireEvent.click(addButton)

    await waitFor(() => {
      expect(screen.getByText('Adding…').disabled).toBe(true)
    })

    resolveCreate()
    await waitFor(() => {
      expect(screen.queryByText('Adding…')).toBe(null)
    })
    expect(onCreate).toHaveBeenCalledWith('Week 2')
  })
})
