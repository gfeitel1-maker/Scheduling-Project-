// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import RootMapPanel from './RootMapPanel.jsx'

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
