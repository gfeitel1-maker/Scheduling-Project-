// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RootMapPanel from './RootMapPanel.jsx'

function emptyModel() {
  return { domains: [] }
}

// Design-polish finding 1/2 (docs/adr/2026-08-18-rootmap-screen-port.md §1):
// a node selection's heading must show the display domain label
// (DOMAIN_LABELS, "Resources" not "Facility") and the real child display
// name resolved from the model, not the raw internal selection keys.
function baseModel() {
  return {
    domains: [
      {
        key: 'Facility',
        label: 'Facility',
        state: 'attention',
        x: 0.5,
        y: 0.5,
        children: [
          { key: 'Locations', name: 'Locations', count: 2, state: 'attention', x: 0.4, y: 0.6, decisionIds: ['d1'] },
        ],
      },
    ],
  }
}

const lanes = { hold: [{ id: 'd1', kind: 'confirm_change' }], standard: [] }

function noop() {}

describe('RootMapPanel node heading label resolution', () => {
  it('shows DOMAIN_LABELS display name for a domain-only selection, not the raw key', () => {
    const model = baseModel()
    render(
      <RootMapPanel
        model={model}
        selection={{ type: 'node', domainKey: 'Facility' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{}}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.getByText('Resources')).toBeTruthy()
    expect(screen.queryByText('Facility')).toBeFalsy()
  })

  it('shows the child\'s real display name for a node+child selection, not the raw childKey', () => {
    const model = baseModel()
    render(
      <RootMapPanel
        model={model}
        selection={{ type: 'node', domainKey: 'Facility', childKey: 'Locations' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{}}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.getByText('Resources · Locations')).toBeTruthy()
  })

  it('falls back to the domain label when the selected child is missing from the model', () => {
    const model = baseModel()
    render(
      <RootMapPanel
        model={model}
        selection={{ type: 'node', domainKey: 'Facility', childKey: 'GoneNow' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{}}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.getByText('Resources')).toBeTruthy()
  })
})

describe('RootMapPanel node selection connects to the real edit screen', () => {
  it('renders an "Open in {screen}" button targeting the resolved screen for a node selection', () => {
    const model = baseModel()
    render(
      <RootMapPanel
        model={model}
        selection={{ type: 'node', domainKey: 'Facility', childKey: 'Locations' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{}}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.getByText('Open in Locations →')).toBeTruthy()
  })

  it('calls onNavigate with the resolved target screen when the Open button is clicked', () => {
    const model = baseModel()
    let navigatedTo = null
    render(
      <RootMapPanel
        model={model}
        selection={{ type: 'node', domainKey: 'Facility', childKey: 'Locations' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{}}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={(screen) => { navigatedTo = screen }}
        onClearSelection={noop}
      />,
    )
    screen.getByText('Open in Locations →').click()
    expect(navigatedTo).toBe('locations')
  })

  it('renders no Open button for the Context domain (no edit surface)', () => {
    const model = {
      domains: [
        { key: 'Context', label: 'Context', state: 'absent', x: 0.5, y: 0.5, children: [] },
      ],
    }
    render(
      <RootMapPanel
        model={model}
        selection={{ type: 'node', domainKey: 'Context' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{}}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.queryByText(/Open in/)).toBeFalsy()
  })
})

// H1 (docs/work/specs/2026-08-19-roots-reconciliation-audit.md §12 Slice 1):
// the default view ('selection:none') must scope to the UNRESOLVED subset —
// it previously rendered the entire hold+standard queue (including already-
// resolved items) under a header reading "Needs your attention", which is
// the bug this slice fixes. These tests intentionally REPLACE the old
// "default view shows everything unfiltered" characterization — that old
// behavior encoded the bug (see §12/H1 in the audit).
describe('RootMapPanel default view scoping (H1 fix)', () => {
  function resolvedDecision() {
    return { id: 'r1', kind: 'confirm_change', entityName: 'Resolved Item' }
  }
  function unresolvedDecision() {
    return { id: 'u1', kind: 'confirm_change', entityName: 'Unresolved Item' }
  }

  it('shows only the unresolved subset by default when the queue has a resolved/unresolved mix', () => {
    const lanes = { hold: [unresolvedDecision()], standard: [resolvedDecision()] }
    const { container } = render(
      <RootMapPanel
        model={emptyModel()}
        selection={{ type: 'none' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{ r1: { choice: 'accept' } }}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )
    expect(container.textContent).toContain('Unresolved Item')
    expect(container.textContent).not.toContain('Resolved Item')
  })

  it('shows the "N resolved · Show all" control only when resolved items exist and selection is none', () => {
    const lanes = { hold: [unresolvedDecision()], standard: [resolvedDecision()] }
    render(
      <RootMapPanel
        model={emptyModel()}
        selection={{ type: 'none' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{ r1: { choice: 'accept' } }}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.getByText('1 resolved · Show all')).toBeTruthy()
  })

  it('does not show the reveal control when a tile is selected, even with resolved items present', () => {
    const lanes = { hold: [unresolvedDecision()], standard: [resolvedDecision()] }
    render(
      <RootMapPanel
        model={emptyModel()}
        selection={{ type: 'tile', state: 'attention' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{ r1: { choice: 'accept' } }}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.queryByText(/resolved · Show all/)).toBeFalsy()
  })

  it('reveals the full list, including resolved items, when the reveal control is clicked', () => {
    const lanes = { hold: [unresolvedDecision()], standard: [resolvedDecision()] }
    const { container } = render(
      <RootMapPanel
        model={emptyModel()}
        selection={{ type: 'none' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{ r1: { choice: 'accept' } }}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )
    fireEvent.click(screen.getByText('1 resolved · Show all'))
    expect(container.textContent).toContain('Resolved Item')
    expect(container.textContent).toContain('Unresolved Item')
    expect(screen.getByText('Hide resolved')).toBeTruthy()
  })

  it('shows no reveal control and renders the (unchanged) full list when nothing is resolved', () => {
    const lanes = { hold: [unresolvedDecision()], standard: [] }
    const { container } = render(
      <RootMapPanel
        model={emptyModel()}
        selection={{ type: 'none' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{}}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )
    expect(container.textContent).toContain('Unresolved Item')
    expect(screen.queryByText(/resolved · Show all/)).toBeFalsy()
  })

  it('resets showResolved when selection leaves and returns to none — the default view is quiet again, not stuck showing everything', () => {
    const lanes = { hold: [unresolvedDecision()], standard: [resolvedDecision()] }
    const answers = { r1: { choice: 'accept' } }
    const { container, rerender } = render(
      <RootMapPanel
        model={emptyModel()}
        selection={{ type: 'none' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={answers}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )

    // Reveal the resolved item.
    fireEvent.click(screen.getByText('1 resolved · Show all'))
    expect(container.textContent).toContain('Resolved Item')

    // Selection moves away from 'none' (e.g. the director clicks a tile)...
    rerender(
      <RootMapPanel
        model={emptyModel()}
        selection={{ type: 'tile', state: 'attention' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={answers}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )

    // ...and back to 'none'.
    rerender(
      <RootMapPanel
        model={emptyModel()}
        selection={{ type: 'none' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={answers}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )

    // The default view must be scoped-quiet again, not stuck open.
    expect(container.textContent).not.toContain('Resolved Item')
    expect(container.textContent).toContain('Unresolved Item')
    expect(screen.getByText('1 resolved · Show all')).toBeTruthy()
  })

  it('shows the reveal control (not a confusing blank) when everything in the queue is already resolved', () => {
    const lanes = { hold: [], standard: [resolvedDecision()] }
    render(
      <RootMapPanel
        model={emptyModel()}
        selection={{ type: 'none' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{ r1: { choice: 'accept' } }}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.getByText('Nothing needs you right now. Shoresh understood everything it found.')).toBeTruthy()
    expect(screen.getByText('1 resolved · Show all')).toBeTruthy()
  })
})
