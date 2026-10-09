// @vitest-environment jsdom
// T350 slice 3 (ADR 2026-10-09 D11.1): why Generate / Start blank week will not
// run, as an inline flag-style notice derived from state — never a banner, and
// gone the moment the condition clears.
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import GenerationBlockedNotice from './GenerationBlockedNotice'

const days = [{ id: 'd1' }, { id: 'd2' }]

describe('GenerationBlockedNotice', () => {
  it('says every day is a special day, and clears when one is unbound', () => {
    const { rerender, container } = render(<GenerationBlockedNotice days={days} replacedDayIds={['d1', 'd2']} specialDaysReadFailed={false} />)
    expect(screen.getByRole('status').textContent).toMatch(/every day this week is a special day/i)
    rerender(<GenerationBlockedNotice days={days} replacedDayIds={['d1']} specialDaysReadFailed={false} />)
    expect(container.textContent).toBe('')
  })

  it('surfaces an unreadable special-day list, and clears on a good read', () => {
    const { rerender, container } = render(<GenerationBlockedNotice days={days} replacedDayIds={[]} specialDaysReadFailed />)
    expect(screen.getByRole('status').textContent).toMatch(/couldn.t read this week.s special days/i)
    rerender(<GenerationBlockedNotice days={days} replacedDayIds={[]} specialDaysReadFailed={false} />)
    expect(container.textContent).toBe('')
  })

  it('renders nothing for a normal week or a week with no days', () => {
    const { container } = render(<GenerationBlockedNotice days={[]} replacedDayIds={[]} specialDaysReadFailed={false} />)
    expect(container.textContent).toBe('')
  })
})
