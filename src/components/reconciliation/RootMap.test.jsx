// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import RootMap from './RootMap.jsx'
import { DOMAIN_LABELS } from './domainRollup.js'

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

// RA-6: a quiet always-on resting ring on every orb (interactive affordance
// at rest, independent of hover/selection state).
describe('RootMap resting interactivity ring (RA-6)', () => {
  it('renders an always-on ring per node', () => {
    const { container } = render(
      <RootMap
        model={model()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const rings = [...container.querySelectorAll('circle[stroke="var(--anchor)"]')]
    // one domain node + one child node in `model()`
    expect(rings).toHaveLength(2)
    for (const ring of rings) {
      expect(ring.getAttribute('fill')).toBe('none')
      expect(ring.getAttribute('opacity')).toBe('0.28')
    }
  })
})

// RA-8: static self-describing domain legend beneath the tile row.
describe('RootMap domain legend (RA-8)', () => {
  it('renders the five domain labels in canvas order, joined by middot', () => {
    render(
      <RootMap
        model={model()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const expected = Object.values(DOMAIN_LABELS).join(' · ')
    expect(screen.getByText(expected)).toBeTruthy()
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

  it('lights the selected lantern with a static glow (opacity, not filter) and no transition under reduced motion', () => {
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
    // RA-1: the glow is a separate circle behind the orb <image>, lit via
    // opacity — never an animated/transitioned `filter` on any node.
    const glows = [...container.querySelectorAll('circle[filter="url(#rootmap-glow-blur)"]')]
    const lit = glows.find((o) => (o.getAttribute('style') ?? '').includes('opacity: 0.9'))
    expect(lit).toBeTruthy() // the selected node's glow is lit
    expect(lit.getAttribute('style') ?? '').not.toContain('transition') // reduced motion => no transition

    const images = [...container.querySelectorAll('image')]
    for (const img of images) {
      const style = img.getAttribute('style') ?? ''
      expect(style).not.toContain('filter')
      expect(style).not.toContain('transition')
    }
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

// RA-1 attention pulse + RA-2 hover-glow gating.
describe('RootMap glow state (attention pulse, hover gating)', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  function twoDomainModel() {
    return {
      domains: [
        {
          key: 'Facility',
          label: 'Facility',
          state: 'attention',
          x: 0.5,
          y: 0.5,
          children: [],
        },
        {
          key: 'Staffing',
          label: 'Staffing',
          state: 'understood',
          x: 0.3,
          y: 0.3,
          children: [],
        },
      ],
    }
  }

  it('applies the pulse class to an at-rest attention node, not to an understood node', () => {
    const { container } = render(
      <RootMap
        model={twoDomainModel()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const glows = [...container.querySelectorAll('circle[filter="url(#rootmap-glow-blur)"]')]
    expect(glows).toHaveLength(2)
    const pulsing = glows.filter((g) => g.classList.contains('rootmap-orb--pulse'))
    expect(pulsing).toHaveLength(1)
  })

  it('does not apply the pulse class to a hovered attention node', () => {
    const { container } = render(
      <RootMap
        model={twoDomainModel()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const button = screen.getByRole('button', { name: /Resources/ })
    fireEvent.mouseEnter(button)
    const glows = [...container.querySelectorAll('circle[filter="url(#rootmap-glow-blur)"]')]
    const pulsing = glows.filter((g) => g.classList.contains('rootmap-orb--pulse'))
    expect(pulsing).toHaveLength(0)
  })

  it('does not light the hover glow on a coarse (touch) pointer', () => {
    window.matchMedia = (query) => ({
      matches: false, // no (hover: hover) and (pointer: fine)
      media: query,
      addEventListener: noop,
      removeEventListener: noop,
    })
    const { container } = render(
      <RootMap
        model={twoDomainModel()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const button = screen.getByRole('button', { name: /Resources/ })
    fireEvent.mouseEnter(button)
    const glow = container.querySelector('circle[filter="url(#rootmap-glow-blur)"]')
    expect(glow.getAttribute('style') ?? '').not.toContain('opacity: 0.9')
  })

  it('lights the glow on keyboard focus regardless of pointer type', () => {
    window.matchMedia = (query) => ({
      matches: false, // coarse pointer — hover glow would be gated
      media: query,
      addEventListener: noop,
      removeEventListener: noop,
    })
    const { container } = render(
      <RootMap
        model={twoDomainModel()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const button = screen.getByRole('button', { name: /Resources/ })
    fireEvent.focus(button)
    const glow = container.querySelector('circle[filter="url(#rootmap-glow-blur)"]')
    expect(glow.getAttribute('style') ?? '').toContain('opacity: 0.9')
  })
})

// RA-4 — the hover label waits ~120ms so quick pointer sweeps don't flash it.
describe('RootMap label show-delay (RA-4)', () => {
  const originalMatchMedia = window.matchMedia
  beforeEach(() => {
    vi.useFakeTimers()
    window.matchMedia = (q) => ({ matches: true, media: q, addEventListener: noop, removeEventListener: noop })
  })
  afterEach(() => {
    vi.useRealTimers()
    window.matchMedia = originalMatchMedia
  })
  const delayModel = () => ({
    domains: [{ key: 'Facility', label: 'Facility', state: 'understood', x: 0.5, y: 0.5, children: [] }],
  })

  it('delays the hover label ~120ms and cancels it if the pointer leaves first', () => {
    render(
      <RootMap
        model={delayModel()}
        selection={{ type: 'none' }}
        onSelectTile={noop}
        onSelectNode={noop}
        onClearSelection={noop}
      />,
    )
    const button = screen.getByRole('button', { name: /Resources/ })
    act(() => { fireEvent.mouseEnter(button) })
    expect(screen.queryByText('Resources')).toBeNull() // not shown immediately
    act(() => { vi.advanceTimersByTime(130) })
    expect(screen.queryByText('Resources')).not.toBeNull() // shown after the delay
    act(() => { fireEvent.mouseLeave(button) })
    expect(screen.queryByText('Resources')).toBeNull()
    // a quick sweep (enter, leave before 120ms) never shows the label
    act(() => {
      fireEvent.mouseEnter(button)
      vi.advanceTimersByTime(60)
      fireEvent.mouseLeave(button)
      vi.advanceTimersByTime(130)
    })
    expect(screen.queryByText('Resources')).toBeNull()
  })
})
