import { useState, useEffect, useMemo, useRef } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { localClient } from '../localClient'
import { cellKeyboardCoordinates } from './schedule/cellKeyboardCoordinates'
import { UndoIcon } from '../components/icons'
import { createScheduleRepository } from '../data/scheduleRepository'
import { getSetupGaps, describeSetupGaps } from '../engine/readiness'
import { everyDayReplaced } from '../engine/effectiveDays'
import { S, useEnterTransition } from '../styles/shared'
import StatBadge from '../components/schedule/StatBadge'
import ScheduleSkeleton from '../components/schedule/ScheduleSkeleton'
import IndeterminateBar from '../components/schedule/IndeterminateBar'
import ErrorBanner from '../components/schedule/ErrorBanner'
import GenerationBlockedNotice from '../components/schedule/GenerationBlockedNotice'
import { legendEntriesFor, FLAG_SEVERITY, setActivityPalette } from '../components/schedule/slotCellConstants'
import FindingsRail from '../components/schedule/FindingsRail'
import { highlightMapForKind, railEmptyText } from './schedule/findingHighlight'
import ConfirmRegenModal from '../components/schedule/ConfirmRegenModal'
import ExportChooserModal from '../components/schedule/ExportChooserModal'
import VersionsDropdown from '../components/schedule/VersionsDropdown'
import WeekSwitcher from '../components/schedule/WeekSwitcher'
import { snapshotMatchesSchedule } from './snapshotMatchesSchedule'
import { exportToExcel } from '../utils/exportSchedule'
import { buildScheduleExport } from '../utils/exportScheduleJson'
import { withOverlapFlags } from '../utils/computeOverlaps'
import { withWeekClosureFlags } from '../utils/computeWeekClosures'
import { deriveScheduleTemplateId } from '../../electron/ops/scheduleTemplateId'
import { resolveSelection } from './resolveSelection'
import { getSlot, makeGridGeometry } from './schedule/gridGeometry'
import { makeDragHandlers } from './schedule/dragHandlers'
import { useDragFSM } from './schedule/useDragFSM'
import GridDragSurface from './schedule/GridDragSurface'
import { useUndoRedo } from './schedule/useUndoRedo'
import { useClipboardSelection } from './schedule/useClipboardSelection'
import { useSpanExtendDrag } from './schedule/useSpanExtendDrag'
import { useSnapshots } from './schedule/useSnapshots'
import { useWeeks } from './schedule/useWeeks'
import DeleteWeekDialog from '../components/schedule/DeleteWeekDialog'
import { useGeneration } from './schedule/useGeneration'
import { useSlotMutations } from './schedule/useSlotMutations'
import { ROUTES, useRouteState } from './schedule/useRouteState'
import { useScheduleData, recalcStats as recalcStatsPure, recalcFindings as recalcFindingsPure, unfillableSlots as unfillableSlotsPure } from './schedule/useScheduleData'
import { findingDismissKey } from './schedule/findingKey'
import { useFlagChangeAck } from './schedule/useFlagChangeAck'
import { useContentRaceFlag } from './schedule/useContentRaceFlag'
import ScheduleGroupView from '../components/schedule/ScheduleGroupView'
import ScheduleDayView from '../components/schedule/ScheduleDayView'
import ScheduleActivityView from '../components/schedule/ScheduleActivityView'
import ManualBuildView from '../components/schedule/ManualBuildView'
import ActivityPalette from '../components/schedule/ActivityPalette'
import { isActivityEligibleForGroup } from '../engine/eligibility'
import { filterFreeChoiceActivities } from '../engine/freeChoiceActivities'

// dnd-kit's own announcer describes droppable IDs, which after T58 are one
// container rather than 480 cells — it would say "over droppable
// schedule-grid-surface" for every gesture. The FSM's live region announces the
// actual cell instead, so dnd-kit's is silenced rather than left to contradict
// it. Returning undefined suppresses the announcement.
const SILENCE_DNDKIT_ANNOUNCEMENTS = {
  onDragStart: () => undefined,
  onDragMove: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
}

export default function ScheduleScreen({ campId, role, onNavigate, initialRoute }) {
  // Which route is on screen is driven by the sidebar entry the director
  // clicked (App.jsx SCREENS -> 'schedule:manual' / 'schedule:generated'). The
  // neutral 'schedule' entry passes nothing and lands on the first-run choice
  // screen when neither route has been started. Nothing here designates a
  // canonical schedule.
  // When the shell supplies a route (the sidebar destinations) it wins
  // outright — no effect, no local copy to drift out of step. `setRoute` still
  // exists for the neutral 'schedule' entry, which supplies nothing.
  // null until the director picks. It stays null only on the neutral 'schedule'
  // entry; the fallback below is a rendering necessity (every read is keyed by
  // route), NOT a designation — when both candidates exist and nothing has been
  // picked, the screen asks instead of showing this fallback. See the
  // neutral-entry chooser further down.
  const [localRoute, setRoute] = useState(null)
  const route = initialRoute || localRoute || 'generated'
  const enterStyle = useEnterTransition('liftFade')
  // Which week is on screen — a camp may hold several (docs/adr/2026-08-02-
  // schedule-weeks-first-class.md). Screen-level state, symmetric to `route`:
  // switching weeks is pure navigation, no confirm, nothing saved or destroyed.
  // `preferredWeekId` is a ONE-WAY input into useScheduleData — the director's
  // last explicit choice (switcher pick, new/archived/deleted week), fed back
  // in below so a reload (e.g. from onOpApplied) keeps showing the same week
  // instead of resetting to the first one. It is NOT what the rest of the
  // screen reads for the week actually on screen — that is the hook's
  // resolved `weekId` below, always current with no render lag. Not a shared
  // mutable cell: the hook never reads this after resolving a load.
  const [preferredWeekId, setPreferredWeekId] = useState(null)

  // The persistence seam. Instantiated once with the real localClient (ADR
  // 2026-08-01 §3); it owns token acquisition, every schedule read/write, and
  // the single slot->row mapper. The screen keeps all React state, banner copy,
  // route policy, and engine calls.
  const repo = useMemo(() => createScheduleRepository({ localClient }), [])

  // C1 — setup catalog, weeks + weekId resolution, week exclusions, and
  // per-route template data (slots/snapshots/stats/findings), plus
  // load/error state, all live in one hook with one load lifecycle. It never
  // touches useRouteState (route data flows out, never in) and designates
  // neither route as canonical. `weekId` below is the RESOLVED week — the
  // authority every other call site (routeState, ensureTemplateRow,
  // useGeneration, the switcher's highlighted value) reads.
  // T107 item 3 — useScheduleData's repair-on-read pass (R2) needs to ask
  // useSlotMutations' cellQueueRef "is there an in-flight local claim on this
  // group/day", but useSlotMutations is instantiated below (it needs slots
  // from templateData, which useScheduleData produces) — a ref breaks the
  // ordering dependency: useScheduleData reads through it every load,
  // useSlotMutations points it at its real hasInFlightClaim once created.
  const hasInFlightClaimRef = useRef(() => false)
  const {
    setupLists, setActivities, weeks, setWeeks,
    weekId, weekDeletedBanner, setWeekDeletedBanner, exclusions, replacedDayIds, replacements, specialDaysReadFailed,
    templateData, loading, loadError, templateError, reload,
  } = useScheduleData({
    campId, weekId: preferredWeekId, repo, routes: ROUTES,
    hasInFlightClaim: (groupId, dayId) => hasInFlightClaimRef.current(groupId, dayId),
  })
  const { groups, days, timeBlocks, activities, fixedEvents, tiers, cohorts, locations, electiveSetsAll, electiveSetActivities, durableElectiveSets, eventsAll } = setupLists
  // T105 §4/§6 render/export lookup — one member-id array per elective set,
  // built once per electiveSetActivities change.
  const electiveMembersBySet = useMemo(() => {
    const map = new Map()
    for (const m of electiveSetActivities || []) {
      if (!map.has(m.elective_set_id)) map.set(m.elective_set_id, [])
      map.get(m.elective_set_id).push(m.activity_id)
    }
    return map
  }, [electiveSetActivities])
  const { activityExclusions, groupExclusions, locationExclusions } = exclusions

  // Keep `preferredWeekId` converged with the resolved week so the NEXT load
  // (e.g. a reload from onOpApplied, or simply campId changing) starts from
  // where the director actually is, not from null. Purely forward-looking —
  // nothing reads `preferredWeekId` for the current render, so the one-render
  // lag between a load resolving and this effect committing is harmless.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (weekId !== preferredWeekId) setPreferredWeekId(weekId)
  }, [weekId]) // eslint-disable-line react-hooks/exhaustive-deps

  // T31 — the route-scoped state lives in one module (useRouteState): the eight
  // by-route atoms, the current-route derived values, and the current-route
  // setters. Route SELECTION stays here (above) — the hook only receives the
  // resulting route and owns no canonical designation. Names and shapes are
  // unchanged from the single-schedule version on purpose, so the ~20 call sites
  // below keep reading `slots`/`templateId`/`setSlots` verbatim.
  const routeState = useRouteState(weekId, route)
  const {
    existingTemplates, setExistingTemplates,
    setTemplateIdByRoute,
    slotsByRoute,
    templateIdFor,
    rawSlots, stats, findings, dismissedFindingKeys, snapshots,
    setStats, setFindings, setDismissedFindingKeys,
    collapsedBlockIds, toggleBlockCollapsed,
  } = routeState
  // OVERLAP and WEEK_CLOSED are both derived, never persisted — so they clear
  // from every participating cell the moment the underlying condition changes.
  //
  // WEEK_CLOSED derives on BOTH routes: a placement of something marked not to
  // run this week (see src/utils/computeWeekClosures.js) is equally wrong on
  // either route, and the generated route can acquire one two ways generation's
  // resolveWeekCatalog pre-pass can't catch — a post-generation drag edit, or an
  // activity/group marked closed AFTER the week was generated. Because it is
  // derived from the rendered slots (not stamped at write time), it covers every
  // placement path — drag, click, paste, inline-create — on both routes.
  // (location exclusions are a fast-follow once slice M5 lands their producer.)
  //
  // OVERLAP derives on BOTH routes (T159) — see the fuller note at the
  // withOverlapFlags call below. This block used to say it was manual-only,
  // fourteen lines above the code that already did otherwise.
  const slots = useMemo(
    () => {
      const withClosures = withWeekClosureFlags(rawSlots, {
        activities,
        groups,
        locations,
        activityExclusions,
        groupExclusions,
        locationExclusions,
        weekId,
      })
      // T159: OVERLAP derives on BOTH routes now, exactly like WEEK_CLOSED
      // above and for the same reason. It used to be manual-only because a
      // clash could only ever arrive by hand — the engine refuses to create
      // one. Under CRDT sync it can arrive another way: two directors editing
      // offline each move a group into the same place, the documents merge
      // cleanly, and nobody is told. The stance ("the engine refuses clashes
      // rather than making them") is still true of GENERATION and no longer
      // true of the route, so the marker follows the state, not the origin.
      return withOverlapFlags(withClosures, activities, locations, electiveSetActivities, timeBlocks)
    },
    // `route` is deliberately absent: since T159 nothing in this memo reads it
    // (OVERLAP derives on both routes), and rawSlots already changes when the
    // route does. It lingered here as a leftover of the same change that left
    // the stale comment above — flagged by react-hooks/exhaustive-deps.
    [rawSlots, activities, locations, groups, activityExclusions, groupExclusions, locationExclusions, weekId, electiveSetActivities, timeBlocks]
  )
  // The generated "track changes" review (docs/work/specs/2026-08-01-generated-
  // flag-review.md). One piece of state is the single source of truth for both
  // the review list and the grid highlight:
  //   null                -> list closed, grid calm
  //   'ALL'               -> list open showing every concern, grid stays calm
  //   'UNFILLABLE' | ...  -> list filtered to that concern AND its cells lit
  // Deriving the rail-open flag and the highlighted kind from this one value is
  // what stops the "list open but nothing highlighted / highlighted but list
  // closed" drift the two design passes disagreed about.
  const [railView, setRailView] = useState(null)
  const [generating, setGenerating] = useState(false)

  // Move 1 (design spec) — quiet in-place acknowledgement when a single director
  // edit changes a cell's flag state. resyncToken makes the guard action-aware:
  // it is bumped on undo/redo (below) and at generation start, so those non-edit
  // reloads never fire the ack even when they touch <=3 cells (Red Hat 2026-08-09).
  const [flagAckResync, setFlagAckResync] = useState(0)
  const bumpFlagAckResync = () => setFlagAckResync(t => t + 1)
  useFlagChangeAck(slots, route, flagAckResync)

  const [view, setView] = useState('day') // 'group' | 'activity' | 'day'
  const [pickedGroup, setSelectedGroup] = useState(null)
  const [pickedDay, setSelectedDay] = useState(null)
  // Group and Daily View always show one: an unset or stale pick falls to the first.
  const selectedGroup = resolveSelection(pickedGroup, groups)
  const selectedDay = resolveSelection(pickedDay, days)
  const [weatherMode, setWeatherMode] = useState(false)
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [selectedActivity, setSelectedActivity] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [exportChoosing, setExportChoosing] = useState(false)
  const [exportFormat, setExportFormat] = useState('excel')
  const [deletingWeek, setDeletingWeek] = useState(null)
  const [showVersions, setShowVersions] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // 5px, not 8: Windows uses 4, Unity 5, dnd-kit defaults to 5 (spec §5.6).
  // The keyboard sensor is the stated reason @dnd-kit is retained at all — the
  // ADR rejected raw setPointerCapture because it would mean reimplementing it.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: cellKeyboardCoordinates }),
  )
  const localDeviceIdRef = useRef(null)

  // T5 — undo/redo lives in its own hook: the two stacks, the push/undo/redo
  // helpers, and the keyboard shortcuts. It is transient — reset() is called
  // from the transient-reset block below on a route switch.
  const { undoStack, redoStack, pushUndo, handleUndo, handleRedo, reset: resetUndoRedo } = useUndoRedo({ setActionError })

  // T32 — the per-cell slot mutation cluster lives in its own hook: the
  // ~11 handlers that write a slot through the T28 repo and record the
  // undo entry. It owns no state — route-scoped values and the route-PINNED
  // setters come from routeState; pushUndo, recalcStats, the geometry getSlot
  // and the data lists are injected. `slots` is the screen's overlap-flagged
  // value (what the inline handlers read pre-extraction), so prevFlags in the
  // undo closures stays byte-identical.
  const slotMutations = useSlotMutations({
    routeState, repo, pushUndo, setActionError,
    recalcStats, recalcFindings,
    getSlot, setActivities,
    slots, groups, activities, locations, days, timeBlocks, campId,
    electiveSetsAll, durableElectiveSets, electiveSetActivities,
    eventsAll,
    weekId,
  })
  const {
    replaceSlot, dismissFlag, lockActivity, releaseCell,
    placeActivityManual, expandSlot, splitSlot,
    createActivityFromCell, createElectiveFromCell, placeEventOnCell, ownWriteRef,
    hasInFlightClaim,
  } = slotMutations
  // T107 item 3 — point the ref useScheduleData's repair pass reads through
  // at the real hasInFlightClaim now that it exists (see the ref's own
  // comment above, near useScheduleData's call). Assigned in an effect, not
  // during render — a ref write must never happen synchronously in the
  // render body (react-hooks/refs).
  useEffect(() => { hasInFlightClaimRef.current = hasInFlightClaim }, [hasInFlightClaim])

  // T107 item 1 — drag-to-extend (Designer spec 2026-08-21). One instance
  // for the whole screen; expandSlot is already
  // route-agnostic (routed through routeState, ADR §5), so this single
  // instance serves both routes' views below without a parallel
  // implementation.
  const { startExtend: onSpanExtendStart } = useSpanExtendDrag({ slots, timeBlocks, activities, expandSlot })

  // T105 §5 — CONTENT_RACE: derived, render-time, locally-dismissible.
  const { racedKeys, dismiss: dismissContentRace } = useContentRaceFlag(slots, route, ownWriteRef)
  const isContentRaced = (groupId, dayId, blockId) => racedKeys.includes(`${groupId}|${dayId}|${blockId}`)

  // Inline-write cell editor (replaces the removed EditModal picklist,
  // 2026-08-09): eligibleActivitiesFor consumes the same isActivityEligibleForGroup
  // predicate placeActivityManual's UNFILLABLE check uses (src/engine/eligibility.js,
  // T82), so the drag path and the typeahead can never diverge.
  // handleCellPlace mirrors dragHandlers' palette-drop branching (replace if
  // occupied, place if empty) because Enter-to-place is semantically a drop,
  // just typed instead of dragged.
  function eligibleActivitiesFor(groupId) {
    const g = groups.find(g => g.id === groupId)
    if (!g) return []
    // T266 (site 3 of 7) — free-choice exclusion is applied ALONGSIDE the
    // existing group-eligibility filter, deliberately not folded into it. They
    // are different questions: "pass 1/2 already claimed this name" versus "this
    // group does this activity". The eligibility filter below is unchanged.
    return filterFreeChoiceActivities(activities).filter(a => isActivityEligibleForGroup(a, g))
  }

  function handleCellPlace(slot, activityId) {
    const groupId = slot.groupId ?? slot.group_id
    const dayId = slot.dayId ?? slot.day_id
    const blockId = slot.blockId ?? slot.time_block_id
    const targetSlot = getSlot(slots, groupId, dayId, blockId)
    if (targetSlot?.activity_id) {
      replaceSlot({ activityId }, { groupId, dayId, blockId })
    } else {
      // No drag gestureId on this path (click/typeahead) — synthesize a
      // one-off claim id exactly like the undo/redo closures already do, so
      // this write participates in the same per-cell ordering as a drag
      // drop instead of bypassing it (2026-08-12 ADR, FIX 1).
      placeActivityManual(activityId, groupId, dayId, blockId, undefined, crypto.randomUUID())
    }
  }

  function handleCellCreateNew(slot, name) {
    const groupId = slot.groupId ?? slot.group_id
    const dayId = slot.dayId ?? slot.day_id
    const blockId = slot.blockId ?? slot.time_block_id
    createActivityFromCell(name, { groupId, dayId, blockId })
  }

  function handleCellCreateElective(slot, setName, memberNames) {
    const groupId = slot.groupId ?? slot.group_id
    const dayId = slot.dayId ?? slot.day_id
    const blockId = slot.blockId ?? slot.time_block_id
    createElectiveFromCell(setName, memberNames, { groupId, dayId, blockId })
  }

  // Events overlay placement Slice 1 (docs/adr/2026-08-22-events-overlay-
  // placement.md §5) — mirrors handleCellPlace exactly, but always a
  // placement (an event cell is always an existing row; Slice 1 has no
  // create-new-event grammar from the grid).
  function handleCellPlaceEvent(slot, eventId) {
    const groupId = slot.groupId ?? slot.group_id
    const dayId = slot.dayId ?? slot.day_id
    const blockId = slot.blockId ?? slot.time_block_id
    const targetSlot = getSlot(slots, groupId, dayId, blockId)
    if (!targetSlot) return
    placeEventOnCell(eventId, { groupId, dayId, blockId }, targetSlot)
  }

  // Slice 2 drill-in (docs/work/specs/2026-08-22-electives-nested-schedule-
  // slices.md), redirected by docs/work/specs/2026-08-23-electives-gap.md to
  // the Schedule-side builder — an elective cell's own button hands its set
  // id up here, which just forwards it to onNavigate as a second arg for
  // AppShell to carry across the screen swap (App.jsx's
  // navigate/electiveFocusSetId).
  function openElective(electiveSetId) {
    onNavigate?.('schedule:electives', { electiveSetId })
  }

  // Events overlay placement Slice 1 — an event cell's own drill-in button
  // hands its event id up here, mirroring openElective exactly (App.jsx's
  // navigate/eventFocusId).
  function openEvent(eventId) {
    onNavigate?.('specialevents', { eventId })
  }
  // T350 slice 4: a replaced day's name opens that special day for editing.
  function openSpecialDay(specialDayId) {
    onNavigate?.('schedule:special', { specialDayId })
  }

  // T3 — selection + clipboard + paste + keyboard live in their own hook. It
  // reads the week on screen (copy/select-all) and hands a pasted activity back
  // to placeActivityManual (available above). Transient — reset() is called from
  // the block below.
  const {
    selectedSlotKeys, clipboardItems, pasteMode, pasteModeIndex, pasteError,
    handleCellSelect, clearSelection, cancelPaste, reset: resetClipboardSelection,
  } = useClipboardSelection({ slots, activities, selectedGroup, placeActivityManual })

  // Snapshots / versions CRUD + restore. It reads all route-scoped state from
  // the T31 routeState (route, existingTemplates, templateId(For), the route
  // data and setters) and persists through the T28 repo; only genuine
  // cross-cluster wiring is injected directly.
  const { saveSnapshot, deleteSnapshot, restoreSnapshot, renameSnapshot } = useSnapshots({
    routeState, repo, setActionError,
    recalcStats, resetUndoRedo,
    groups, activities, days, timeBlocks, fixedEvents, events: eventsAll, electiveSets: electiveSetsAll, weekId, replacedDayIds,
    activityExclusions, groupExclusions, locationExclusions,
  })

  // Week mutation orchestration: create/rename/archive/unarchive/duplicate/delete.
  const weeksHook = useWeeks({
    weeks, setWeeks, repo, localClient, campId, weekId, setPreferredWeekId, setActionError,
  })

  // Generation: generate / regenerate / place-fixedEvents, over the repo + the pure
  // engine. Route-scoped state comes from routeState (the route-explicit setters
  // are built from its by-route setters inside the hook); the
  // abort-on-failed-auto-snapshot behaviour lives in the hook.
  const { generate: rawGenerate, regenFromScratch: rawRegenFromScratch, placeFixedEvents: rawPlaceFixedEvents } = useGeneration({
    routeState, repo, campId, setActionError, setGenerating,
    resetUndoRedo, saveSnapshot, ensureTemplateRow,
    setConfirmRegen, setSelectedGroup, statsFor: recalcStatsPure,
    groups, tiers, days, timeBlocks, activities, fixedEvents, locations,
    electiveSetActivities, events: eventsAll,
    weekId, replacedDayIds, specialDaysReadFailed, activityExclusions, groupExclusions, locationExclusions,
  })
  // Generation reloads slots wholesale — bump the flag-ack resync so the
  // post-generation diff reads as a reload, never the quiet edit-ack, even when
  // it happens to touch <=3 cells (Red Hat 2026-08-09). Wrapping here covers
  // every call site (route-start map, regenerate confirm).
  const generate = (...a) => { bumpFlagAckResync(); return rawGenerate(...a) }
  const regenFromScratch = (...a) => { bumpFlagAckResync(); return rawRegenFromScratch(...a) }
  const placeFixedEvents = (...a) => { bumpFlagAckResync(); return rawPlaceFixedEvents(...a) }

  // The two routes are separate candidates, but they are ONE mounted component
  // (App.jsx maps both sidebar destinations to this screen), so anything held
  // in state survives the switch. Undo/redo entries, the clipboard, the current
  // selection and the direct-manipulation modes all captured the setters and
  // slot ids of the route they were made on — carrying them across would let a
  // paste or an undo write into the candidate the director is NOT looking at.
  // Cross-candidate writes are precisely what the route separation exists to
  // prevent, so switching routes drops all of it. Nothing persisted is touched:
  // each route's week, findings, snapshots and stats stay exactly as they were.
  //
  // Done during render rather than in an effect (React's documented
  // adjusting-state-on-prop-change pattern): the reset lands in the SAME commit
  // as the route change, so there is never an intermediate paint in which the
  // new route's grid is on screen while the old route's clipboard, selection or
  // undo entry is still live and clickable.
  const [transientRoute, setTransientRoute] = useState(route)
  if (transientRoute !== route) {
    setTransientRoute(route)
    resetUndoRedo()
    resetClipboardSelection()
  }

  // loadAll() re-runs on every op-applied event. Defaulting the selection
  // unconditionally is right on first load and wrong on every reload after it
  // — it threw the user back to Monday after each drop (T10). Functional
  // updates so this reads the live value, not a stale closure. `setupLists`
  // only gets a new identity once per successful load (useScheduleData's
  // final setSetupLists call), so this does not fire every render.
  useEffect(() => {
    if (loading) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedGroup(prev => resolveSelection(prev, groups))
    setSelectedDay(prev => resolveSelection(prev, days))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupLists])

  // Both routes are pushed into routeState on every load. `templateData` only
  // gets a new identity once per successful load, so this effect does not
  // fire every render. Dismissal reset is hook-external policy (not repo
  // data, and setRouteData's contract has no `dismissed` key on templateData)
  // — a fresh load always clears dismissal, matching the pre-extraction
  // unconditional setDismissedByRoute(EMPTY_BY_ROUTE(...)) reset.
  useEffect(() => {
    if (loading) return
    for (const r of ROUTES) {
      routeState.setRouteData(r, {
        slots: templateData.slotsByRoute[r],
        stats: templateData.statsByRoute[r],
        findings: templateData.findingsByRoute[r],
        dismissed: new Set(),
        snapshots: templateData.snapshotsByRoute[r],
        existingTemplate: templateData.existingTemplates[r],
        templateId: templateData.templateIdByRoute[r],
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateData])

  // §7.3: Re-run the schedule after any op is applied — this covers conflict
  // resolution (resolveConflict IPC → main.js's syncClient.write →
  // onOpApplied → wireOpApplied → shoresh:op-applied) as well as writes from
  // other devices, which reach the same renderer event by a different route: a
  // merged document → projectAll → syncNode.js's onRemoteOps fires →
  // syncStarter.js's onRemoteOps handler (the hop that owns the threshold
  // below) → startupGuard.js's dispatchRemoteOps.
  //
  // That second route covers SMALL merges only, and the shortfall is real, not
  // theoretical. dispatchRemoteOps sends one shoresh:op-applied per changed
  // field only while the batch is at or below REMOTE_OPS_COALESCE_THRESHOLD
  // (20); above it, it sends a SINGLE shoresh:full-sync-applied and returns.
  // This screen subscribes to onOpApplied and to nothing else —
  // onFullSyncApplied exists (src/localClient.js, electron/preload.js) and this
  // screen never calls it — so a catch-up merge from a device that was offline,
  // which is exactly the hundreds-of-fields shape the threshold exists to
  // collapse, delivers no event here and triggers no reload from this listener;
  // the screen catches up only on its next load. Subscribing to
  // onFullSyncApplied would close that gap and is a product change, not a
  // comment fix, so it is recorded here rather than done.
  //
  // _Prior: the first chain was written "syncClient.write → server broadcasts
  // op_applied → wireOpApplied". There is no server and no `op_applied` wire
  // message — both went at the Stage 6 cutover. `syncClient` here is main.js's
  // local createLocalWriteClient instance, which is live, and the renderer event
  // is spelled `op-applied`; only the broadcasting middle was retired._
  //
  // This is best-effort / fire-and-forget: a failure in reload() surfaces via
  // loadError (the screen's own error banner) rather than crashing the
  // listener. The reload re-fetches all schedule data, ensuring the
  // ScheduleScreen's stats/flags reflect the post-resolution state of the DB.
  useEffect(() => {
    if (typeof localClient.getDeviceId === 'function') {
      localClient.getDeviceId().then(id => { localDeviceIdRef.current = id }).catch(() => {})
    }
  }, [])

  // `reload` (useScheduleData's `load`) gets a new identity whenever campId/
  // weekId changes, but the listener itself must be registered exactly once
  // on mount — re-subscribing on every week switch is both unnecessary and,
  // if the listener registration is itself counted/asserted anywhere, wrong.
  // A ref always calls the CURRENT reload without resubscribing.
  const reloadRef = useRef(reload)
  useEffect(() => { reloadRef.current = reload }, [reload])

  useEffect(() => {
    if (typeof localClient.onOpApplied !== 'function') return
    const unsub = localClient.onOpApplied((op) => {
      if (op?.device_id === localDeviceIdRef.current) return
      reloadRef.current()
    })
    return () => { unsub?.() }
  }, [])

  function recalcStats(slotList) {
    setStats(recalcStatsPure(slotList, replacedDayIds))
  }

  function recalcFindings(slotList) {
    // FIXED_EVENT_DUPLICATE is generated-route only — see useScheduleData's route
    // loop for the same gate and reasoning.
    setFindings(recalcFindingsPure(slotList, route === 'generated'
      ? { groups, activities, days, replacedDayIds, fixedEvents, weekId, activityExclusions, groupExclusions, locationExclusions }
      : { groups, activities, days, replacedDayIds }))
  }

  // The schedule_templates row for a route is created lazily, on first use.
  // `kind` is written FIRST and that ordering is load-bearing — see the
  // write-ordering contract on schedule_templates in electron/ops/projections.js.
  //
  // If a row of this kind already exists it is RETURNED AS-IS — whatever its
  // id — and nothing is written. Only a route that has no row at all mints one,
  // and only then is the derived id used.
  async function ensureTemplateRow(routeName) {
    if (existingTemplates[routeName]) return templateIdFor(routeName)
    const tid = deriveScheduleTemplateId(weekId, routeName)
    await repo.createScheduleTemplate(tid, {
      kind: routeName,
      campId,
      weekId,
      name: routeName === 'manual' ? 'Manual' : 'Generated',
    })
    setExistingTemplates(prev => ({ ...prev, [routeName]: true }))
    setTemplateIdByRoute(prev => ({ ...prev, [routeName]: tid }))
    return tid
  }

  // Findings dismissal lives in ephemeral component state (a Set), never
  // persisted. The key is content-addressed by findingDismissKey (T185): for
  // magnitude-bearing kinds it folds in the material payload, so a dismissal
  // covers exactly the finding dismissed and a materially-worse one at the same
  // coordinates is not masked. Reset wholesale on every full rebuild
  // (generate/placeFixedEvents/restore/load); the slot-edit recalcFindings path
  // does NOT reset, which is why the key must carry the payload.
  function dismissFinding(dismissKey) {
    setDismissedFindingKeys(prev => {
      const next = new Set(prev)
      next.add(dismissKey)
      return next
    })
  }

  // T3 — cell selection (single and multi) and paste mode
  function handleSelectGroup(groupId) {
    setSelectedGroup(groupId)
    clearSelection()
  }

  // Always count flags camp-wide so badges don't change value when switching views.
  // Rows stored on a day replaced by a special day are hidden, not part of the
  // week, so no count — flags or the rail's weekly counter — may include them.
  const flagSlots = useMemo(() => {
    const replaced = new Set(replacedDayIds)
    return slots.filter(s => !replaced.has(s.day_id))
  }, [slots, replacedDayIds])

  // Findings rail rows: UNFILLABLE (per-slot, unchanged) + UNDERSERVED/
  // DISTRIBUTION (aggregate findings from the last buildSchedule() run) —
  // the header badge counts distinct problems, not flagged slots.
  const isManual = route === 'manual'

  // Flag SET differs by route; flag VOCABULARY does not. The manual route has
  // no UNFILLABLE — an empty cell there is simply not filled yet.
  //
  // OVERLAP is no longer the mirror of that (T159): it derives on both routes,
  // like WEEK_CLOSED, because a merge can produce a clash on either one.
  const unfillableSlots = unfillableSlotsPure(flagSlots, route)
  const overlapSlots = flagSlots.filter(s => s.flags?.OVERLAP)
  // WEEK_CLOSED is derived on both routes (see the `slots` memo), so its rail
  // rows and cell markers are not gated to the manual route.
  const weekClosedSlots = flagSlots.filter(s => s.flags?.WEEK_CLOSED)
  const activeFindings = findings.filter(f => !dismissedFindingKeys.has(findingDismissKey(f)))
  const SEVERITY_ORDER = { danger: 0, caution: 1, info: 2 }

  function slotLocator(s) {
    return [
      groups.find(g => g.id === s.group_id)?.name,
      days.find(d => d.id === s.day_id)?.label,
      timeBlocks.find(b => b.id === s.time_block_id)?.name,
    ].filter(Boolean).join(' · ')
  }

  // Manual-route copy is future-facing: what the week still needs, never what
  // the director got wrong.
  function findingReason(f) {
    if (!isManual) return f.reason
    const groupName = groups.find(g => g.id === f.groupId)?.name ?? ''
    const actName = activities.find(a => a.id === f.activityId)?.name ?? ''
    if (f.kind === 'UNDERSERVED') {
      return `Needs ${f.needed - f.got} more this week — ${actName}, ${groupName}`
    }
    if (f.kind === 'DISTRIBUTION') {
      const byDay = days.find(d => d.day_of_week === f.byDay)?.label ?? 'later in the week'
      return `${f.beforeCount} of ${f.requiredBefore} before ${byDay}`
    }
    return f.reason
  }

  const findingsRows = [
    ...unfillableSlots.map(s => ({
      key: s.id,
      kind: 'UNFILLABLE',
      severity: FLAG_SEVERITY.UNFILLABLE,
      reason: s.flags?.UNFILLABLE_reason || 'Nothing fits',
      locator: slotLocator(s),
      slotIds: [s.id],
      groupId: s.group_id,
    })),
    ...overlapSlots.map(s => ({
      key: `overlap-${s.id}`,
      kind: 'OVERLAP',
      severity: FLAG_SEVERITY.OVERLAP,
      reason: s.flags?.OVERLAP_reason || 'Over capacity',
      locator: slotLocator(s),
      groupId: s.group_id,
    })),
    ...weekClosedSlots.map(s => ({
      key: `week-closed-${s.id}`,
      kind: 'WEEK_CLOSED',
      severity: FLAG_SEVERITY.WEEK_CLOSED,
      reason: s.flags?.WEEK_CLOSED_reason || 'Off this week',
      locator: slotLocator(s),
      groupId: s.group_id,
    })),
    ...activeFindings.map(f => ({
      // groupId/activityId are both null for EVERY FIXED_EVENT_IDENTITY_GAP finding
      // (buildSchedule.js) — the plain coordinate key would collapse two
      // distinct fixedEvents' gaps onto one React row. fixedEventId (the fixed_events
      // row id) is that kind's real discriminator; every other kind keeps its
      // prior coordinate-only React key unchanged.
      key: f.kind === 'FIXED_EVENT_IDENTITY_GAP' ? `${f.groupId}|${f.activityId}|${f.kind}|${f.fixedEventId}` : `${f.groupId}|${f.activityId}|${f.kind}`,
      // The dismiss handler must reproduce the SAME payload-addressed key the
      // activeFindings filter reads, so it is computed here from the raw finding
      // (which still carries the magnitude) rather than re-spelled at dismiss time.
      dismissKey: findingDismissKey(f),
      kind: f.kind,
      severity: f.severity,
      reason: findingReason(f),
      locator: [groups.find(g => g.id === f.groupId)?.name, activities.find(a => a.id === f.activityId)?.name].filter(Boolean).join(' · '),
      groupId: f.groupId,
      activityId: f.activityId,
    })),
  ].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

  // Derived from the one railView value (see its declaration). The grid only
  // lights up for a specific concern on the generated route — 'ALL' reads the
  // full list without forcing colour onto the grid, and the manual route never
  // highlights (its one flag, OVERLAP, is derived per-cell already).
  const findingsRailOpen = railView !== null
  const highlightedKind = !isManual && railView && railView !== 'ALL' ? railView : null
  const KIND_COLOR = { UNFILLABLE: 'var(--danger)', UNDERSERVED: 'var(--accent)', DISTRIBUTION: 'var(--secondary)', FIXED_EVENT_DUPLICATE: 'var(--accent)' }
  const highlightColor = KIND_COLOR[highlightedKind] || 'var(--danger)'
  const highlightMap = highlightMapForKind(highlightedKind, findingsRows, slots)
  const railRows = railView && railView !== 'ALL'
    ? findingsRows.filter(r => r.kind === railView)
    : findingsRows

  // Toggle a concern box: clicking the active one turns the review off.
  const toggleRail = (target) => setRailView(v => (v === target ? null : target))

  function dismissFindingsRow(row) {
    if (row.kind === 'UNFILLABLE') dismissFlag(row.slotIds, 'UNFILLABLE')
    // OVERLAP and WEEK_CLOSED are derived from the week on screen, so there is
    // nothing to dismiss — they clear when the director moves the clashing /
    // closed-week placement or lifts the exclusion, which is the only honest
    // way for them to go away.
    else if (row.kind !== 'OVERLAP' && row.kind !== 'WEEK_CLOSED') dismissFinding(row.dismissKey)
  }

  function locateFindingsRow(row) {
    setView('group')
    setSelectedGroup(row.groupId)
    setRailView(null)
  }

  // Register the colour assignment for this camp's activity set before anything
  // renders a dot. T52: colour now encodes how often an activity runs
  // (min_per_week), on a fixed scale — so this is a straight per-activity
  // lookup, not the old collision-resolving hash. useMemo, not an effect: the
  // first paint must already have the right colours, and it is idempotent.
  //
  // NOTE the dependency on data the camp may never have entered: a camp that
  // never sets min_per_week gets every activity on the palest rung, i.e. a
  // monochrome grid. See hasCoverageTargets directly below, which exists
  // because exactly that gap is common.
  useMemo(() => setActivityPalette(activities), [activities])

  // "Still needed" and "Spread across the week" measure per-activity targets
  // (min_per_week, prefer_before_day/_min) that many camps never configure —
  // in that case the finding count is structurally always 0, not a real
  // "checked and clean" zero, so the badge must not render at all. Field
  // access mirrors buildSchedule.js exactly (src/engine/buildSchedule.js
  // ~line 627 and ~644) so the badge-gate and the finding-emit agree.
  const hasCoverageTargets = useMemo(() => activities.some(a => (a.min_per_week ?? 0) > 0), [activities])
  const hasSpreadTargets = useMemo(
    () => activities.some(a => a.prefer_before_day != null && a.prefer_before_day_min != null),
    [activities]
  )

  // Which saved version, if any, is the week currently displayed. Derived from
  // the payloads on every change rather than stored, so the label cannot go
  // stale after an edit or a restore — and so it is never inferred from list
  // position, which is what made the newest version unrestorable.
  const versionRows = useMemo(
    () => snapshots.map(s => ({ ...s, on_screen: snapshotMatchesSchedule(s, { slots }) })),
    [snapshots, slots]
  )

  // `colorIdx` is vestigial — nothing reads it since the activity colour dots
  // were removed from the grid, palette and activity view (owner, 2026-09-12).
  // Kept out of the row rather than left as dead freight.
  const actMap = new Map(activities.map(a => [a.id, { ...a }]))
  const fixedEventMap = new Map(fixedEvents.map(a => [a.id, a]))

  // Group-view and day-view DnD share identical palette-drop/replace branches —
  // every grid-to-grid or palette-onto-occupied drop always replaces
  // (drag-first-placement, 2026-08-09). The prior swap-gating flag is gone:
  // replace is unconditional now, not a product-decision toggle. Merge/extend
  // (formerly expand-drag) moved to a click affordance in T92 and no longer
  // rides through the drag FSM.
  const placeElective = (setName, target) => createElectiveFromCell(setName, [], target)
  const dragDeps = { timeBlocks, days, slots, actMap, getSlot, placeActivityManual, replaceSlot, placeElective }
  const groupHandlers = makeDragHandlers(dragDeps)
  const dayHandlers = makeDragHandlers(dragDeps)

  // Announcement copy for the FSM's aria-live region. Both are read only inside
  // a side effect, never during render.
  function describeDrag(active) {
    const data = active?.data?.current || {}
    if (data.paletteActivity) return actMap.get(data.paletteActivity.id)?.name || 'Activity'
    if (data.paletteElective) return data.paletteElective.name
    if (data.slot) return actMap.get(data.slot.activity_id)?.name || 'Empty slot'
    return 'Item'
  }

  function describeHit(hit) {
    if (!hit) return 'no target'
    const group = groups.find(g => g.id === hit.groupId)
    const day = days.find(d => d.id === hit.dayId)
    const block = timeBlocks.find(b => b.id === hit.blockId)
    return [group?.name, day?.label, block?.name].filter(Boolean).join(', ') || hit.cellKey
  }

  // Drives the static-ghost drop preview: whether the currently-hovered target
  // already carries an activity, which paintTarget (useDragFSM.js) reads to
  // decide whether to render "incoming activity, dim the occupant" instead of
  // the plain drag-over highlight.
  function isOccupied(hit) {
    if (!hit) return false
    const s = getSlot(slots, hit.groupId, hit.dayId, hit.blockId)
    return Boolean(s?.activity_id)
  }

  // One FSM per DndContext. Group view's context also covers manual build.
  const groupDrag = useDragFSM({ commit: groupHandlers.commit, describeDrag, describeHit, isOccupied })
  const dayDrag = useDragFSM({ commit: dayHandlers.commit, describeDrag, describeHit, isOccupied })

  // Grid geometry (getSlot / tails / rowspans) lives in the pure
  // ./schedule/gridGeometry module. Bind the current data once so the views and
  // the handlers below call the readers with just a cell coordinate.
  const geometry = makeGridGeometry({ slots, timeBlocks })

  // One required set, shared with the sidebar. This used to be an
  // inline check of a different four areas — see src/engine/readiness.js.
  const setupGaps = getSetupGaps({ cohorts, tiers, groups, days, timeBlocks, activities })

  if (loading) return <ScheduleSkeleton />

  if (setupGaps.length > 0) {
    return (
      <div style={{ maxWidth: 480 }}>
        <div style={{ background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))', border: '1px solid var(--accent)', borderRadius: 12, padding: '20px 24px', fontSize: 13 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 16, marginBottom: 8, color: 'color-mix(in srgb, var(--accent) 60%, var(--text))' }}>
            {describeSetupGaps(setupGaps)}
          </div>
          <ul style={{ marginTop: 8, paddingLeft: 18, lineHeight: 1.9 }}>
            {setupGaps.map(gap => (
              <li key={gap.key}>
                <button
                  onClick={() => onNavigate(gap.screen)}
                  style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline' }}
                >{gap.label}</button>
                {' — '}{gap.message}
              </li>
            ))}
          </ul>
          <button className="press-97" onClick={() => onNavigate(setupGaps[0].screen)} style={{ ...S.btnPrimary, marginTop: 12 }}>
            Set up {setupGaps[0].label}
          </button>
        </div>
      </div>
    )
  }

  const hasSchedule = slots.length > 0
  const anyRouteStarted = ROUTES.some(r => slotsByRoute[r].length > 0)

  const ROUTE_COPY = {
    manual: {
      label: 'Manual',
      offerTitle: 'Build it myself',
      offerAction: 'Start a blank week',
    },
    generated: {
      label: 'Generated',
      offerTitle: 'Let the app propose one',
      offerAction: 'Generate a schedule',
    },
  }

  // The neutral 'schedule' entry (FixedEventsScreen "Next: Schedule")
  // supplies no route. With both candidates started, falling through to the
  // 'generated' fallback would be the APP picking a week for the director,
  // which the no-canonical-schedule rule forbids
  // (docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md). So it asks.
  // One started, or none: there is no choice to make and the normal screen
  // (grid, or the first-run offers) is correct.
  const startedRoutes = ROUTES.filter(r => slotsByRoute[r].length > 0)
  if (!initialRoute && !localRoute && startedRoutes.length > 1) {
    return (
      <div style={{ padding: '60px 16px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 15, color: 'var(--text)', marginBottom: 20 }}>Open</div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          {ROUTES.map(r => (
            <button className="press-97"
              key={r}
              onClick={() => { setRoute(r); onNavigate?.(`schedule:${r}`) }}
              style={{ ...S.btnSecondary, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '12px 18px' }}
            >
              <span style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 14 }}>{ROUTE_COPY[r].label}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)' }}>{routeSummary(r)}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  function routeSummary(r) {
    const rows = slotsByRoute[r]
    if (rows.length === 0) return 'not started'
    const open = rows.filter(x => x.is_fixed_event === false).length
    const filled = rows.filter(x => x.is_fixed_event === false && x.activity_id).length
    return `${filled} of ${open} placed`
  }

  const startRoute = { manual: placeFixedEvents, generated: generate }

  function exportRoute(r, format = 'excel') {
    const week = weeks.find(w => w.id === weekId) || null
    const bundle = { slots: slotsByRoute[r], activities, fixedEvents, groups, days, timeBlocks, electiveSets: electiveSetsAll, electiveSetActivities, events: eventsAll, week, replacements }
    if (format === 'json') {
      // The portable machine-readable format (M2, Premise §14). Same non-canonical
      // rule as Excel: this exports the ONE route the director just chose, and the
      // app remembers nothing.
      const data = buildScheduleExport({ ...bundle, camp: { id: campId }, route: r })
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'camp_schedule.json'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      return
    }
    exportToExcel(bundle)
  }

  // If only one route has been started there is no choice to make and nothing
  // is being elected. As soon as both exist, the director picks — every time.
  // The format (Excel / JSON) is a separate axis, carried through the modal.
  function handleExportClick(format = 'excel') {
    const started = ROUTES.filter(r => slotsByRoute[r].length > 0)
    if (started.length <= 1) {
      exportRoute(started[0] ?? route, format)
      return
    }
    setExportFormat(format)
    setExportChoosing(true)
  }

  // T350 slice 4: useGeneration refuses this week anyway; the disabled control
  // carries the one-phrase reason (Governor ruling 4).
  const allDaysReplaced = everyDayReplaced(days, replacedDayIds)
  const ALL_REPLACED_TITLE = 'Every day is a special day'
  const canRebuild = role === 'admin' && !allDaysReplaced

  function routeOffer(r) {
    const copy = ROUTE_COPY[r]
    const offerDisabled = generating || role !== 'admin' || allDaysReplaced
    return (
      <div key={r} style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
        padding: '18px 20px', width: 280, display: 'flex', flexDirection: 'column', gap: 8,
        alignItems: 'center', textAlign: 'center',
      }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>{copy.offerTitle}</div>
        <button className="press-97"
          onClick={() => { setRoute(r); onNavigate?.(`schedule:${r}`); startRoute[r]() }}
          disabled={offerDisabled}
          title={role !== 'admin' ? 'Admin only' : allDaysReplaced ? ALL_REPLACED_TITLE : undefined}
          style={{
            ...(r === 'generated' ? S.btnPrimary : S.btnSecondary),
            marginTop: 6,
            ...(offerDisabled ? S.buttonDisabled : {}),
          }}
        >{copy.offerAction}</button>
      </div>
    )
  }


  return (
    <div style={{ maxWidth: '100%', ...enterStyle }}>
      {weekDeletedBanner && (
        <ErrorBanner
          onDismiss={() => setWeekDeletedBanner(null)}
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span>{weekDeletedBanner}</span>
        </ErrorBanner>
      )}
      {loadError && (
        <ErrorBanner>
          {loadError}
        </ErrorBanner>
      )}
      {templateError && (
        <ErrorBanner>
          {templateError}
        </ErrorBanner>
      )}
      {actionError && (
        <ErrorBanner>
          {actionError}
        </ErrorBanner>
      )}
      <GenerationBlockedNotice days={days} replacedDayIds={replacedDayIds} specialDaysReadFailed={specialDaysReadFailed} />
      {/* Controls bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {/* Week switcher — pure navigation, not tied to whether either route
            has been started, and not part of the route-designation copy above
            it (docs/adr/2026-08-02-schedule-weeks-first-class.md). */}
        <WeekSwitcher
          weeks={weeks}
          weekId={weekId}
          onSelect={setPreferredWeekId}
          onCreate={weeksHook.createWeek}
          onRename={weeksHook.renameWeek}
          onArchive={weeksHook.archiveWeek}
          onUnarchive={weeksHook.unarchiveWeek}
          onDuplicate={weeksHook.duplicateWeek}
          // Permanent week delete is admin-only (deleteWeekHandler authorizes
          // 'schedule_weeks.delete'): withholding onDelete hides the "Delete
          // permanently" menu item for staff, so they never reach a button that
          // would be rejected server-side. Staff keep create/edit/duplicate/
          // archive. Mirrors the admin-only regenerate gate above.
          onDelete={role === 'admin' ? (week) => setDeletingWeek(week) : undefined}
        />
        {anyRouteStarted && (
          <>
            {/* Route legibility (which route this week belongs to) lives in
                the left sidebar (src/components/layout/Sidebar.jsx) via the
                highlighted active row — WS5 S1. A toolbar label here was
                redundant with that and has been removed. */}

            {/* View toggle — how to LOOK at this route's week. "Manual Build"
                is gone from here: it was never a view, it was a route. */}
            <div style={{ display: 'flex', gap: 2, background: 'var(--border)', borderRadius: 8, padding: 3 }}>
              {[['day','Daily View'],['group','Group View'],['activity','Activity View']].map(([v, label]) => (
                <button key={v} onClick={() => { setView(v); if (v !== 'activity') setSelectedActivity(null) }} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', borderBottom: view === v ? '2px solid var(--primary)' : '2px solid transparent', cursor: 'pointer', fontSize: 12, fontWeight: view === v ? 700 : 600, fontFamily: 'var(--font-sans)', background: view === v ? 'var(--surface)' : 'none', color: view === v ? 'var(--primary)' : 'var(--text-secondary)', boxShadow: view === v ? '0 1px 4px rgba(0,0,0,0.12)' : 'none', transition: 'color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)' }}>{label}</button>
              ))}
            </div>

            {/* Weather Mode sits with the views (owner, 2026-09-12): it changes
                what you SEE, not what you have. */}
            <button
              onClick={() => setWeatherMode(w => !w)}
              aria-pressed={weatherMode}
              style={{ padding: '6px 12px', border: `1px solid ${weatherMode ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 6, background: weatherMode ? 'color-mix(in srgb, var(--primary) 9%, var(--surface))' : 'var(--surface)', color: weatherMode ? 'var(--primary)' : 'var(--text-secondary)', fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1 }}
            >
              Weather
            </button>

            {/* Acting on the schedule: undo, redo, rebuild — one cluster, since
                all three CHANGE the week rather than describe it. */}
            <button
              onClick={() => { bumpFlagAckResync(); handleUndo() }}
              disabled={undoStack.length === 0}
              aria-label="Undo"
              title={undoStack.length > 0 ? `Undo: ${undoStack[undoStack.length - 1].description}` : undefined}
              style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', cursor: undoStack.length === 0 ? 'not-allowed' : 'pointer', opacity: undoStack.length === 0 ? 0.35 : 1, fontSize: 14, fontFamily: 'inherit' }}
            ><UndoIcon /></button>
            <button
              onClick={() => { bumpFlagAckResync(); handleRedo() }}
              disabled={redoStack.length === 0}
              aria-label="Redo"
              title={redoStack.length > 0 ? `Redo: ${redoStack[redoStack.length - 1].description}` : undefined}
              style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', cursor: redoStack.length === 0 ? 'not-allowed' : 'pointer', opacity: redoStack.length === 0 ? 0.35 : 1, fontSize: 14, fontFamily: 'inherit' }}
            ><UndoIcon direction="redo" /></button>

            {!isManual && (
              // Sits with undo/redo (owner, 2026-09-12) — all three change the
              // week. Quiet at rest; the destructive amber only surfaces on
              // hover, where the intent to rebuild actually matters. Non-admins
              // get the muted disabled form with no hover reveal.
              <button
                onClick={() => setConfirmRegen(true)}
                disabled={!canRebuild}
                title={role !== 'admin' ? 'Admin only' : allDaysReplaced ? ALL_REPLACED_TITLE : undefined}
                style={!canRebuild
                  ? { ...S.btnSecondary, ...S.buttonDisabled, padding: '5px 10px', fontSize: 12, color: 'var(--text-secondary)' }
                  : { ...S.btnSecondary, padding: '5px 10px', fontSize: 12, color: 'var(--text-secondary)', transition: 'color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)' }}
                onMouseEnter={canRebuild ? (e) => {
                  e.currentTarget.style.color = 'var(--danger)'
                  e.currentTarget.style.borderColor = 'var(--danger)'
                  e.currentTarget.style.background = 'color-mix(in srgb, var(--danger) 8%, var(--surface))'
                } : undefined}
                onMouseLeave={canRebuild ? (e) => {
                  e.currentTarget.style.color = 'var(--text-secondary)'
                  e.currentTarget.style.borderColor = 'var(--border)'
                  e.currentTarget.style.background = 'var(--surface)'
                } : undefined}
              >Rebuild</button>
            )}

            <div style={{ flex: 1 }} />

            {/* Getting the week OUT of the app: versions and the two exports.
                Categorised per the owner, 2026-09-12 — Versions belongs here
                rather than beside Week 1, because "give me a different copy of
                this" is closer to export/restore than to which-week-am-I-on.
                Weather Mode moved up to the views; Rebuild moved to the
                undo/redo cluster.

                Deliberately NOT behind an overflow popup: WS5 S2a tried a "⋯"
                container here and the owner rejected that specifically. These
                stay on screen, set off by a divider and visually quieter than
                the primary controls, so the grid still dominates. */}
            <div
              aria-label="Versions and export"
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                paddingLeft: 12, marginLeft: 4,
                borderLeft: '1px solid var(--border)',
              }}
            >
              <VersionsDropdown
                snapshots={versionRows}
                isOpen={showVersions}
                role={role}
                onToggle={() => setShowVersions(v => !v)}
                onRestore={restoreSnapshot}
                onSaveNamed={name => { saveSnapshot(name, false).catch(() => {}) }}
                onRenameAutoSave={renameSnapshot}
                onDelete={deleteSnapshot}
              />

              {/* Export must act on exactly ONE schedule, and the app does
                  not get to pick. With both routes started it asks, every
                  time, and never remembers the answer. */}
              <button
                className="press-97"
                onClick={() => handleExportClick('excel')}
                style={{ ...S.btnSecondary, padding: '5px 10px', fontSize: 12, color: 'var(--text-secondary)' }}
              >Export to Excel</button>
              <button
                className="press-97"
                onClick={() => handleExportClick('json')}
                style={{ ...S.btnSecondary, padding: '5px 10px', fontSize: 12, color: 'var(--text-secondary)' }}
              >Export JSON</button>
            </div>
          </>
        )}

        {anyRouteStarted && generating && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>Generating…</span>}
      </div>



      {/* Paste mode status line */}
      {pasteMode && clipboardItems.length > 0 && (
        <div style={{ ...S.pasteStatusLine, ...(pasteError ? S.pasteStatusLineError : {}), marginBottom: 16 }}>
          <span>
            {pasteError
              ? `⚠ ${pasteError}`
              : `⊡ Paste ${clipboardItems[pasteModeIndex]?.activityName} (${clipboardItems.length - pasteModeIndex} left)`}
          </span>
          <button
            onClick={cancelPaste}
            aria-label="Cancel paste"
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 11, fontFamily: 'inherit', padding: 0 }}
          >✕</button>
        </div>
      )}

      {/* === Main content: persistent sidebar + grid area === */}
      {(() => {
        // The palette counts the whole week: one group in Group View, the
        // camp in Daily/Activity View, where no single group is in focus.
        const paletteGroupId = view === 'group' ? selectedGroup : null

        // T266 (site 2 of 7) — the drag palette shows free choices only. NOTE: the
        // palette deliberately does NOT filter by group eligibility and this does
        // not change that (owner ruling 2026-09-26: a director dragging an
        // activity onto a group knows whether that group does it; narrowing it
        // would remove a capability, not a hazard). Only pinned events go.
        const sidebar = (
          <ActivityPalette
            activities={filterFreeChoiceActivities(activities)}
            slots={flagSlots}
            electiveSets={electiveSetsAll}
            groupId={paletteGroupId}
            groups={groups}
            draggable={view === 'group' || view === 'day'}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(c => !c)}
          />
        )

        const gridContent = (
          <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
            {generating && <IndeterminateBar />}
            {/* Second row — the flag system. Owner, 2026-09-12: this is the
                state of the thing you are looking at, so it reads directly under
                the view switcher rather than below the grid. */}
            {hasSchedule && stats && (
              <div style={{ ...S.centeredRow, marginBottom: 20 }}>
              <div style={{ position: 'relative', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {/* T18: one concept, one name. "Placed" is a plain progress count on
                    both routes — not a concern, so it never toggles anything.
                    Neutral (owner, 2026-10-09): only problems get colour. */}
                <StatBadge
                  label="Placed"
                  value={`${stats.filled} of ${stats.open}`}
                />
                {isManual ? (
                  <StatBadge
                    label="Overlapping"
                    value={overlapSlots.length}
                    color={overlapSlots.length > 0 ? 'var(--accent)' : 'var(--text-secondary)'}
                    onClick={() => toggleRail('ALL')}
                  />
                ) : (
                  <StatBadge
                    label="Unfillable"
                    value={unfillableSlots.length}
                    color={unfillableSlots.length > 0 ? 'var(--danger)' : 'var(--text-secondary)'}
                    active={railView === 'UNFILLABLE'}
                    onClick={() => toggleRail('UNFILLABLE')}
                  />
                )}
                {hasCoverageTargets && (
                  <StatBadge
                    label="Still needed"
                    value={activeFindings.filter(f => f.kind === 'UNDERSERVED').length}
                    color={activeFindings.some(f => f.kind === 'UNDERSERVED') ? 'var(--accent)' : 'var(--text-secondary)'}
                    active={!isManual && railView === 'UNDERSERVED'}
                    onClick={() => toggleRail(isManual ? 'ALL' : 'UNDERSERVED')}
                  />
                )}
                {hasSpreadTargets && (
                  <StatBadge
                    label="Spread across the week"
                    value={activeFindings.filter(f => f.kind === 'DISTRIBUTION').length}
                    color={activeFindings.some(f => f.kind === 'DISTRIBUTION') ? 'var(--accent)' : 'var(--text-secondary)'}
                    active={!isManual && railView === 'DISTRIBUTION'}
                    onClick={() => toggleRail(isManual ? 'ALL' : 'DISTRIBUTION')}
                  />
                )}
                {/* Read the whole list without picking a concern first — opens the
                    list showing everything and leaves the grid calm. */}
                {!isManual && findingsRows.length > 0 && (
                  <button
                    onClick={() => setRailView(v => (v === 'ALL' ? null : 'ALL'))}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px',
                      fontFamily: 'inherit', fontSize: 12,
                      color: railView === 'ALL' ? 'var(--text)' : 'var(--text-secondary)',
                      textDecoration: 'underline', textUnderlineOffset: 3,
                    }}
                  >{railView === 'ALL' ? 'Hide list' : 'Review all'}</button>
                )}
                {findingsRailOpen && (
                  <FindingsRail
                    rows={railRows}
                    onDismiss={dismissFindingsRow}
                    onLocate={locateFindingsRow}
                    onClose={() => setRailView(null)}
                    intro={{ title: 'Still to place' }}
                    emptyText={railEmptyText(stats)}
                  />
                )}
              </div>
              </div>
            )}
            {/* Neither route started. If the director arrived via a specific
                sidebar link (initialRoute set) they already chose — show only
                that route's offer. If they came via the neutral 'schedule'
                entry (no initialRoute), present both so they can pick. */}
            {!anyRouteStarted && !generating && (
              initialRoute ? (
                <div style={{ ...S.centeredRow, marginBottom: 8 }}>{routeOffer(route)}</div>
              ) : (
                <div style={{ padding: '60px 16px', textAlign: 'center' }}>
                  <div style={{ ...S.centeredRow, gap: 16 }}>
                    {routeOffer('manual')}
                    {routeOffer('generated')}
                  </div>
                </div>
              )
            )}

            {/* The other route has work, this one does not: the same offer,
                inline. No warning, no confirmation — nothing is at risk. */}
            {anyRouteStarted && !hasSchedule && !generating && (
              <div style={{ ...S.centeredRow, marginBottom: 8 }}>{routeOffer(route)}</div>
            )}


            {/* Group view — the manual route draws its own grid, whose empty
                cells are drop targets rather than engine output. */}
            {hasSchedule && view === 'group' && isManual && (
              <ManualBuildView
                groups={groups}
                days={days}
                timeBlocks={timeBlocks}
                activities={activities}
                selectedGroup={selectedGroup}
                onSelectGroup={handleSelectGroup}
                actMap={actMap}
                fixedEventMap={fixedEventMap}
                geometry={geometry}
                eligibleActivitiesFor={eligibleActivitiesFor}
                onPlace={handleCellPlace}
                onCreateNew={handleCellCreateNew}
                onCreateElective={handleCellCreateElective}
                onOpenElective={openElective}
                electiveSetsAll={electiveSetsAll}
                electiveMembersBySet={electiveMembersBySet}
                onPlaceEvent={handleCellPlaceEvent}
                onOpenEvent={openEvent}
                eventsAll={eventsAll}
                isContentRaced={isContentRaced}
                onDismissContentRace={dismissContentRace}
                onExpandSlot={expandSlot}
                onSplitSlot={splitSlot}
                onSpanExtendStart={onSpanExtendStart}
                selectedSlotKeys={selectedSlotKeys}
                pasteMode={pasteMode}
                onCellSelect={handleCellSelect}
                collapsedBlockIds={collapsedBlockIds}
                onToggleBlockCollapsed={toggleBlockCollapsed}
                replacements={replacements}
                onOpenSpecialDay={openSpecialDay}
              />
            )}

            {hasSchedule && view === 'group' && !isManual && (
              <ScheduleGroupView
                groups={groups}
                days={days}
                timeBlocks={timeBlocks}
                selectedGroup={selectedGroup}
                onSelectGroup={handleSelectGroup}
                weatherMode={weatherMode}
                actMap={actMap}
                fixedEventMap={fixedEventMap}
                releaseCell={releaseCell}
                geometry={geometry}
                eligibleActivitiesFor={eligibleActivitiesFor}
                onPlace={handleCellPlace}
                onCreateNew={handleCellCreateNew}
                onCreateElective={handleCellCreateElective}
                onOpenElective={openElective}
                electiveSetsAll={electiveSetsAll}
                electiveMembersBySet={electiveMembersBySet}
                onPlaceEvent={handleCellPlaceEvent}
                onOpenEvent={openEvent}
                eventsAll={eventsAll}
                isContentRaced={isContentRaced}
                onDismissContentRace={dismissContentRace}
                onExpandSlot={expandSlot}
                onSplitSlot={splitSlot}
                onSpanExtendStart={onSpanExtendStart}
                selectedSlotKeys={selectedSlotKeys}
                pasteMode={pasteMode}
                onCellSelect={handleCellSelect}
                highlightMap={highlightMap}
                highlightColor={highlightColor}
                collapsedBlockIds={collapsedBlockIds}
                onToggleBlockCollapsed={toggleBlockCollapsed}
                replacements={replacements}
                onOpenSpecialDay={openSpecialDay}
              />
            )}

            {/* Daily view */}
            {hasSchedule && view === 'day' && (
              <ScheduleDayView
                groups={groups}
                days={days}
                timeBlocks={timeBlocks}
                selectedDay={selectedDay}
                onSelectDay={setSelectedDay}
                weatherMode={weatherMode}
                actMap={actMap}
                fixedEventMap={fixedEventMap}
                lockActivity={lockActivity}
                releaseCell={releaseCell}
                geometry={geometry}
                eligibleActivitiesFor={eligibleActivitiesFor}
                onPlace={handleCellPlace}
                onCreateNew={handleCellCreateNew}
                onCreateElective={handleCellCreateElective}
                onOpenElective={openElective}
                electiveSetsAll={electiveSetsAll}
                electiveMembersBySet={electiveMembersBySet}
                onPlaceEvent={handleCellPlaceEvent}
                onOpenEvent={openEvent}
                eventsAll={eventsAll}
                isContentRaced={isContentRaced}
                onDismissContentRace={dismissContentRace}
                onExpandSlot={expandSlot}
                onSplitSlot={splitSlot}
                onSpanExtendStart={onSpanExtendStart}
                highlightMap={highlightMap}
                highlightColor={highlightColor}
                collapsedBlockIds={collapsedBlockIds}
                onToggleBlockCollapsed={toggleBlockCollapsed}
                replacements={replacements}
                onOpenSpecialDay={openSpecialDay}
              />
            )}

            {/* Activity view */}
            {hasSchedule && view === 'activity' && (
              <ScheduleActivityView
                activities={activities}
                groups={groups}
                days={days}
                timeBlocks={timeBlocks}
                slots={slots}
                locations={locations}
                selectedActivity={selectedActivity}
                onSelectActivity={setSelectedActivity}
                collapsedBlockIds={collapsedBlockIds}
                onToggleBlockCollapsed={toggleBlockCollapsed}
                replacements={replacements}
                onOpenSpecialDay={openSpecialDay}
              />
            )}

            {/* Grid legend — always on the manual route (overlap dots),
                and on the generated route ONLY when it actually carries a per-cell
                mark to explain: a WEEK_CLOSED dot. The generated grid is otherwise
                kept calm (concerns reviewed from the boxes above —
                docs/work/specs/2026-08-01-generated-flag-review.md), but a closed-week
                placement can reach it (a post-generation edit, or an activity marked
                closed after the week was built), and a mark on the grid must never go
                undocumented (legend.test.js). When shown there, legendEntriesFor
                documents every mark the generated grid can carry. */}
            {hasSchedule && (isManual || weekClosedSlots.length > 0 || overlapSlots.length > 0) && (
              <div style={{ ...S.centeredRow, gap: 16, marginTop: 16, fontSize: 11, color: 'var(--text-secondary)' }}>
                {legendEntriesFor(route).map(entry => (
                  <span key={entry.label} title={entry.description} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'default' }}>
                    <span
                      aria-hidden="true"
                      style={
                        entry.shape === 'dot'
                          ? { width: 8, height: 8, borderRadius: '50%', background: entry.color, display: 'inline-block', flexShrink: 0 }
                          : entry.shape === 'bar'
                            // Matches cellStructuralBar's left border, so the swatch is
                            // the same mark the director sees on the cell.
                            ? { width: 3, height: 12, borderRadius: 1, background: entry.color, display: 'inline-block', flexShrink: 0 }
                            : entry.shape === 'frame'
                              // T108 Phase 2 (Designer spec §2.6) — a small swatch with the
                              // same dashed-border treatment as the overridden-cell marker.
                              ? { width: 10, height: 10, borderRadius: 2, background: 'transparent', border: `1.5px dashed ${entry.color}`, display: 'inline-block', flexShrink: 0 }
                              : { width: 10, height: 10, borderRadius: 2, background: entry.color, border: '1px solid var(--border)', display: 'inline-block', flexShrink: 0 }
                      }
                    />
                    {entry.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        )

        const twoCol = (
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            {sidebar}
            {gridContent}
          </div>
        )

        // Group view and manual view each get a DndContext so palette chips can
        // reach the droppable cells.
        if (view === 'group') {
          return (
            <DndContext
              key="group"
              sensors={sensors}
              accessibility={{ announcements: SILENCE_DNDKIT_ANNOUNCEMENTS }}
              {...groupDrag.dndProps}
            >
              <GridDragSurface {...groupDrag.surfaceProps}>{twoCol}</GridDragSurface>
            </DndContext>
          )
        }
        if (view === 'day') {
          return (
            <DndContext
              key="day"
              sensors={sensors}
              accessibility={{ announcements: SILENCE_DNDKIT_ANNOUNCEMENTS }}
              {...dayDrag.dndProps}
            >
              <GridDragSurface {...dayDrag.surfaceProps}>{twoCol}</GridDragSurface>
            </DndContext>
          )
        }
        return twoCol
      })()}

      {exportChoosing && (
        <ExportChooserModal
          options={ROUTES.map(r => {
            const { filled, open } = recalcStatsPure(slotsByRoute[r], replacedDayIds)
            return { key: r, title: ROUTE_COPY[r].label, filled, total: open }
          })}
          formatLabel={exportFormat === 'json' ? 'a data file (JSON)' : 'Excel'}
          onChoose={r => { setExportChoosing(false); exportRoute(r, exportFormat) }}
          onCancel={() => setExportChoosing(false)}
        />
      )}

      {/* Regen confirm */}
      {confirmRegen && (
        <ConfirmRegenModal
          role={role}
          onConfirm={regenFromScratch}
          onCancel={() => setConfirmRegen(false)}
        />
      )}

      {/* The concerns row sits BELOW the grid, not above it (owner, 2026-09-11).
          The generated route should open to the SCHEDULE: the engine has just
          done twenty minutes of the director's work, and leading with a row of
          counts of what is still wrong reads as an audit of the result rather
          than the result itself. Same controls, same behaviour, read second. */}
      {/* Concern boxes — the generated schedule's "track changes" review. Each
          box clicks to light up the cells its concern touches and opens the
          list filtered to it; clicking the active box turns it off. On the
          manual route the boxes stay a plain count that opens the same list —
          manual owns no engine concerns to review cell-by-cell, so it is left
          as it was. docs/work/specs/2026-08-01-generated-flag-review.md */}


      {deletingWeek && (
        <DeleteWeekDialog
          week={deletingWeek}
          campId={campId}
          localClient={localClient}
          repo={repo}
          onConfirm={(deletedWeekId) => {
            setDeletingWeek(null)
            weeksHook.confirmDeleteWeek(deletedWeekId)
          }}
          onCancel={() => setDeletingWeek(null)}
        />
      )}
    </div>
  )
}

