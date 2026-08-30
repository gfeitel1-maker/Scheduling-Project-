// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ScheduleDoor } from './ScheduleDoor'

describe('ScheduleDoor', () => {
  it('renders its label', () => {
    render(<ScheduleDoor label="Build the schedule →" onClick={() => {}} />)
    expect(screen.getByText('Build the schedule →')).toBeTruthy()
  })

  it('renders an optional sublabel', () => {
    render(<ScheduleDoor label="Schedule" sublabel="Where the week comes together" onClick={() => {}} />)
    expect(screen.getByText('Where the week comes together')).toBeTruthy()
  })

  it('fires onClick when pressed', () => {
    const onClick = vi.fn()
    render(<ScheduleDoor label="Schedule" onClick={onClick} />)
    fireEvent.click(screen.getByText('Schedule'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
