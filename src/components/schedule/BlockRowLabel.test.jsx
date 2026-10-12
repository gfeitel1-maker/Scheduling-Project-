// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import BlockRowLabel from './BlockRowLabel'

// Audit I3 — the one row-header label every schedule grid uses.
describe('BlockRowLabel', () => {
  it('a time-named block shows one line: the 12-hour range', () => {
    const { container } = render(<BlockRowLabel block={{ name: '03:20-03:40', start_time: '15:20:00', end_time: '15:40:00' }} />)
    expect(container.querySelector('.block-name').textContent).toBe('3:20 PM – 3:40 PM')
    expect(container.querySelector('.block-time')).toBeNull()
  })
  it('a named block shows its name, then the 12-hour range', () => {
    const { container } = render(<BlockRowLabel block={{ name: 'Lunch', start_time: '11:30', end_time: '12:15' }} />)
    expect(container.querySelector('.block-name').textContent).toBe('Lunch')
    expect(container.querySelector('.block-time').textContent).toBe('11:30 AM – 12:15 PM')
  })
})

// Owner, 2026-10-12: block times wrapped on one row for some blocks and two for others. Every
// range now sits on the same two lines, "start –" then "end", whatever its length.
describe('BlockRowLabel range lines', () => {
  const lines = (c) => [...c.querySelectorAll('.block-range-line')].map((n) => n.textContent)
  it('a named block and a time-named block both lay the range out as the same two lines', () => {
    const named = render(<BlockRowLabel block={{ name: 'Lunch', start_time: '11:30', end_time: '12:15' }} />)
    expect(lines(named.container)).toEqual(['11:30 AM –', '12:15 PM'])
    const timeNamed = render(<BlockRowLabel block={{ name: '9:00-9:45', start_time: '09:00', end_time: '09:45' }} />)
    expect(lines(timeNamed.container)).toEqual(['9:00 AM –', '9:45 AM'])
  })
})
