import { useState } from 'react'
import { deriveScheduleTemplateId } from '../../../electron/ops/scheduleTemplateId'

// Two routes to a schedule, each with its own candidate: the director builds one
// themselves (the spreadsheet replacement) or the app proposes one and they edit
// it. NEITHER is the real schedule — that call is the director's, and the app
// must never make it for them (CONSTITUTION.md Art. V, and the ADR on plural
// candidate schedules). This hook owns the route-SCOPED state; it takes no view
// of which route is "the" one, and nothing here designates a canonical route.
// Route SELECTION is local UI state driven by the sidebar and stays in the
// screen — this hook only receives the resulting `route`.
export const ROUTES = ['generated', 'manual']
export const EMPTY_BY_ROUTE = (value) => ({ generated: value(), manual: value() })

// Turns a setXByRoute setter into one scoped to a single route key, so the
// ~20 existing call sites keep writing `setSlots(prev => ...)` exactly as they
// did while the value they touch is that route's. Shared by useGeneration and
// useSnapshots (route-explicit setters) so there is one implementation.
export function routeSetter(setState, route) {
  return updater =>
    setState(prev => ({
      ...prev,
      [route]: typeof updater === 'function' ? updater(prev[route]) : updater,
    }))
}

// The route-scoped state for the schedule screen: the eight by-route atoms, the
// current-route derived values, and the current-route setters. `weekId` (the
// schedule_weeks row currently on screen — docs/adr/2026-08-02-schedule-weeks-first-class.md)
// and the currently selected `route` are inputs; route selection itself is not
// owned here.
export function useRouteState(weekId, route) {
  // Which routes actually have a schedule_templates row today.
  const [existingTemplates, setExistingTemplates] = useState(() => EMPTY_BY_ROUTE(() => false))
  // The id a route's schedule_templates row ACTUALLY has. Resolved from the
  // database by (camp_id, kind) in the screen's loadAll; the derived id below is
  // only a fallback used when minting a row that does not exist yet.
  const [templateIdByRoute, setTemplateIdByRoute] = useState(() => ({ generated: null, manual: null }))
  const [slotsByRoute, setSlotsByRoute] = useState(() => EMPTY_BY_ROUTE(() => []))
  const [statsByRoute, setStatsByRoute] = useState(() => EMPTY_BY_ROUTE(() => null))
  // Aggregate UNDERSERVED/DISTRIBUTION findings from the last buildSchedule()
  // call — never persisted, recomputed fresh on every generate()/placeAnchors()
  // (docs/adr/2026-07-28-schedule-flag-findings-reshape.md §"findings never persisted").
  const [findingsByRoute, setFindingsByRoute] = useState(() => EMPTY_BY_ROUTE(() => []))
  const [dismissedByRoute, setDismissedByRoute] = useState(() => EMPTY_BY_ROUTE(() => new Set()))
  const [snapshotsByRoute, setSnapshotsByRoute] = useState(() => EMPTY_BY_ROUTE(() => []))
  // T55. Which time blocks are folded to a thin strip. View state only: it is
  // deliberately NOT persisted and NOT part of setRouteData's replace payload —
  // it never reaches the database, the op-log or PROJECTIONS, and a reload
  // starts with every period open (see the T55 closure note). It is by-route
  // for the same reason everything else here is: the two candidates are
  // independent, and folding Lunch on one must not fold it on the other.
  const [collapsedByRoute, setCollapsedByRoute] = useState(() => EMPTY_BY_ROUTE(() => new Set()))

  // The derived id is only a fallback: two devices that independently create a
  // candidate for the same camp and route must agree on its id or their work
  // forks, so an un-minted route derives deterministically rather than at random.
  const templateIdFor = (r) => templateIdByRoute[r] || deriveScheduleTemplateId(weekId, r)
  const templateId = templateIdFor(route)

  // Everything below reads and writes the CURRENT route's candidate. Names and
  // shapes are unchanged from the single-schedule version on purpose.
  const rawSlots = slotsByRoute[route]
  const stats = statsByRoute[route]
  const findings = findingsByRoute[route]
  const dismissedFindingKeys = dismissedByRoute[route]
  const snapshots = snapshotsByRoute[route]
  const collapsedBlockIds = collapsedByRoute[route]

  const setSlots = routeSetter(setSlotsByRoute, route)
  const setStats = routeSetter(setStatsByRoute, route)
  const setFindings = routeSetter(setFindingsByRoute, route)
  const setDismissedFindingKeys = routeSetter(setDismissedByRoute, route)
  const setSnapshots = routeSetter(setSnapshotsByRoute, route)
  const setCollapsedBlockIds = routeSetter(setCollapsedByRoute, route)

  // A new Set every time: the grid reads it during render and a mutated-in-place
  // Set would not re-render.
  function toggleBlockCollapsed(blockId) {
    setCollapsedBlockIds(prev => {
      const next = new Set(prev)
      if (!next.delete(blockId)) next.add(blockId)
      return next
    })
  }

  // Bulk per-route replace for loadAll's shape: one call instead of six+
  // scattered setters. This does NOT narrow the interface below — every raw
  // by-route setter stays exported, because useGeneration/useSnapshots must
  // keep writing a NON-current route explicitly (generate() on Manual must
  // never land in the visible Manual state). The six data keys are REPLACE
  // semantics, not merge, and all required: a partial call throws rather than
  // silently leaving a stale field. dismissed is replaced wholesale too —
  // dismissal state resets when findings recompute, never merges across calls.
  function setRouteData(r, payload) {
    const required = ['slots', 'stats', 'findings', 'dismissed', 'snapshots']
    for (const key of required) {
      if (payload[key] === undefined) {
        throw new Error(`setRouteData: missing required key "${key}" for route "${r}"`)
      }
    }
    setSlotsByRoute(prev => ({ ...prev, [r]: payload.slots }))
    setStatsByRoute(prev => ({ ...prev, [r]: payload.stats }))
    setFindingsByRoute(prev => ({ ...prev, [r]: payload.findings }))
    setDismissedByRoute(prev => ({ ...prev, [r]: payload.dismissed }))
    setSnapshotsByRoute(prev => ({ ...prev, [r]: payload.snapshots }))
    if (payload.existingTemplate !== undefined) {
      setExistingTemplates(prev => ({ ...prev, [r]: payload.existingTemplate }))
    }
    if (payload.templateId !== undefined) {
      setTemplateIdByRoute(prev => ({ ...prev, [r]: payload.templateId }))
    }
  }

  return {
    route,
    // The by-route atoms + their raw setters: loadAll's bulk sets and
    // generate()/placeAnchors()' route-explicit setters write through these.
    existingTemplates, setExistingTemplates,
    templateIdByRoute, setTemplateIdByRoute,
    slotsByRoute, setSlotsByRoute,
    statsByRoute, setStatsByRoute,
    findingsByRoute, setFindingsByRoute,
    dismissedByRoute, setDismissedByRoute,
    snapshotsByRoute, setSnapshotsByRoute,
    collapsedByRoute, setCollapsedByRoute,
    // Current-route id resolution.
    templateIdFor, templateId,
    // Current-route derived values.
    rawSlots, stats, findings, dismissedFindingKeys, snapshots, collapsedBlockIds,
    // Current-route setters.
    setSlots, setStats, setFindings, setDismissedFindingKeys, setSnapshots,
    setCollapsedBlockIds, toggleBlockCollapsed,
    // Bulk per-route replace (see setRouteData above).
    setRouteData,
  }
}
