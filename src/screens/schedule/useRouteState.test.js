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

  // T55. Collapse is view state: a Set of block ids, per route, never persisted.
  it('toggleBlockCollapsed flips one block, returns a NEW Set, and stays off the other route', () => {
    const { result } = setup('generated')

    expect(result.current.collapsedBlockIds).toEqual(new Set())

    act(() => { result.current.toggleBlockCollapsed('b2') })
    const first = result.current.collapsedBlockIds
    expect(first).toEqual(new Set(['b2']))
    // A mutated-in-place Set would not re-render the grid.
    expect(first).not.toBe(result.current.collapsedByRoute.manual)
    expect(result.current.collapsedByRoute.manual).toEqual(new Set())

    act(() => { result.current.toggleBlockCollapsed('b5') })
    expect(result.current.collapsedBlockIds).toEqual(new Set(['b2', 'b5']))
    expect(result.current.collapsedBlockIds).not.toBe(first)

    act(() => { result.current.toggleBlockCollapsed('b2') })
    expect(result.current.collapsedBlockIds).toEqual(new Set(['b5']))
  })

  it('setRouteData does not reset collapse — it is view state, not route data', () => {
    const { result } = setup('generated')
    act(() => { result.current.toggleBlockCollapsed('b2') })
    act(() => {
      result.current.setRouteData('generated', {
        slots: [], stats: null, findings: [], dismissed: new Set(), snapshots: [],
      })
    })
    expect(result.current.collapsedBlockIds).toEqual(new Set(['b2']))
  })

  it('setRouteData replaces all five atoms for the named route and leaves the other route untouched', () => {
    const { result } = setup('generated')

    act(() => {
      result.current.setRouteData('generated', {
        slots: [{ id: 's1' }],
        stats: { open: 1, filled: 1 },
        findings: [{ id: 'f1' }],
        dismissed: new Set(['k1']),
        snapshots: [{ id: 'snap1' }],
      })
    })

    expect(result.current.slotsByRoute.generated).toEqual([{ id: 's1' }])
    expect(result.current.statsByRoute.generated).toEqual({ open: 1, filled: 1 })
    expect(result.current.findingsByRoute.generated).toEqual([{ id: 'f1' }])
    expect(result.current.dismissedByRoute.generated).toEqual(new Set(['k1']))
    expect(result.current.snapshotsByRoute.generated).toEqual([{ id: 'snap1' }])

    // Manual route is completely untouched.
    expect(result.current.slotsByRoute.manual).toEqual([])
    expect(result.current.statsByRoute.manual).toBe(null)
    expect(result.current.findingsByRoute.manual).toEqual([])
    expect(result.current.dismissedByRoute.manual).toEqual(new Set())
    expect(result.current.snapshotsByRoute.manual).toEqual([])
  })

  it('setRouteData throws if any of the five required keys is omitted', () => {
    const { result } = setup('generated')

    const full = {
      slots: [], stats: null, findings: [], dismissed: new Set(), snapshots: [],
    }

    for (const key of Object.keys(full)) {
      const partial = { ...full }
      delete partial[key]
      expect(() => {
        act(() => { result.current.setRouteData('generated', partial) })
      }).toThrow()
    }
  })

  it('setRouteData replaces dismissed wholesale, never merges across calls', () => {
    const { result } = setup('generated')

    act(() => {
      result.current.setRouteData('generated', {
        slots: [], stats: null, findings: [], snapshots: [],
        dismissed: new Set(['old-key']),
      })
    })
    expect(result.current.dismissedByRoute.generated).toEqual(new Set(['old-key']))

    act(() => {
      result.current.setRouteData('generated', {
        slots: [], stats: null, findings: [], snapshots: [],
        dismissed: new Set(['new-key']),
      })
    })

    // old-key must be GONE, not merged in alongside new-key.
    expect(result.current.dismissedByRoute.generated).toEqual(new Set(['new-key']))
  })

  it('setRouteData applies existingTemplate/templateId when present and leaves them untouched when omitted', () => {
    const { result } = setup('generated')

    act(() => {
      result.current.setRouteData('generated', {
        slots: [], stats: null, findings: [], dismissed: new Set(), snapshots: [],
        existingTemplate: true,
        templateId: 'tpl-123',
      })
    })
    expect(result.current.existingTemplates.generated).toBe(true)
    expect(result.current.templateIdByRoute.generated).toBe('tpl-123')

    act(() => {
      result.current.setRouteData('generated', {
        slots: [], stats: null, findings: [], dismissed: new Set(), snapshots: [],
      })
    })
    // Omitted -> untouched, still the previously-set values.
    expect(result.current.existingTemplates.generated).toBe(true)
    expect(result.current.templateIdByRoute.generated).toBe('tpl-123')
  })

  it('regression guard: the raw route-explicit setters still work and still target the named route', () => {
    const { result } = setup('generated')

    // useGeneration/useSnapshots write a NON-current route explicitly via these
    // raw setters, bypassing the current-route accessors entirely.
    act(() => {
      result.current.setSlotsByRoute(prev => ({ ...prev, manual: [{ id: 'man-slot' }] }))
      result.current.setFindingsByRoute(prev => ({ ...prev, manual: [{ id: 'man-finding' }] }))
      result.current.setDismissedByRoute(prev => ({ ...prev, manual: new Set(['man-dismissed']) }))
      result.current.setStatsByRoute(prev => ({ ...prev, manual: { open: 9 } }))
      result.current.setSnapshotsByRoute(prev => ({ ...prev, manual: [{ id: 'man-snap' }] }))
    })

    expect(result.current.slotsByRoute.manual).toEqual([{ id: 'man-slot' }])
    expect(result.current.findingsByRoute.manual).toEqual([{ id: 'man-finding' }])
    expect(result.current.dismissedByRoute.manual).toEqual(new Set(['man-dismissed']))
    expect(result.current.statsByRoute.manual).toEqual({ open: 9 })
    expect(result.current.snapshotsByRoute.manual).toEqual([{ id: 'man-snap' }])
    // Current route (generated) untouched by these writes.
    expect(result.current.slotsByRoute.generated).toEqual([])
  })
})
