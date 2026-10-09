import buildSchedule, { computeFindings } from '../../engine/buildSchedule'
import { describeWriteFailure } from '../../utils/writeErrorMessage'
import { routeSetter } from './useRouteState'
import { resolveWeekCatalog } from '../../engine/weekCatalog'
import { resolvePriorityForGeneration } from '../../ingest/resolvePriorityForGeneration'
import { resolveFixedEventActivityIds } from '../../engine/fixedEventActivityLink'
import { dropDeadReferences } from './useSnapshots'

const GENERIC_REFUSAL = "Couldn't generate: a recurring event has no activity."
export const ALL_DAYS_REPLACED = 'Every day this week is a special day, so there is nothing to generate.'

// T350 (ADR 2026-10-09 D4.6): generate() bulk-replaces the whole template, so
// the stored rows of days replaced by a special day are carried forward into
// the payload — hidden, never destroyed — after the same dead-reference guard
// restoreSnapshot uses. Mapped to the engine-slot shape replaceWeek persists.
function carryForwardReplaced(storedSlots, replacedDayIds, catalog) {
  const replaced = new Set(replacedDayIds)
  return dropDeadReferences(storedSlots.filter(s => replaced.has(s.day_id)), catalog).map(s => ({
    group_id: s.group_id, day_id: s.day_id, time_block_id: s.time_block_id,
    activity_id: s.activity_id, fixed_event_id: s.fixed_event_id,
    type: s.is_fixed_event ? 'fixed_event' : 'activity',
    is_span_head: s.is_span_head, flags: s.flags,
  }))
}

function unlinkedEventsMessage(allNames, lead) {
  const names = [...new Set(allNames)]
  return `${lead}: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not linked to a valid activity. Link ${names.length === 1 ? 'it' : 'them'} on the Fixed/Recurring Events screen.`
}

function refusalMessage(findings, fixedEvents) {
  const nameById = new Map((fixedEvents || []).map(fe => [fe.id, fe.name || fe.id]))
  const names = findings.filter(f => f.kind === 'FIXED_EVENT_IDENTITY_GAP' && nameById.has(f.fixedEventId)).map(f => nameById.get(f.fixedEventId))
  return names.length > 0 ? unlinkedEventsMessage(names, 'This schedule could not be generated') : GENERIC_REFUSAL
}

// generate / regenerate / place-fixedEvents, over the T28 repository + the pure
// engine. This hook orchestrates: it calls buildSchedule (pure) and the repo,
// but owns no route state — the route-scoped by-route setters and data come from
// the injected `routeState` (T31's useRouteState); ensureTemplateRow,
// saveSnapshot, resetUndoRedo, statsFor, and setSelectedGroup are injected too.
//
// Two behaviours are load-bearing and preserved verbatim:
//   1. generate()/placeFixedEvents() build EXPLICIT generated-/manual-route setters
//      (not current-route): they can run from the first-run chooser / a route
//      offer whose onClick calls setRoute(r) immediately before, so the `route`
//      in closure is still the previous one.
//   2. generate() (and placeFixedEvents) ABORT the destructive replaceWeek if the
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
  fixedEvents,
  locations,
  electiveSetActivities,
  events,
  weekId,
  replacedDayIds,
  activityExclusions,
  groupExclusions,
  locationExclusions,
}) {
  const {
    slotsByRoute,
    setSlotsByRoute,
    setFindingsByRoute,
    setDismissedByRoute,
    setStatsByRoute,
  } = routeState
  // Writes ONLY to the generated candidate — the manual one is never read,
  // moved or cleared here.
  async function generate() {
    // A week that is all special days has nothing to place: say so, write
    // nothing (ADR D11.1).
    const replacedSet = new Set(replacedDayIds)
    if (days.length > 0 && days.every(d => replacedSet.has(d.id))) {
      setActionError(ALL_DAYS_REPLACED)
      return
    }
    setGenerating(true)
    resetUndoRedo()

    // Explicitly generated-route setters and generated-route DATA, not the
    // current-route ones: this can be invoked from the first-run choice screen,
    // and from a route offer whose onClick calls setRoute(r) immediately before
    // — setRoute does not apply inside that handler, so `route` in closure is
    // still the previous one. placeFixedEvents() is written the same way.
    const setGenSlots = routeSetter(setSlotsByRoute, 'generated')
    const setGenFindings = routeSetter(setFindingsByRoute, 'generated')
    const setGenDismissed = routeSetter(setDismissedByRoute, 'generated')
    const setGenStats = routeSetter(setStatsByRoute, 'generated')

    const { groups: effGroups, activities: effActivities, fixedEvents: effFixedEvents } = resolveWeekCatalog({
      groups, activities, fixedEvents,
      weekId,
      activityExclusions: activityExclusions || [],
      groupExclusions: groupExclusions || [],
      locationExclusions: locationExclusions || [],
    })

    const lockedActIds = new Set(effActivities.filter(a => a.is_locked).map(a => a.id))
    const lockedPreplaced = slotsByRoute.generated
      .filter(s => s.activity_id && lockedActIds.has(s.activity_id) && !s.is_released && !s.is_fixed_event)
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
    // Events overlay placement Slice 1 (docs/adr/2026-08-22-events-overlay-
    // placement.md §6): same posture as electivePreplaced above — an
    // authored event cell is pre-placed/do-not-fill.
    const eventPreplaced = slotsByRoute.generated
      .filter(s => s.event_id)
      .map(s => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, eventId: s.event_id }))
    const preplacedSlots = [...lockedPreplaced, ...electivePreplaced, ...eventPreplaced]

    const result = buildSchedule({ groups: effGroups, tiers, days, timeBlocks, activities: resolvePriorityForGeneration(effActivities), fixedEvents: effFixedEvents, campId, preplacedSlots, locations, electiveSetActivities, events, weekId, replacedDayIds })
    setGenFindings(result.findings || [])
    setGenDismissed(new Set())

    // T267 PR2 (ADR step 5): a fixed event whose activity_id resolves to
    // zero or more than one live activity is a generation-blocking gap, not
    // a silent placement miss — refuse the write rather than persisting a
    // schedule built against a broken identity link. The finding is already
    // visible (setGenFindings above); this only stops replaceWeek.
    if ((result.findings || []).some(f => f.severity === 'error')) {
      setActionError(refusalMessage(result.findings, fixedEvents))
      setGenerating(false)
      return
    }

    // ensureTemplateRow -> writeFields THROWS on any non-applied write (including
    // the SCHEDULE_TEMPLATE_KIND_CONFLICT backstop in electron/ops/projections.js).
    // generate() is invoked as a floating promise from the route offers, so an
    // unguarded throw here would leave `generating` stuck true — a spinner that
    // never resolves and no banner. Fail visibly instead.
    let tid
    try {
      tid = await ensureTemplateRow('generated')
    } catch {
      setActionError("Couldn't open it. Nothing changed.")
      setGenerating(false)
      return
    }

    if (slotsByRoute.generated.length > 0) {
      try {
        await saveSnapshot(null, true, 'generated')
      } catch {
        setActionError("Couldn't save undo point. Cancelled.")
        setGenerating(false)
        return
      }
    }

    setActionError(null)
    try {
      // Replace every slot in one transactional bulk_replace.
      const carried = carryForwardReplaced(slotsByRoute.generated, replacedDayIds, { groups, days, timeBlocks, activities, fixedEvents })
      await repo.replaceWeek(tid, [...result.slots, ...carried])
    } catch (err) {
      setActionError(
        err?.message?.includes('admin role required')
          ? 'Admin only.'
          : describeWriteFailure(err, 'That schedule could not be regenerated.')
      )
      setGenerating(false)
      return
    }

    const freshSlots = await repo.reloadSlots(tid)
    setGenSlots(freshSlots)
    setGenStats(statsFor(freshSlots, replacedDayIds))
    setGenerating(false)
  }

  async function regenFromScratch() {
    setConfirmRegen(false)
    await generate()
  }

  // Starts the manual route's blank week: meals and fixed events already in
  // place, every other cell empty. It writes ONLY to the manual candidate — the
  // generated one is never read, moved or cleared here.
  async function placeFixedEvents() {
    setGenerating(true)
    // Explicitly manual-route setters, not the current-route ones: this can be
    // invoked from the first-run choice screen, where the route on screen is
    // still whatever it defaulted to.
    const setManualSlots = routeSetter(setSlotsByRoute, 'manual')
    const setManualFindings = routeSetter(setFindingsByRoute, 'manual')
    const setManualDismissed = routeSetter(setDismissedByRoute, 'manual')
    const setManualStats = routeSetter(setStatsByRoute, 'manual')

    // Same week-exclusion pre-pass generate() runs (above): the manual blank
    // week must not lay down fixedEvents for an activity or a fully-excluded group
    // that is marked not to run this week. Without this, a fixed event closed
    // for the week (or a meal for a closed group) would still be placed and,
    // because computeWeekClosures deliberately skips fixedEvents, would never be
    // flagged either.
    const { groups: effGroups, activities: effActivities, fixedEvents: effFixedEvents } = resolveWeekCatalog({
      groups, activities, fixedEvents,
      weekId,
      activityExclusions: activityExclusions || [],
      groupExclusions: groupExclusions || [],
      locationExclusions: locationExclusions || [],
    })

    // Packaged audit #16 — an unlinked event blocks Generate (it cannot be
    // placed against an activity), but Manual's blank week only needs the
    // events it CAN place: it lays those down and names the rest.
    const liveIds = new Set(effActivities.map(a => a.id))
    const isLinked = fe => resolveFixedEventActivityIds(fe).filter(id => liveIds.has(id)).length === 1
    const unlinkedNames = effFixedEvents.filter(fe => !isLinked(fe)).map(fe => fe.name || fe.id)
    const result = buildSchedule({ groups: effGroups, tiers, days, timeBlocks, activities: resolvePriorityForGeneration(effActivities), fixedEvents: effFixedEvents.filter(isLinked), campId, locations, electiveSetActivities, events, fixedEventsOnly: true, weekId, replacedDayIds })
    setManualFindings(result.findings || [])
    setManualDismissed(new Set())

    // T267 PR2 (ADR step 5) — same refuse gate as generate(): do not place
    // fixedEvents from a fixed_events row with an unresolvable activity_id.
    if ((result.findings || []).some(f => f.severity === 'error')) {
      setActionError(refusalMessage(result.findings, fixedEvents))
      setGenerating(false)
      return
    }

    // Same guard as generate(): a throw from ensureTemplateRow would otherwise
    // strand `generating` at true with no error on screen.
    let tid
    try {
      tid = await ensureTemplateRow('manual')
    } catch {
      setActionError("Couldn't open it. Nothing changed.")
      setGenerating(false)
      return
    }

    if (slotsByRoute.manual.length > 0) {
      try {
        await saveSnapshot(null, true, 'manual')
      } catch {
        setActionError("Couldn't save undo point. Cancelled.")
        setGenerating(false)
        return
      }
    }

    setActionError(null)
    try {
      const carried = carryForwardReplaced(slotsByRoute.manual, replacedDayIds, { groups, days, timeBlocks, activities, fixedEvents })
      await repo.replaceWeek(tid, [...result.slots, ...carried])
    } catch (err) {
      setActionError(
        err?.message?.includes('admin role required')
          ? 'Admin only.'
          : describeWriteFailure(err, "Couldn't place recurring events.")
      )
      setGenerating(false)
      return
    }

    const freshSlots = await repo.reloadSlots(tid)
    setManualSlots(freshSlots)
    setManualStats(statsFor(freshSlots, replacedDayIds))
    // Findings are shown the moment the blank week opens — every activity still
    // under its weekly target, as an honest list of what the week owes you.
    // Computed against the week-effective catalog (effGroups/effActivities) so a
    // closed group or activity does not show up owing time it will never run.
    // No fixedEvents/weekId here — this is the MANUAL route (placeFixedEvents is the
    // manual blank-week bootstrap), and FIXED_EVENT_DUPLICATE is generated-route
    // only (a manual fixed-event/regular clash already surfaces as OVERLAP).
    setManualFindings(computeFindings({ slots: freshSlots, groups: effGroups, activities: effActivities, days, replacedDayIds }))
    setManualDismissed(new Set())
    if (groups.length > 0) setSelectedGroup(prev => prev ?? groups[0].id)
    if (unlinkedNames.length > 0) setActionError(unlinkedEventsMessage(unlinkedNames, 'Your blank week is ready, but some events were left out'))
    setGenerating(false)
  }

  return { generate, regenFromScratch, placeFixedEvents }
}
