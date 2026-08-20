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

// Design polish #4/#5 — under prefers-reduced-motion the label pill and
// selection ring must drop their scale/radius transform entirely and
// crossfade on opacity only (DESIGN_STANDARD §8), same as every other
// mount transition in the app.
describe('RootMap node label + selection ring under prefers-reduced-motion', () => {
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

  it('renders the selection ring at a fixed r=12 with no radius transition', () => {
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
    const ring = container.querySelector('circle[r="12"]')
    expect(ring).toBeTruthy()
    expect(ring.getAttribute('style') ?? '').not.toContain('r ')
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
