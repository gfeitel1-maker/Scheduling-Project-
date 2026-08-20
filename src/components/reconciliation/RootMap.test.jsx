// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import RootMap from './RootMap.jsx'

// Design-polish finding 3: the canvas node must show a visible caption
// (not just aria-label) when selected — asserted via a selected node so
// the test doesn't depend on simulating pointer hover on an SVG foreignObject.

function model() {
  return {
    domains: [
      {
        key: 'Facility',
        label: 'Facility',
        state: 'attention',
        x: 0.5,
        y: 0.5,
        children: [
          { key: 'Locations', name: 'Locations', count: 2, state: 'attention', x: 0.4, y: 0.6, decisionIds: [] },
        ],
      },
    ],
  }
}

function noop() {}

describe('RootMap node label', () => {
  it('renders a visible text caption for the selected node', () => {
    render(
      <RootMap
        model={model()}
        selection={{ type: 'node', domainKey: 'Facility' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    expect(screen.getByText('Resources')).toBeTruthy()
  })
})

// Under prefers-reduced-motion the label pill drops its scale transform and
// crossfades on opacity only (DESIGN_STANDARD §8); the selected lantern still
// shows its glow — a static drop-shadow is not motion — but without a
// transition, so selection stays legible for reduced-motion users.
describe('RootMap node label + selection glow under prefers-reduced-motion', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  function mockReducedMotion() {
    window.matchMedia = (query) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: noop,
      removeEventListener: noop,
    })
  }

  it('lights the selected lantern with a static glow and no transition under reduced motion', () => {
    mockReducedMotion()
    const { container } = render(
      <RootMap
        model={model()}
        selection={{ type: 'node', domainKey: 'Facility' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const orbs = [...container.querySelectorAll('image')]
    const lit = orbs.find((o) => (o.getAttribute('style') ?? '').includes('drop-shadow'))
    expect(lit).toBeTruthy() // the selected node's lantern glows
    expect(lit.getAttribute('style') ?? '').not.toContain('transition') // reduced motion => no transition
  })

  it('renders the label pill with no transform / transform-origin under reduced motion', () => {
    mockReducedMotion()
    render(
      <RootMap
        model={model()}
        selection={{ type: 'node', domainKey: 'Facility' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const text = screen.getByText('Resources')
    const labelGroup = text.closest('g')
    const style = labelGroup.getAttribute('style') ?? ''
    expect(style).not.toContain('transform')
    expect(style).toContain('opacity')
  })
})
