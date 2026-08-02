// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRouteState, ROUTES } from './useRouteState'
import { deriveScheduleTemplateId } from '../../../electron/ops/scheduleTemplateId'

const CAMP = 'camp-1'

function setup(route = 'generated') {
  return renderHook(({ campId, route }) => useRouteState(campId, route), {
    initialProps: { campId: CAMP, route },
  })
}

describe('useRouteState', () => {
  it('scopes a current-route setter to that route only — the other candidate is untouched', () => {
    const { result } = setup('generated')

    act(() => { result.current.setSlots([{ id: 's-gen' }]) })

    // The write landed on the generated candidate...
    expect(result.current.slotsByRoute.generated).toEqual([{ id: 's-gen' }])
    expect(result.current.rawSlots).toEqual([{ id: 's-gen' }])
    // ...and the manual candidate was not touched. This is the cross-candidate
    // write the route separation exists to prevent.
    expect(result.current.slotsByRoute.manual).toEqual([])
  })

  it('the current-route accessors follow `route`, and switching does NOT reset the other route', () => {
    const { result, rerender } = setup('generated')

    act(() => { result.current.setSlots([{ id: 's-gen' }]) })
    act(() => { result.current.setStats({ open: 3, filled: 1 }) })

    // Switch the selected route (as the sidebar would).
    rerender({ campId: CAMP, route: 'manual' })

    // The accessors now read the manual candidate (still empty)...
    expect(result.current.rawSlots).toEqual([])
    expect(result.current.stats).toBe(null)
    // ...while the generated candidate's data SURVIVED the switch — a route
    // switch changes selection, never persisted per-route state.
    expect(result.current.slotsByRoute.generated).toEqual([{ id: 's-gen' }])
    expect(result.current.statsByRoute.generated).toEqual({ open: 3, filled: 1 })

    // And a write on the now-current manual route stays off the generated one.
    act(() => { result.current.setSlots([{ id: 's-man' }]) })
    expect(result.current.slotsByRoute.manual).toEqual([{ id: 's-man' }])
    expect(result.current.slotsByRoute.generated).toEqual([{ id: 's-gen' }])
  })

  it('templateIdFor falls back to the derived id when a route has no row, for either route', () => {
    const { result } = setup('generated')

    // No schedule_templates row resolved yet -> derived id (the mint-time value).
    expect(result.current.templateIdFor('generated')).toBe(deriveScheduleTemplateId(CAMP, 'generated'))
    expect(result.current.templateIdFor('manual')).toBe(deriveScheduleTemplateId(CAMP, 'manual'))
    // templateId is templateIdFor(currentRoute).
    expect(result.current.templateId).toBe(deriveScheduleTemplateId(CAMP, 'generated'))

    // Once a real (e.g. random-UUID) row id is recorded, that wins over the
    // derived fallback.
    act(() => { result.current.setTemplateIdByRoute({ generated: 'random-uuid-xyz', manual: null }) })
    expect(result.current.templateIdFor('generated')).toBe('random-uuid-xyz')
    expect(result.current.templateId).toBe('random-uuid-xyz')
  })

  it('exposes both routes with no canonical designation', () => {
    const { result } = setup('generated')

    // Both routes are first-class; the module names them without ranking.
    expect(ROUTES).toEqual(['generated', 'manual'])

    // The returned surface carries no key that would elect one candidate as the
    // real/active/default one — that designation is precisely what the
    // plural-candidate ADR forbids.
    const canonicalKeys = Object.keys(result.current).filter(k =>
      /canonical|active|default|primary|current|winner|chosen/i.test(k)
    )
    expect(canonicalKeys).toEqual([])
  })
})
