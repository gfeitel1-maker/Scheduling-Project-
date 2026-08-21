// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, screen } from '@testing-library/react'
import ReconstructionMoment from './ReconstructionMoment.jsx'
import { buildDomainRows, buildSummarySentence } from './reconstructionMomentCopy.js'
import { SETTLE_CAP_MS } from './reconstructionMoment.gate.js'

// docs/adr/2026-08-18-roots-reconstruction-moment-gating.md — "Test seams":
// onSettled firing exactly once, promptly, on the settling transition is the
// executable form of Gate 1.

describe('buildSummarySentence', () => {
  it('all domains understood', () => {
    const rows = buildDomainRows({})
    expect(buildSummarySentence(rows)).toBe('Your whole camp came through clean.')
  })

  it('one domain needing attention, singular verb, no understood clause omitted only if all understood are empty', () => {
    const rows = buildDomainRows({ Structure: 0, Scheduling: 0, Time: 0, Facility: 3 })
    expect(buildSummarySentence(rows)).toBe(
      'Structure, Scheduling Model, and Time look right. Facility needs a quick look.'
    )
  })

  it('two domains needing attention, oxford join and plural verb', () => {
    const rows = buildDomainRows({ Structure: 0, Scheduling: 0, Time: 2, Facility: 3 })
    expect(buildSummarySentence(rows)).toBe(
      'Structure and Scheduling Model look right. Time and Facility need a quick look.'
    )
  })

  it('all four domains needing attention — no understood clause', () => {
    const rows = buildDomainRows({ Structure: 1, Scheduling: 1, Time: 1, Facility: 1 })
    expect(buildSummarySentence(rows)).toBe(
      'Structure, Scheduling Model, Time, and Facility need a quick look.'
    )
  })

  it('exactly one understood domain uses singular "looks"', () => {
    const rows = buildDomainRows({ Structure: 0, Scheduling: 1, Time: 1, Facility: 1 })
    expect(buildSummarySentence(rows)).toBe(
      'Structure looks right. Scheduling Model, Time, and Facility need a quick look.'
    )
  })
})

describe('buildDomainRows', () => {
  it('marks a domain with a positive count as attention, zero as understood', () => {
    const rows = buildDomainRows({ Structure: 2, Scheduling: 0 })
    expect(rows.find((r) => r.key === 'Structure').state).toBe('attention')
    expect(rows.find((r) => r.key === 'Scheduling').state).toBe('understood')
  })

  it('treats a missing/undefined count as understood', () => {
    const rows = buildDomainRows({})
    expect(rows.every((r) => r.state === 'understood')).toBe(true)
  })
})

describe('ReconstructionMoment', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the plain-text loading line while settling=false, no onSettled', () => {
    const onSettled = vi.fn()
    render(<ReconstructionMoment settling={false} domainCounts={{}} onSettled={onSettled} />)

    expect(screen.getByText('Checking this file against your camp…')).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(SETTLE_CAP_MS * 2)
    })

    expect(onSettled).not.toHaveBeenCalled()
  })

  it('renders the heading, sentence, and all four domain rows once settling', () => {
    const onSettled = vi.fn()
    render(
      <ReconstructionMoment
        settling={true}
        domainCounts={{ Structure: 0, Scheduling: 0, Time: 1, Facility: 0 }}
        onSettled={onSettled}
      />
    )

    expect(screen.getByText('Camp reconstructed')).toBeTruthy()
    expect(screen.getByText('Structure')).toBeTruthy()
    expect(screen.getByText('Scheduling Model')).toBeTruthy()
    expect(screen.getByText('Time')).toBeTruthy()
    expect(screen.getByText('Facility')).toBeTruthy()
    expect(screen.getAllByText('Understood')).toHaveLength(3)
    expect(screen.getAllByText('Needs a look')).toHaveLength(1)
  })

  it('paints a needs-attention domain in --accent, never --danger (DESIGN_STANDARD §4)', () => {
    // Regression guard: --danger is reserved for destructive/fatal; attention
    // is --accent (bronze), matching RootMap's STATE_TOKEN.attention. This is
    // the first-run onboarding moment, so an alarm-red "needs a look" both
    // violated the standard and spiked anxiety at the worst moment.
    const { container } = render(
      <ReconstructionMoment
        settling={true}
        domainCounts={{ Structure: 0, Scheduling: 0, Time: 1, Facility: 0 }}
        onSettled={vi.fn()}
      />
    )
    // The one attention row ("Needs a look") must carry --accent, not --danger,
    // anywhere in its rendered inline styles.
    const attentionLabel = screen.getByText('Needs a look')
    const attentionRow = attentionLabel.closest('div')
    expect(attentionRow.innerHTML).toContain('var(--accent)')
    expect(attentionRow.innerHTML).not.toContain('var(--danger)')
    // And nothing in the whole moment paints with --danger.
    expect(container.innerHTML).not.toContain('var(--danger)')
  })

  it('fires onSettled exactly once, within the settle cap, on transition to settling=true', async () => {
    const onSettled = vi.fn()
    const { rerender } = render(
      <ReconstructionMoment settling={false} domainCounts={{}} onSettled={onSettled} />
    )

    rerender(<ReconstructionMoment settling={true} domainCounts={{}} onSettled={onSettled} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS + 50)
    })

    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('never fires a second time on further rerenders once settled', async () => {
    const onSettled = vi.fn()
    const { rerender } = render(
      <ReconstructionMoment settling={false} domainCounts={{}} onSettled={onSettled} />
    )

    rerender(<ReconstructionMoment settling={true} domainCounts={{}} onSettled={onSettled} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS + 50)
    })
    expect(onSettled).toHaveBeenCalledTimes(1)

    rerender(<ReconstructionMoment settling={true} domainCounts={{ Structure: 1 }} onSettled={onSettled} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS * 2)
    })

    expect(onSettled).toHaveBeenCalledTimes(1)
  })
})
