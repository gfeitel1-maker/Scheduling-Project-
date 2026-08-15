// @vitest-environment jsdom
//
// S5b/T75 — the reconciliation-preview LEDGER. These drive the component directly
// with hand-built ReconciliationPlans (the shape buildPlan emits), asserting the
// counts ledger, the ledger-first collapse behaviour, the field-level diff
// grammar, and the conflict gate. The flow-level wiring (both import paths reach
// this ledger, held routes to T73) is covered in ImportScreen.ledger.test.jsx.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ReconciliationLedger } from './ReconciliationLedger'
import { CLEAR } from '../ingest/buildPlan'

// A plan with a mix of every op. Basketball is updated (min 2→3), Swim is a Clear
// (max_per_week 3→cleared), Archery is a conflict, plus new + unchanged rows.
const mixedPlan = {
  plan_version: 1,
  items: [
    { op: 'unchanged', entity: 'activities', entity_id: 'a1', fields: {}, _name: 'Soccer' },
    { op: 'unchanged', entity: 'activities', entity_id: 'a2', fields: {}, _name: 'Chess' },
    {
      op: 'update', entity: 'activities', entity_id: 'a3', _name: 'Basketball',
      fields: { min_per_week: { from: 2, to: 3, source: 'import' } },
    },
    {
      op: 'clear', entity: 'activities', entity_id: 'a4', _name: 'Swim',
      fields: { max_per_week: { from: 3, to: CLEAR, source: 'import' } },
    },
    { op: 'create', entity: 'activities', entity_id: null, _name: 'Archery Range', fields: {} },
    {
      op: 'conflict', entity: 'activities', entity_id: null, reason: 'ambiguous_identity', _name: 'Ropes',
      fields: {}, evidence: { candidates: [{ id: 'r1', name: 'Ropes' }, { id: 'r2', name: 'Ropes Course' }] },
    },
  ],
}

const cleanPlan = {
  plan_version: 1,
  items: [
    { op: 'unchanged', entity: 'activities', entity_id: 'a1', fields: {}, _name: 'Soccer' },
    { op: 'create', entity: 'activities', entity_id: null, _name: 'Archery', fields: {} },
  ],
}

function renderLedger(plan, props = {}) {
  return render(
    <ReconciliationLedger
      plan={plan}
      fileName="Camp Achva — Summer 2026.xlsx"
      working={false}
      onCommit={props.onCommit ?? (() => {})}
      onDiscard={props.onDiscard ?? (() => {})}
    />,
  )
}

describe('ReconciliationLedger — counts ledger', () => {
  it('renders a count for each op present', () => {
    renderLedger(mixedPlan)
    // Each ledger line's count and word sit in one text node.
    expect(screen.getByText(/^2 unchanged$/)).toBeTruthy()
    expect(screen.getByText(/^1 updated$/)).toBeTruthy()
    expect(screen.getByText(/^1 cleared$/)).toBeTruthy()
    expect(screen.getByText(/^1 new$/)).toBeTruthy()
    expect(screen.getByText(/1 need your attention/)).toBeTruthy()
  })

  it('collapses Unchanged by default — the count shows, the rows are hidden', async () => {
    renderLedger(mixedPlan)
    expect(screen.getByText(/^2 unchanged$/)).toBeTruthy()
    // The unchanged record names are not rendered until [show] is clicked.
    expect(screen.queryByText('Soccer')).toBeNull()
    expect(screen.queryByText('Chess')).toBeNull()
    // Unchanged is the first collapsible section (New also collapses).
    await userEvent.click(screen.getAllByText('show')[0])
    expect(screen.getByText('Soccer')).toBeTruthy()
    expect(screen.getByText('Chess')).toBeTruthy()
  })
})

describe('ReconciliationLedger — field-level diff (camp language)', () => {
  it('shows an Updated row with the camp-language label, muted was and full will-be', () => {
    renderLedger(mixedPlan)
    // Updated rows are expanded by default.
    expect(screen.getByText('Basketball')).toBeTruthy()
    // No min_per_week jargon — the camp phrase instead.
    expect(screen.getByText(/how many times a week \(fewest\)/)).toBeTruthy()
    expect(screen.queryByText(/min_per_week/)).toBeNull()
    // was (2) is muted --text-secondary; will-be (3) is full --text + bold.
    const was = [...document.querySelectorAll('span')].find((s) => s.textContent === '2')
    const willBe = [...document.querySelectorAll('span')].find((s) => s.textContent === '3')
    expect(was.getAttribute('style')).toMatch(/color:\s*var\(--text-secondary\)/)
    expect(willBe.getAttribute('style')).toMatch(/color:\s*var\(--text\)/)
    expect(willBe.getAttribute('style')).toMatch(/font-weight:\s*600/)
  })

  it('flags a Clear row more firmly — its own line, a "removes a value" note, and (cleared)', () => {
    renderLedger(mixedPlan)
    expect(screen.getByText('Swim')).toBeTruthy()
    expect(screen.getByText(/remove a value/)).toBeTruthy()
    expect(screen.getByText('(cleared)')).toBeTruthy()
    // Clear is NOT folded into Updated: the updated count stays 1.
    expect(screen.getByText(/^1 updated$/)).toBeTruthy()
  })
})

describe('ReconciliationLedger — conflict gate', () => {
  it('auto-expands the needs-attention rows and DISABLES commit until resolved', () => {
    renderLedger(mixedPlan)
    // The conflicting record is visible without any disclosure click.
    expect(screen.getByText(/is this the same/i)).toBeTruthy()
    const commit = screen.getByText(/Held until \d+ resolved/).closest('button')
    expect(commit.disabled).toBe(true)
  })

  it('enables commit when the plan has no conflicts, and calls onCommit', async () => {
    const onCommit = vi.fn()
    renderLedger(cleanPlan, { onCommit })
    const commit = screen.getByText(/Commit \d+ record/).closest('button')
    expect(commit.disabled).toBe(false)
    await userEvent.click(commit)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('Discard calls onDiscard and never commits', async () => {
    const onCommit = vi.fn()
    const onDiscard = vi.fn()
    renderLedger(cleanPlan, { onCommit, onDiscard })
    await userEvent.click(screen.getByText('Discard'))
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })
})
