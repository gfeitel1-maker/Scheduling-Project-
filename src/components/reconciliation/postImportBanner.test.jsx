// @vitest-environment jsdom
//
// PostImportBanner (Roots-as-dashboard plan, Task 4) — the ONE focused banner
// shown on Roots in the continuation of a just-committed import. Owns the
// import summary, the folded-in readiness verdict (single source:
// describeReadiness over the parent's getReadiness output — never re-derived),
// the migrated fixed-event/Replace caveats, the grace-window undo affordance,
// and the single "Go to Schedule" primary CTA.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PostImportBanner from './postImportBanner.jsx'
import { getReadiness, describeReadiness } from '../../engine/readiness.js'

const READY_COLLECTIONS = {
  cohorts: [{ id: 'c1' }], tiers: [{ id: 't1' }], groups: [{ id: 'g1' }],
  days: [{ id: 'd1' }], timeBlocks: [{ id: 'tb1' }], activities: [{ id: 'a1' }],
  anchors: [], dayOverrides: [], locations: [],
}
const BLOCKED_COLLECTIONS = { ...READY_COLLECTIONS, groups: [], activities: [] }

// Match on a node whose full text satisfies the regex even when split across
// sibling text nodes by interleaved JSX expressions.
function textNode(regex) {
  return (_, element) => {
    const has = (node) => regex.test(node.textContent ?? '')
    return has(element) && Array.from(element.children).every((child) => !has(child))
  }
}

const idleGraceWindow = (overrides = {}) => ({
  status: 'idle', isLive: false, isPending: false,
  createdEntityIds: [], deleted: [], skipped: [], kept: [], undoError: null,
  undo: vi.fn(), start: vi.fn(), clear: vi.fn(),
  ...overrides,
})

const outcome = (overrides = {}) => ({
  total: 5,
  fixedEvents: { created: 0, skipped: [], partial: [], moved: [] },
  ...overrides,
})

describe('PostImportBanner', () => {
  it('renders the import summary and folds in the ready verdict line', () => {
    const readiness = getReadiness(READY_COLLECTIONS)
    render(
      <PostImportBanner outcome={outcome({ total: 5 })} readiness={readiness}
        graceWindow={idleGraceWindow()} onNavigate={vi.fn()} />
    )
    expect(screen.getByText(textNode(/Imported 5 records — here’s your camp\./))).toBeTruthy()
    expect(screen.getByText('Ready to build a week.')).toBeTruthy()
  })

  it('surfaces staged two-row split failures to the director (Red Hat HIGH B — not just console.error)', () => {
    render(
      <PostImportBanner
        outcome={outcome({ splitFailures: [{ name: 'Ceramics', message: 'The split for "Ceramics" couldn’t be applied — that activity is no longer in your setup.' }] })}
        readiness={getReadiness(READY_COLLECTIONS)}
        graceWindow={idleGraceWindow()} onNavigate={vi.fn()} />
    )
    expect(screen.getByText(textNode(/A split you chose couldn’t be applied/))).toBeTruthy()
    expect(screen.getByText(textNode(/no longer in your setup/))).toBeTruthy()
  })

  it('shows the one-time brand celebration on completion', () => {
    render(
      <PostImportBanner outcome={outcome()} readiness={getReadiness(READY_COLLECTIONS)}
        graceWindow={idleGraceWindow()} onNavigate={vi.fn()} />
    )
    expect(screen.getByText('Your foundation is set.')).toBeTruthy()
  })

  it('folds in the blocking verdict sentence when the camp is not ready — the same text describeReadiness produces', () => {
    const readiness = getReadiness(BLOCKED_COLLECTIONS)
    const { blocking } = describeReadiness(readiness)
    expect(blocking).not.toBe('Ready to build a week.')
    render(
      <PostImportBanner outcome={outcome()} readiness={readiness}
        graceWindow={idleGraceWindow()} onNavigate={vi.fn()} />
    )
    expect(screen.getByText(blocking)).toBeTruthy()
  })

  it('omits the verdict line when the census read failed (never a false "ready")', () => {
    render(
      <PostImportBanner outcome={outcome()} readiness={[]} censusReadFailed
        graceWindow={idleGraceWindow()} onNavigate={vi.fn()} />
    )
    expect(screen.getByText(textNode(/Imported 5 records/))).toBeTruthy()
    expect(screen.queryByText('Ready to build a week.')).toBeNull()
  })

  it('omits the verdict line when there is no readiness to describe', () => {
    render(
      <PostImportBanner outcome={outcome()} readiness={[]}
        graceWindow={idleGraceWindow()} onNavigate={vi.fn()} />
    )
    expect(screen.queryByText('Ready to build a week.')).toBeNull()
  })

  it('the single primary CTA is Go to Schedule → onNavigate("schedule")', async () => {
    const onNavigate = vi.fn()
    render(
      <PostImportBanner outcome={outcome()} readiness={getReadiness(READY_COLLECTIONS)}
        graceWindow={idleGraceWindow()} onNavigate={onNavigate} />
    )
    const cta = screen.getByText('Go to Schedule')
    expect(cta.style.background).toBe('var(--primary)')
    await userEvent.click(cta)
    expect(onNavigate).toHaveBeenCalledWith('schedule')
  })

  it('disables Go to Schedule while an undo is pending (no leaving mid-undo)', () => {
    render(
      <PostImportBanner outcome={outcome()} readiness={getReadiness(READY_COLLECTIONS)}
        graceWindow={idleGraceWindow({ status: 'live', isLive: true, isPending: true, createdEntityIds: ['id-1'] })}
        onNavigate={vi.fn()} />
    )
    expect(screen.getByText('Go to Schedule').disabled).toBe(true)
  })

  it('shows the undo affordance while the grace window is live and wires it to graceWindow.undo', async () => {
    const graceWindow = idleGraceWindow({ status: 'live', isLive: true, createdEntityIds: ['id-1'] })
    render(
      <PostImportBanner outcome={outcome()} readiness={getReadiness(READY_COLLECTIONS)}
        graceWindow={graceWindow} onNavigate={vi.fn()} />
    )
    const undoBtn = screen.getByText('Undo this import')
    // The undo control is not a competing primary CTA.
    expect(undoBtn.style.background).not.toBe('var(--primary)')
    await userEvent.click(undoBtn)
    expect(graceWindow.undo).toHaveBeenCalled()
  })

  it('surfaces the migrated fixed-event caveats (skipped and moved)', () => {
    render(
      <PostImportBanner
        outcome={outcome({ total: 2, fixedEvents: { created: 0, skipped: [{ name: 'Flag' }], partial: [], moved: [{ name: 'Lunch', reason: 'time changed' }] } })}
        readiness={getReadiness(READY_COLLECTIONS)}
        graceWindow={idleGraceWindow()} onNavigate={vi.fn()} />
    )
    expect(screen.getByText(textNode(/1 recurring event couldn.t\s+be created/))).toBeTruthy()
    expect(screen.getByText(textNode(/moved since this file was last imported/))).toBeTruthy()
  })
})
