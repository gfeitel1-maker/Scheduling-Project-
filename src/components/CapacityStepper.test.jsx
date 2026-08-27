// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CapacityStepper } from './CapacityStepper'

describe('CapacityStepper', () => {
  it('defaults to aria-label "Groups at once" and a floor of 1', () => {
    const onChange = vi.fn()
    render(<CapacityStepper value={1} onChange={onChange} />)
    expect(screen.getByLabelText('Groups at once')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Decrease'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('honors a custom ariaLabel', () => {
    const onChange = vi.fn()
    render(<CapacityStepper value={2} onChange={onChange} ariaLabel="Minimum per week" />)
    expect(screen.getByLabelText('Minimum per week')).toBeTruthy()
  })

  it('honors a custom min floor, including 0', () => {
    const onChange = vi.fn()
    render(<CapacityStepper value={0} onChange={onChange} min={0} ariaLabel="Minimum per week" />)
    const decrement = screen.getByLabelText('Decrease')
    expect(decrement.disabled).toBe(true)
    fireEvent.click(decrement)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('clamps typed input at the custom min on blur', () => {
    const onChange = vi.fn()
    render(<CapacityStepper value={3} onChange={onChange} min={2} ariaLabel="Max groups" />)
    const input = screen.getByLabelText('Max groups')
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('increments past the default floor with the + button', () => {
    const onChange = vi.fn()
    render(<CapacityStepper value={1} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Increase'))
    expect(onChange).toHaveBeenCalledWith(2)
  })
})
