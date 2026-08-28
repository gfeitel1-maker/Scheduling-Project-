// @vitest-environment jsdom
//
// RootsBanner (plan T2) — the readiness verdict + entry points banner at the
// top of Roots inspect mode. Pins the SINGLE-SOURCE property: the verdict
// rendered here must be exactly describeReadiness(readiness)'s sentence, the
// same source ReadinessHub uses — never a second computation.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RootsBanner from './rootsBanner.jsx'
import { getReadiness, describeReadiness } from '../../engine/readiness.js'

const READY_COLLECTIONS = {
  cohorts: [{ id: 'c1' }],
  tiers: [{ id: 't1' }],
  groups: [{ id: 'g1' }],
  days: [{ id: 'd1' }],
  timeBlocks: [{ id: 'tb1' }],
  activities: [{ id: 'a1' }],
  anchors: [],
  dayOverrides: [],
  locations: [],
}

const BLOCKED_COLLECTIONS = {
  ...READY_COLLECTIONS,
  groups: [],
  activities: [],
}

describe('RootsBanner', () => {
  it('renders the blocking verdict sentence when readiness has blocking gaps', () => {
    const readiness = getReadiness(BLOCKED_COLLECTIONS)
    const { blocking } = describeReadiness(readiness)

    render(<RootsBanner readiness={readiness} brandNew={false} onNavigate={vi.fn()} onDownloadWorksheet={vi.fn()} />)

    expect(screen.getByText(blocking)).toBeTruthy()
  })

  it('renders the ready line when readiness is green', () => {
    const readiness = getReadiness(READY_COLLECTIONS)
    const { blocking } = describeReadiness(readiness)
    expect(blocking).toBe('Ready to build a week.')

    render(<RootsBanner readiness={readiness} brandNew={false} onNavigate={vi.fn()} onDownloadWorksheet={vi.fn()} />)

    expect(screen.getByText('Ready to build a week.')).toBeTruthy()
  })

  it('the Import control calls onNavigate("import") when brand new', async () => {
    const readiness = getReadiness(READY_COLLECTIONS)
    const onNavigate = vi.fn()
    render(<RootsBanner readiness={readiness} brandNew={true} onNavigate={onNavigate} onDownloadWorksheet={vi.fn()} />)

    await userEvent.click(screen.getByText('Import last year'))
    expect(onNavigate).toHaveBeenCalledWith('import')
  })

  it('the Worksheet control calls onDownloadWorksheet', async () => {
    const readiness = getReadiness(READY_COLLECTIONS)
    const onDownloadWorksheet = vi.fn()
    render(<RootsBanner readiness={readiness} brandNew={false} onNavigate={vi.fn()} onDownloadWorksheet={onDownloadWorksheet} />)

    await userEvent.click(screen.getByText('Download worksheet'))
    expect(onDownloadWorksheet).toHaveBeenCalled()
  })

  it('there is no Facility map control (the spatial layer was removed)', () => {
    const readiness = getReadiness(READY_COLLECTIONS)
    render(<RootsBanner readiness={readiness} brandNew={false} onNavigate={vi.fn()} onDownloadWorksheet={vi.fn()} />)

    expect(screen.queryByText('Facility map')).toBeNull()
  })

  it('when brandNew, the Import control is shown and primary (S.btnPrimary background)', () => {
    const readiness = getReadiness(BLOCKED_COLLECTIONS)
    render(<RootsBanner readiness={readiness} brandNew={true} onNavigate={vi.fn()} onDownloadWorksheet={vi.fn()} />)

    const importBtn = screen.getByText('Import last year')
    expect(importBtn.style.background).toBe('var(--primary)')
  })

  it('when not brandNew, the Import control stays on the banner as a secondary "Re-import last year" and navigates to import', async () => {
    const readiness = getReadiness(READY_COLLECTIONS)
    const onNavigate = vi.fn()
    render(<RootsBanner readiness={readiness} brandNew={false} onNavigate={onNavigate} onDownloadWorksheet={vi.fn()} />)

    const importBtn = screen.getByText('Re-import last year')
    expect(importBtn.style.background).not.toBe('var(--primary)')
    await userEvent.click(importBtn)
    expect(onNavigate).toHaveBeenCalledWith('import')
  })
})
