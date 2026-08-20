import buildSchedule, { computeFindings } from '../../engine/buildSchedule'
import { describeWriteFailure } from '../../utils/writeErrorMessage'
import { routeSetter } from './useRouteState'
import { resolveWeekCatalog } from '../../engine/weekCatalog'
import { resolvePriorityForGeneration } from '../../ingest/resolvePriorityForGeneration'

// generate / regenerate / place-anchors, over the T28 repository + the pure
// engine. This hook orchestrates: it calls buildSchedule (pure) and the repo,
// but owns no route state — the route-scoped by-route setters and data come from
// the injected `routeState` (T31's useRouteState); ensureTemplateRow,
// saveSnapshot, resetUndoRedo, statsFor, and setSelectedGroup are injected too.
//
// Two behaviours are load-bearing and preserved verbatim:
//   1. generate()/placeAnchors() build EXPLICIT generated-/manual-route setters
//      (not current-route): they can run from the first-run chooser / a route
//      offer whose onClick calls setRoute(r) immediately before, so the `route`
//      in closure is still the previous one.
//   2. generate() (and placeAnchors) ABORT the destructive replaceWeek if the
//      pre-emptive auto-saveSnapshot fails — no undo point, no bulk replace.
export function useGeneration({
  routeState,
  repo,
  campId,
  setActionError,
  setGenerating,
  resetUndoRedo,
  saveSnapshot,
  ensureTemplateRow,
  setConfirmRegen,
  setSelectedGroup,
  statsFor,
  groups,
  tiers,
  days,
  timeBlocks,
  activities,
  anchors,
  locations,
  weekId,
  activityExclusions,
  groupExclusions,
  locationExclusions,
}) {
  const {
    slotsByRoute,
    setSlotsByRoute,
    setFindingsByRoute,
    setDismissedByRoute,
    setOverlaysByRoute,
    setStatsByRoute,
  } = routeState
  // Writes ONLY to the generated candidate — the manual one is never read,
  // moved or cleared here.
  async function generate() {
    setGenerating(true)
    resetUndoRedo()

    // Explicitly generated-route setters and generated-route DATA, not the
    // current-route ones: this can be invoked from the first-run choice screen,
    // and from a route offer whose onClick calls setRoute(r) immediately before
    // — setRoute does not apply inside that handler, so `route` in closure is
    // still the previous one. placeAnchors() is written the same way.
    const setGenSlots = routeSetter(setSlotsByRoute, 'generated')
    const setGenFindings = routeSetter(setFindingsByRoute, 'generated')
    const setGenDismissed = routeSetter(setDismissedByRoute, 'generated')
    const setGenOverlays = routeSetter(setOverlaysByRoute, 'generated')
    const setGenStats = routeSetter(setStatsByRoute, 'generated')

    const { groups: effGroups, activities: effActivities, anchors: effAnchors } = resolveWeekCatalog({
      groups, activities, anchors,
      weekId,
      activityExclusions: activityExclusions || [],
      groupExclusions: groupExclusions || [],
      locationExclusions: locationExclusions || [],
    })

    const lockedActIds = new Set(effActivities.filter(a => a.is_locked).map(a => a.id))
    const lockedPreplaced = slotsByRoute.generated
      .filter(s => s.activity_id && lockedActIds.has(s.activity_id) && !s.is_released && !s.is_anchor)
      .map(s => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, activityId: s.activity_id }))
    // T41 slice 1 (docs/work/specs/2026-08-20-group-electives-design.md): an
    // authored elective cell is pre-placed/do-not-fill, exactly like a locked
    // activity above — threaded into preplacedSlots via electiveSetId so
    // buildSchedule's engine-skip exclusion picks it up. No author UI writes
    // elective_set_id yet (that is slice 3), so this is a no-op today and
    // becomes load-bearing once that slice lands.
    const electivePreplaced = slotsByRoute.generated
      .filter(s => s.elective_set_id)
      .map(s => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, electiveSetId: s.elective_set_id }))
    const preplacedSlots = [...lockedPreplaced, ...electivePreplaced]

    const result = buildSchedule({ groups: effGroups, tiers, days, timeBlocks, activities: resolvePriorityForGeneration(effActivities), anchors: effAnchors, campId, preplacedSlots, locations })
    setGenFindings(result.findings || [])
    setGenDismissed(new Set())

    // ensureTemplateRow -> writeFields THROWS on any non-applied write (including
    // the SCHEDULE_TEMPLATE_KIND_CONFLICT backstop in electron/ops/projections.js).
    // generate() is invoked as a floating promise from the route offers, so an
    // unguarded throw here would leave `generating` stuck true — a spinner that
    // never resolves and no banner. Fail visibly instead.
    let tid
    try {
      tid = await ensureTemplateRow('generated')
    } catch {
      setActionError('Could not open the generated schedule — nothing was changed. Try again, and tell support if it repeats.')
      setGenerating(false)
      return
    }

    if (slotsByRoute.generated.length > 0) {
      try {
        await saveSnapshot(null, true, 'generated')
      } catch {
        setActionError('Could not save undo point — regeneration cancelled')
        setGenerating(false)
        return
      }
    }

    setActionError(null)
    try {
      // Clear overlays when regenerating (post-generation stamps are re-applied
      // manually), then replace every slot in one transactional bulk_replace.
      await repo.replaceWeek(tid, result.slots)
    } catch (err) {
      setActionError(
        err?.message?.includes('admin role required')
          ? 'Only an admin can regenerate the schedule'
          : describeWriteFailure(err, 'That schedule could not be regenerated.')
      )
      setGenerating(false)
      return
    }
    setGenOverlays([])

    const freshSlots = await repo.reloadSlots(tid)
    setGenSlots(freshSlots)
    setGenStats(statsFor(freshSlots))
    setGenerating(false)
  }

  async function regenFromScratch() {
    setConfirmRegen(false)
    await generate()
  }

  // Starts the manual route's blank week: meals and fixed events already in
  // place, every other cell empty. It writes ONLY to the manual candidate — the
  // generated one is never read, moved or cleared here.
  async function placeAnchors() {
    setGenerating(true)
    // Explicitly manual-route setters, not the current-route ones: this can be
    // invoked from the first-run choice screen, where the route on screen is
    // still whatever it defaulted to.
    const setManualSlots = routeSetter(setSlotsByRoute, 'manual')
    const setManualFindings = routeSetter(setFindingsByRoute, 'manual')
    const setManualDismissed = routeSetter(setDismissedByRoute, 'manual')
    const setManualOverlays = routeSetter(setOverlaysByRoute, 'manual')
    const setManualStats = routeSetter(setStatsByRoute, 'manual')

    // Same week-exclusion pre-pass generate() runs (above): the manual blank
    // week must not lay down anchors for an activity or a fully-excluded group
    // that is marked not to run this week. Without this, a fixed event closed
    // for the week (or a meal for a closed group) would still be placed and,
    // because computeWeekClosures deliberately skips anchors, would never be
    // flagged either.
    const { groups: effGroups, activities: effActivities, anchors: effAnchors } = resolveWeekCatalog({
      groups, activities, anchors,
      weekId,
      activityExclusions: activityExclusions || [],
      groupExclusions: groupExclusions || [],
      locationExclusions: locationExclusions || [],
    })

    const result = buildSchedule({ groups: effGroups, tiers, days, timeBlocks, activities: resolvePriorityForGeneration(effActivities), anchors: effAnchors, campId, locations, anchorsOnly: true })
    setManualFindings(result.findings || [])
    setManualDismissed(new Set())

    // Same guard as generate(): a throw from ensureTemplateRow would otherwise
    // strand `generating` at true with no error on screen.
    let tid
    try {
      tid = await ensureTemplateRow('manual')
    } catch {
      setActionError('Could not open the manual schedule — nothing was changed. Try again, and tell support if it repeats.')
      setGenerating(false)
      return
    }

    if (slotsByRoute.manual.length > 0) {
      try {
        await saveSnapshot(null, true, 'manual')
      } catch {
        setActionError('Could not save undo point — regeneration cancelled')
        setGenerating(false)
        return
      }
    }

    setActionError(null)
    try {
      await repo.replaceWeek(tid, result.slots)
    } catch (err) {
      setActionError(
        err?.message?.includes('admin role required')
          ? 'Only an admin can place anchors'
          : describeWriteFailure(err, 'That anchors could not be placed.')
      )
      setGenerating(false)
      return
    }
    setManualOverlays([])

    const freshSlots = await repo.reloadSlots(tid)
    setManualSlots(freshSlots)
    setManualStats(statsFor(freshSlots))
    // Findings are shown the moment the blank week opens — every activity still
    // under its weekly target, as an honest list of what the week owes you.
    // Computed against the week-effective catalog (effGroups/effActivities) so a
    // closed group or activity does not show up owing time it will never run.
    setManualFindings(computeFindings({ slots: freshSlots, groups: effGroups, activities: effActivities, days }))
    setManualDismissed(new Set())
    if (groups.length > 0) setSelectedGroup(prev => prev ?? groups[0].id)
    setGenerating(false)
  }

  return { generate, regenFromScratch, placeAnchors }
}
