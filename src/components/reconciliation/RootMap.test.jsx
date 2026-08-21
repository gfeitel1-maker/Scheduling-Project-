// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import RootMap from './RootMap.jsx'
import { DOMAIN_LABELS } from './domainRollup.js'

// Foundation-first stacked layout (docs/work/specs/2026-08-21-roots-metaphor-visual.md)
// — RootMap.jsx replaced its SVG orb/backdrop canvas with plain-DOM domain
// layers and button chips. These tests assert the new DOM shape.

function noop() {}

function model({ domainState = 'attention', domains } = {}) {
  return {
    domains: domains ?? [
      {
        key: 'Facility',
        label: 'Facility',
        state: domainState,
        children: [
          { key: 'Locations', name: 'Locations', count: 2, state: 'attention', decisionIds: ['d1'] },
        ],
      },
    ],
  }
}

function fiveDomainModel() {
  return {
    domains: [
      { key: 'Structure', label: 'Structure', state: 'understood', children: [
        { key: 'Program', name: 'Program', count: 1, state: 'understood', decisionIds: [] },
      ] },
      { key: 'Scheduling', label: 'Scheduling', state: 'changed', children: [
        { key: 'Activities', name: 'Activities', count: 1, state: 'changed', decisionIds: [] },
      ] },
      { key: 'Time', label: 'Time', state: 'understood', children: [
        { key: 'Days', name: 'Days', count: 1, state: 'understood', decisionIds: [] },
      ] },
      { key: 'Facility', label: 'Facility', state: 'attention', children: [
        { key: 'Locations', name: 'Locations', count: 1, state: 'attention', decisionIds: ['d1'] },
      ] },
      { key: 'Context', label: 'Context', state: 'absent', children: [] },
    ],
  }
}

describe('RootMap domain layers', () => {
  it('renders all five domains from model.domains, in order, as layer headers', () => {
    render(
      <RootMap
        model={fiveDomainModel()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    for (const key of Object.values(DOMAIN_LABELS)) {
      expect(screen.getByText(key)).toBeTruthy()
    }
  })

  it('renders an empty-domain teaching note when a domain has zero children', () => {
    render(
      <RootMap
        model={fiveDomainModel()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.getByText(/No entities imported yet — this layer has no root\./)).toBeTruthy()
  })
})

describe('RootMap chips', () => {
  it('renders each child as a real button with an aria-label and aria-pressed', () => {
    render(
      <RootMap
        model={model()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const chip = screen.getByRole('button', { name: 'Locations — Not yet rooted' })
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.getAttribute('aria-pressed')).toBe('false')
  })

  it('uses the pinned status label per state', () => {
    render(
      <RootMap
        model={model({
          domains: [
            {
              key: 'Structure',
              label: 'Structure',
              state: 'understood',
              children: [
                { key: 'A', name: 'A', count: 1, state: 'understood', decisionIds: [] },
                { key: 'B', name: 'B', count: 1, state: 'changed', decisionIds: [] },
                { key: 'C', name: 'C', count: 1, state: 'attention', decisionIds: [] },
                { key: 'D', name: 'D', count: 0, state: 'not_set_up', decisionIds: [] },
              ],
            },
          ],
        })}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.getByRole('button', { name: 'A — Rooted' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'B — Rooted · Changed' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'C — Not yet rooted' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'D — Not started' })).toBeTruthy()
  })

  it('every chip stays clickable regardless of state, calling onSelectNode', () => {
    const onSelectNode = vi.fn()
    render(
      <RootMap
        model={model({
          domains: [
            {
              key: 'Structure',
              label: 'Structure',
              state: 'understood',
              children: [{ key: 'A', name: 'A', count: 1, state: 'understood', decisionIds: [] }],
            },
          ],
        })}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={onSelectNode}
        onClearSelection={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'A — Rooted' }))
    expect(onSelectNode).toHaveBeenCalledWith('Structure', 'A')
  })

  it('dims chips that do not match an active tile filter', () => {
    const { container } = render(
      <RootMap
        model={model()}
        selection={{ type: 'tile', state: 'understood' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const chip = screen.getByRole('button', { name: 'Locations — Not yet rooted' })
    expect(chip.getAttribute('style') ?? '').toContain('opacity: 0.35')
    expect(container).toBeTruthy()
  })

  it('gives a selected chip a distinct state-colored border', () => {
    render(
      <RootMap
        model={model()}
        selection={{ type: 'node', domainKey: 'Facility', childKey: 'Locations' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const chip = screen.getByRole('button', { name: 'Locations — Not yet rooted' })
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(chip.getAttribute('style') ?? '').toContain('var(--accent)')
  })
})

describe('RootMap info layer (provenance + why)', () => {
  it('surfaces a one-line why for a decision-backed attention chip', () => {
    render(
      <RootMap
        model={model()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
        decisionsById={new Map([
          ['d1', { id: 'd1', confidence: 'medium', reason: 'Only appeared once', unknowns: [], evidence: null }],
        ])}
      />,
    )
    expect(screen.getByText('Only appeared once')).toBeTruthy()
  })

  it('renders no why line for a chip with no decisions', () => {
    render(
      <RootMap
        model={model({
          domains: [
            {
              key: 'Structure',
              label: 'Structure',
              state: 'understood',
              children: [{ key: 'A', name: 'A', count: 1, state: 'understood', decisionIds: [] }],
            },
          ],
        })}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
        decisionsById={new Map()}
      />,
    )
    // No "why" text node should render for a clean, decision-less chip.
    expect(screen.queryByText(/inferred|clearly stated|guess|conflict/)).toBeNull()
  })
})

describe('RootMap filter row (tile toggles)', () => {
  it('renders the 4 state-count toggle buttons with counts and labels', () => {
    render(
      <RootMap
        model={model()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.getByText('Needs attention').closest('button')).toBeTruthy()
    expect(screen.getByText('Understood').closest('button')).toBeTruthy()
    expect(screen.getByText('Changed').closest('button')).toBeTruthy()
    expect(screen.getByText('Not in source').closest('button')).toBeTruthy()
  })

  it('toggles aria-pressed per tag and clicking twice clears the selection', () => {
    let selection = { type: 'none' }
    const onSelectTile = vi.fn((state) => { selection = { type: 'tile', state } })
    const onClearSelection = vi.fn(() => { selection = { type: 'none' } })
    const { rerender } = render(
      <RootMap
        model={model()}
        selection={selection}
        onSelectTile={onSelectTile}
        onSelectNode={noop}
        onClearSelection={onClearSelection}
      />,
    )
    const attentionTag = screen.getByText('Needs attention').closest('button')
    expect(attentionTag.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(attentionTag)
    expect(onSelectTile).toHaveBeenCalledWith('attention')
    rerender(
      <RootMap
        model={model()}
        selection={{ type: 'tile', state: 'attention' }}
        onSelectTile={onSelectTile}
        onSelectNode={noop}
        onClearSelection={onClearSelection}
      />,
    )
    const activeTag = screen.getByText('Needs attention').closest('button')
    expect(activeTag.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(activeTag)
    expect(onClearSelection).toHaveBeenCalled()
  })
})

describe('RootMap domain-level selection', () => {
  it('makes the domain header selectable, preserving onSelectNode(domainKey, null)', () => {
    const onSelectNode = vi.fn()
    render(
      <RootMap
        model={model()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={onSelectNode}
        onClearSelection={noop}
      />,
    )
    const header = screen.getByRole('button', { name: /Facility/ })
    fireEvent.click(header)
    expect(onSelectNode).toHaveBeenCalledWith('Facility', undefined)
  })
})

describe('RootMap attention pulse scoping', () => {
  function twoDomainModel() {
    return {
      domains: [
        {
          key: 'Facility',
          label: 'Facility',
          state: 'attention',
          children: [{ key: 'Locations', name: 'Locations', count: 1, state: 'attention', decisionIds: [] }],
        },
        {
          key: 'Structure',
          label: 'Structure',
          state: 'attention',
          children: [{ key: 'Groups', name: 'Groups', count: 1, state: 'attention', decisionIds: [] }],
        },
      ],
    }
  }

  it('only pulses attention chips within the selected/focused domain layer', () => {
    const { container } = render(
      <RootMap
        model={twoDomainModel()}
        selection={{ type: 'node', domainKey: 'Facility' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const pulsing = [...container.querySelectorAll('[data-pulse="true"]')]
    expect(pulsing).toHaveLength(1)
    expect(pulsing[0].getAttribute('aria-label')).toContain('Locations')
  })

  it('pulses nothing when no domain is focused/selected', () => {
    const { container } = render(
      <RootMap
        model={twoDomainModel()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    expect(container.querySelectorAll('[data-pulse="true"]')).toHaveLength(0)
  })
})

describe('RootMap canvasWrap ref', () => {
  it('forwards canvasWrapRef to the domain-stack wrapper', () => {
    const ref = createRef()
    render(
      <RootMap
        model={model()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
        canvasWrapRef={ref}
      />,
    )
    expect(ref.current).toBeInstanceOf(HTMLElement)
  })
})

describe('RootMap hover confirm-hint (attention-only, focus-visible unconditional)', () => {
  const originalMatchMedia = window.matchMedia
  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('shows the confirm hint on focus even on a coarse pointer', () => {
    window.matchMedia = (query) => ({ matches: false, media: query, addEventListener: noop, removeEventListener: noop })
    render(
      <RootMap
        model={model()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const chip = screen.getByRole('button', { name: 'Locations — Not yet rooted' })
    fireEvent.focus(chip)
    expect(screen.getByText('Click to confirm →')).toBeTruthy()
  })
})

describe('RootMap reduced motion', () => {
  const originalMatchMedia = window.matchMedia
  beforeEach(() => {
    window.matchMedia = (query) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: noop,
      removeEventListener: noop,
    })
  })
  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('still renders chips and layers under reduced motion', () => {
    render(
      <RootMap
        model={fiveDomainModel()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.getByRole('button', { name: 'Locations — Not yet rooted' })).toBeTruthy()
  })
})
