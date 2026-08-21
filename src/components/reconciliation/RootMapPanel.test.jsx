// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RootMapPanel from './RootMapPanel.jsx'
import { S } from '../../styles/shared'

function emptyModel() {
  return { domains: [] }
}

// Design-polish finding 1/2 (docs/adr/2026-08-18-rootmap-screen-port.md §1):
// a node selection's heading must show the display domain label
// (DOMAIN_LABELS) and the real child display name resolved from the model,
// not the raw internal selection keys. W1 (docs/work/specs/2026-08-21-
// vocabulary-unification-design.md) retired "Resources" — DOMAIN_LABELS.Facility
// is now 'Facility' itself (same string as the raw key, chosen to avoid
// duplicating the 'Locations' entity node's own caption), so this suite no
// longer has a case where the two values differ; it still exercises the
// resolution path (DOMAIN_LABELS lookup, child name resolution, fallback).
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
    // DOMAIN_LABELS.Facility === 'Facility' (W1), so this no longer proves
    // "translated, not raw key" on its own — the resolution-path coverage
    // (DOMAIN_LABELS lookup used, not a hardcoded string) still holds.
    expect(screen.getByText('Facility')).toBeTruthy()
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
    expect(screen.getByText('Facility · Locations')).toBeTruthy()
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
    expect(screen.getByText('Facility')).toBeTruthy()
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
    expect(screen.getByText('Manage Locations →')).toBeTruthy()
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
    screen.getByText('Manage Locations →').click()
    expect(navigatedTo).toBe('locations')
  })

  it('promotes the node-navigation button to a primary "Manage {node} →" action, reusing S.btnPrimary', () => {
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
    const button = screen.getByRole('button', { name: /^Manage .+→$/ })
    expect(button).toBeTruthy()
    expect(button.style.background).toBe(S.btnPrimary.background)
    expect(button.style.color).toBe('rgb(255, 255, 255)')
    expect(button.style.fontWeight).toBe(String(S.btnPrimary.fontWeight))
    button.click()
    expect(navigatedTo).toBe('locations')
  })

  it('falls back to DOMAIN_LABELS for a domain-only selection (no childKey)', () => {
    const model = baseModel()
    let navigatedTo = null
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
        onNavigate={(screen) => { navigatedTo = screen }}
        onClearSelection={noop}
      />,
    )
    const button = screen.getByRole('button', { name: /^Manage .+→$/ })
    expect(button.textContent).toBe('Manage Facility →')
    button.click()
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

// Design polish #2 (docs/adr/2026-08-18-rootmap-screen-port.md) — the blur
// crossfade is context-switch motion (node selection, or a none/tile/node
// type change), not a filter-flip. A tile->tile change re-renders the same
// panel shape and must NOT trigger the blur-out/blur-in pass.
describe('RootMapPanel panel crossfade (design polish #2)', () => {
  const props = {
    dismissedGaps: new Set(),
    answers: {},
    onAnswer: noop,
    onDismissGap: noop,
    onUndismissGap: noop,
    expandedEvidence: new Set(),
    onToggleEvidence: noop,
    onNavigate: noop,
    onClearSelection: noop,
  }

  it('does not take the blur crossfade path on a tile->tile selection change', () => {
    const model = emptyModel()
    const { getByTestId, rerender } = render(
      <RootMapPanel model={model} selection={{ type: 'tile', state: 'attention' }} lanes={lanes} {...props} />,
    )
    const before = getByTestId('panel-crossfade').getAttribute('style')
    rerender(
      <RootMapPanel model={model} selection={{ type: 'tile', state: 'changed' }} lanes={lanes} {...props} />,
    )
    const after = getByTestId('panel-crossfade').getAttribute('style')
    // No blur-out was initiated: the style is untouched by the selection
    // change (still whatever the settled/entered state was), unlike a real
    // crossfade which synchronously flips to blur(2px)/opacity:0 first.
    expect(after).toBe(before)
    expect(after ?? '').not.toContain('blur(2px)')
  })

  it('does take the blur crossfade path on a node selection change', () => {
    const model = baseModel()
    const { getByTestId, rerender } = render(
      <RootMapPanel model={model} selection={{ type: 'node', domainKey: 'Facility' }} lanes={lanes} {...props} />,
    )
    rerender(
      <RootMapPanel model={model} selection={{ type: 'node', domainKey: 'Facility', childKey: 'Locations' }} lanes={lanes} {...props} />,
    )
    const after = getByTestId('panel-crossfade').getAttribute('style')
    // The crossfade synchronously blurs-out on the dep change, before the
    // rAF flips it back to entered.
    expect(after ?? '').toContain('blur(2px)')
  })
})

describe('RootMapPanel census roster (Slice 2)', () => {
  function modelWithRoster(roster) {
    return {
      domains: [
        {
          key: 'Structure', label: 'Structure', state: 'attention', x: 0.5, y: 0.5,
          children: [
            { key: 'Groups', name: 'Groups', count: 0, state: 'attention', x: 0.5, y: 0.5, decisionIds: [], roster },
          ],
        },
      ],
    }
  }

  it('renders a RosterList below the Open button for a node selection with a non-empty roster', () => {
    const roster = [
      { entityId: 'g1', name: 'Shoresh', state: 'understood', decisionId: null, group: 'Age Division: Amitim' },
      { entityId: 'g2', name: 'Bogrim', state: 'changed', decisionId: 'd1', group: 'Age Division: Sollelim' },
    ]
    render(
      <RootMapPanel
        model={modelWithRoster(roster)}
        selection={{ type: 'node', domainKey: 'Structure', childKey: 'Groups' }}
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
    expect(screen.getByText('Shoresh')).toBeTruthy()
    expect(screen.getByText('Bogrim')).toBeTruthy()
  })

  it('renders nothing extra for a node selection with an empty roster', () => {
    render(
      <RootMapPanel
        model={modelWithRoster([])}
        selection={{ type: 'node', domainKey: 'Structure', childKey: 'Groups' }}
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
    expect(screen.queryByText(/Find in/)).toBeFalsy()
  })

  // Slice 4 (docs/adr/2026-08-19-roots-census-and-persistent-inspector.md
  // §(e), open question 4) — clicking a roster row navigates like the
  // "Open in..." button, to the same resolved target screen.
  it('clicking a roster row calls onNavigate with the node\'s resolved target screen', () => {
    const roster = [
      { entityId: 'g1', name: 'Shoresh', state: 'understood', decisionId: null, group: 'Age Division: Amitim' },
    ]
    let navigatedTo = null
    render(
      <RootMapPanel
        model={modelWithRoster(roster)}
        selection={{ type: 'node', domainKey: 'Structure', childKey: 'Groups' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{}}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={(target) => { navigatedTo = target }}
        onClearSelection={noop}
      />,
    )
    screen.getByText('Shoresh').click()
    expect(navigatedTo).toBe('groups')
  })

  // Context wiring (Slice 3, docs/adr/2026-08-19-roots-census-and-persistent-
  // inspector.md §(g)) — a Field Trips roster row carries its own resolved
  // targetScreen (manual vs. generated route); it must win over the child's
  // single fixed screenForNode target.
  it('a roster entry with its own targetScreen navigates there instead of the node-level target', () => {
    const model = {
      domains: [
        {
          key: 'Context', label: 'Context', state: 'understood', x: 0.5, y: 0.5,
          children: [
            {
              key: 'Field Trips / Special Events', name: 'Field Trips / Special Events', count: 0, state: 'understood', x: 0.5, y: 0.5, decisionIds: [],
              roster: [{ entityId: 'ft1', name: 'Field Trip — Monday', state: 'understood', decisionId: null, group: null, targetScreen: 'schedule:generated' }],
            },
          ],
        },
      ],
    }
    let navigatedTo = null
    render(
      <RootMapPanel
        model={model}
        selection={{ type: 'node', domainKey: 'Context', childKey: 'Field Trips / Special Events' }}
        lanes={lanes}
        dismissedGaps={new Set()}
        answers={{}}
        onAnswer={noop}
        onDismissGap={noop}
        onUndismissGap={noop}
        expandedEvidence={new Set()}
        onToggleEvidence={noop}
        onNavigate={(target) => { navigatedTo = target }}
        onClearSelection={noop}
      />,
    )
    screen.getByText('Field Trip — Monday').click()
    expect(navigatedTo).toBe('schedule:generated')
  })

  // Red Hat follow-up (inherited Slice 2 gap, surfaced by Slice 3) — a child
  // node with an EMPTY roster (nothing exists there at all) must not read
  // as "Everything here looks right.", which implies a check that found
  // nothing wrong. That copy is reserved for a populated, all-understood
  // roster (or a domain-only selection, which has no roster concept).
  function contextModel(roster) {
    return {
      domains: [
        {
          key: 'Context', label: 'Context', state: 'understood', x: 0.5, y: 0.5,
          children: [
            {
              key: 'Field Trips / Special Events', name: 'Field Trips / Special Events', count: 0, state: 'understood', x: 0.5, y: 0.5, decisionIds: [],
              roster,
            },
          ],
        },
      ],
    }
  }

  it('a child node with an EMPTY roster shows honest "nothing here yet" copy, not "Everything here looks right."', () => {
    render(
      <RootMapPanel
        model={contextModel([])}
        selection={{ type: 'node', domainKey: 'Context', childKey: 'Field Trips / Special Events' }}
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
    expect(screen.getByText('Nothing here yet — open the setup screen to add some.')).toBeTruthy()
    expect(screen.queryByText('Everything here looks right.')).toBeFalsy()
  })

  it('a child node with a non-empty, all-understood roster still shows "Everything here looks right."', () => {
    render(
      <RootMapPanel
        model={contextModel([{ entityId: 'ft1', name: 'Field Trip — Monday', state: 'understood', decisionId: null, group: null, targetScreen: 'schedule:manual' }])}
        selection={{ type: 'node', domainKey: 'Context', childKey: 'Field Trips / Special Events' }}
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
    // Every roster entry is 'understood' (Context inspect rows never have a
    // pending decision), so `scoped` (the decision list) is empty here even
    // though the roster itself is populated.
    expect(screen.getByText('Everything here looks right.')).toBeTruthy()
    expect(screen.queryByText('Nothing here yet — open the setup screen to add some.')).toBeFalsy()
  })
})
