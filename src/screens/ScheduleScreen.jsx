import { useState, useEffect, useMemo } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { localClient } from '../localClient'
import { createScheduleRepository } from '../data/scheduleRepository'
import { computeFindings } from '../engine/buildSchedule'
import { getSetupGaps, describeSetupGaps } from '../engine/readiness'
import { S } from '../styles/shared'
import StatBadge from '../components/schedule/StatBadge'
import { legendEntriesFor, FLAG_SEVERITY, setActivityPalette } from '../components/schedule/slotCellConstants'
import FindingsRail from '../components/schedule/FindingsRail'
import EditModal from '../components/schedule/EditModal'
import ConfirmRegenModal from '../components/schedule/ConfirmRegenModal'
import ExportChooserModal from '../components/schedule/ExportChooserModal'
import VersionsDropdown from '../components/schedule/VersionsDropdown'
import { isRestorable } from './snapshotRestore'
import { snapshotMatchesSchedule } from './snapshotMatchesSchedule'
import FieldTripDrawer from '../components/schedule/FieldTripDrawer'
import { exportToExcel } from '../utils/exportSchedule'
import { withOverlapFlags } from '../utils/computeOverlaps'
import { deriveScheduleTemplateId } from '../../electron/ops/scheduleTemplateId'
import { resolveSelection } from './resolveSelection'
import { normalizeActivityEligibility } from '../utils/normalizeActivityEligibility'
import { getSlot, makeGridGeometry } from './schedule/gridGeometry'
import { useUndoRedo } from './schedule/useUndoRedo'
import { useClipboardSelection } from './schedule/useClipboardSelection'
import { useOverlayFillStamp } from './schedule/useOverlayFillStamp'
import { useSnapshots } from './schedule/useSnapshots'
import { useGeneration } from './schedule/useGeneration'
import { useSlotMutations } from './schedule/useSlotMutations'
import { ROUTES, EMPTY_BY_ROUTE, useRouteState } from './schedule/useRouteState'
import ScheduleGroupView from '../components/schedule/ScheduleGroupView'
import ScheduleDayView from '../components/schedule/ScheduleDayView'
import ScheduleActivityView from '../components/schedule/ScheduleActivityView'
import ManualBuildView from '../components/schedule/ManualBuildView'
import ActivityPalette from '../components/schedule/ActivityPalette'
import DisplacedPalette from '../components/schedule/DisplacedPalette'

// Which row IS this camp's candidate for this route? Ask the database by
// (camp_id, kind) — do not assume the derived id is the one on disk.
//
// A camp whose schedule_templates row was minted after migration v21 by a
// renderer that still used crypto.randomUUID() carries a RANDOM UUID id that no
// migration will ever normalise. Deriving the id and hoping a row is there
// found nothing on such a camp, so the app tried to insert one, lost silently
// to UNIQUE(camp_id, kind), and generation did nothing at all. `kind` is the
// route authority (ADR Decision §1), so resolve by it.
//
// The derived id is still what gets MINTED when no row exists — that is the
// invariant deterministic ids exist for (two devices independently creating a
// candidate must agree on its id). Determinism was only ever needed at mint
// time; once a row exists it has replicated, and both devices resolve to it.
function templateRowFor(templates, campId, kind) {
  // A row with no kind at all is 'generated': that is the column default and
  // what migration v23 backfilled, so a row that predates the column (or
  // arrives from a peer that has not projected kind yet) must not read as
  // belonging to no route.
  return (templates || []).find(t => t.camp_id === campId && (t.kind || 'generated') === kind)
}

function resolveTemplateId(templates, campId, kind) {
  const row = templateRowFor(templates, campId, kind)
  return row ? row.id : deriveScheduleTemplateId(campId, kind)
}

export default function ScheduleScreen({ campId, role, onNavigate, initialRoute }) {
  const [groups, setGroups] = useState([])
  const [days, setDays] = useState([])
  const [timeBlocks, setTimeBlocks] = useState([])
  const [activities, setActivities] = useState([])
  const [anchors, setAnchors] = useState([])
  const [tiers, setTiers] = useState([])
  const [cohorts, setCohorts] = useState([])
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
  // T31 — the route-scoped state lives in one module (useRouteState): the eight
  // by-route atoms, the current-route derived values, and the current-route
  // setters. Route SELECTION stays here (above) — the hook only receives the
  // resulting route and owns no canonical designation. Names and shapes are
  // unchanged from the single-schedule version on purpose, so the ~20 call sites
  // below keep reading `slots`/`templateId`/`setSlots` verbatim.
  const routeState = useRouteState(campId, route)
  const {
    existingTemplates, setExistingTemplates,
    setTemplateIdByRoute,
    slotsByRoute, setSlotsByRoute,
    setStatsByRoute, setFindingsByRoute, setDismissedByRoute,
    setSnapshotsByRoute, setOverlaysByRoute,
    templateIdFor,
    rawSlots, stats, findings, dismissedFindingKeys, overlays, snapshots,
    setStats, setDismissedFindingKeys,
  } = routeState
  // OVERLAP is derived, never persisted — so it clears from every participating
  // cell the moment any one of them moves, and only on the manual route, where
  // a clashing placement is accepted rather than refused.
  const slots = route === 'manual' ? withOverlapFlags(rawSlots, activities) : rawSlots
  // null = rail closed; otherwise the kind ('UNFILLABLE'|'UNDERSERVED'|'DISTRIBUTION') filtered to
  // Deviation from design spec: spec called for one aggregate header badge
  // opening one rail. We kept three per-kind badges (director-legible counts
  // at a glance) but all of them open the SAME rail, listing every kind
  // together severity-sorted, so a director can read all problems in one
  // click regardless of which badge they clicked. See "Deviations" section
  // appended to docs/superpowers/specs/2026-07-28-schedule-flag-findings-reshape-design.md.
  const [findingsRailOpen, setFindingsRailOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [view, setView] = useState('group') // 'group' | 'activity' | 'day'
  const [selectedGroup, setSelectedGroup] = useState(null)
  const [selectedDay, setSelectedDay] = useState(null)
  const [weatherMode, setWeatherMode] = useState(false)
  const [editSlot, setEditSlot] = useState(null)
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [selectedActivity, setSelectedActivity] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [templateError, setTemplateError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [exportChoosing, setExportChoosing] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showFieldTripDrawer, setShowFieldTripDrawer] = useState(false)
  const [isDayExpandDragActive, setIsDayExpandDragActive] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isGroupExpandDragActive, setIsGroupExpandDragActive] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  // The persistence seam. Instantiated once with the real localClient (ADR
  // 2026-08-01 §3); it owns token acquisition, every schedule read/write, and
  // the single slot->row mapper. The screen keeps all React state, banner copy,
  // route policy, and engine calls.
  const repo = useMemo(() => createScheduleRepository({ localClient }), [])

  // T5 — undo/redo lives in its own hook: the two stacks, the push/undo/redo
  // helpers, and the keyboard shortcuts. It is transient — reset() is called
  // from the transient-reset block below on a route switch.
  const { undoStack, redoStack, pushUndo, handleUndo, handleRedo, reset: resetUndoRedo } = useUndoRedo({ setActionError })

  // Overlay fill / field-trip stamp / displaced-activity tray. Transient
  // direct-manipulation state; orchestrates persistence through the slot
  // mutations' addOverlay/updateOverlayRange (wrapped below). reset() runs from
  // the block below.
  const {
    fillState, stampMode, setStampMode, displacedItems, setDisplacedItems,
    startFill, handleFillEnter, handleStampClick, dismissDisplaced, reset: resetOverlayFillStamp,
  } = useOverlayFillStamp({ groups, timeBlocks, overlays, addOverlay, updateOverlayRange })

  // T32 — the per-cell slot/overlay mutation cluster lives in its own hook: the
  // ~11 handlers that write a slot/overlay through the T28 repo and record the
  // undo entry. It owns no state — route-scoped values and the route-PINNED
  // setters come from routeState; pushUndo, setDisplacedItems, recalcStats, the
  // geometry getSlot and the data lists are injected. `slots` is the screen's
  // overlap-flagged value (what the inline handlers read pre-extraction), so
  // prevFlags in the undo closures stays byte-identical.
  const slotMutations = useSlotMutations({
    routeState, repo, pushUndo, setActionError,
    editSlot, setEditSlot, setDisplacedItems, recalcStats,
    getSlot, setActivities,
    slots, groups, activities, days, timeBlocks,
  })
  const {
    editSlotSave, swapSlots, dismissFlag, lockActivity, releaseCell,
    removeOverlay, placeActivityManual, expandSlot, splitSlot,
  } = slotMutations

  // addOverlay / updateOverlayRange are consumed by useOverlayFillStamp, which
  // runs BEFORE useSlotMutations, so they are provided as thin hoisted wrappers
  // that delegate to the hook. The fill/stamp hook only calls them from event
  // handlers (stamp click, fill pointer-up), never during render, so
  // `slotMutations` is always assigned by the time they fire. This breaks the
  // genuine cycle — the mutations need setDisplacedItems (owned by the fill/stamp
  // hook) and that hook needs the overlay mutations — without lifting the
  // displaced-tray state out of its hook.
  function addOverlay(args) { return slotMutations.addOverlay(args) }
  function updateOverlayRange(overlayId, toBlockOrder) { return slotMutations.updateOverlayRange(overlayId, toBlockOrder) }

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
    groups, activities, days,
  })

  // Generation: generate / regenerate / place-anchors, over the repo + the pure
  // engine. Route-scoped state comes from routeState (the route-explicit setters
  // are built from its by-route setters inside the hook); the
  // abort-on-failed-auto-snapshot behaviour lives in the hook.
  const { generate, regenFromScratch, placeAnchors } = useGeneration({
    routeState, repo, campId, setActionError, setGenerating,
    resetUndoRedo, saveSnapshot, ensureTemplateRow,
    setConfirmRegen, setSelectedGroup, statsFor,
    groups, tiers, days, timeBlocks, activities, anchors,
  })

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
    setEditSlot(null)
    resetOverlayFillStamp()
  }

  async function loadAll() {
    setLoading(true)
    setLoadError(null)
    setTemplateError(null)
    let g, a, d
    try {
      // Cohorts are not used to build a week, only to answer "is setup done"
      // from the same source the sidebar and Camp Setup use. Without it this
      // screen would report a Programs gap the setup screen does not — the exact
      // disagreement getSetupGaps exists to end.
      const {
        groups: gd, days_of_operation: td, time_blocks: bd, activities: ad,
        anchor_activities: ancd, tiers: tierd, cohorts: cohd,
      } = await repo.loadSetupLists()
      g = [...(gd || [])].filter(x => x.camp_id === campId).sort((x, y) => x.name.localeCompare(y.name))
      const b = [...(bd || [])].filter(x => x.camp_id === campId).sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      a = (ad || []).filter(x => x.camp_id === campId).map(normalizeActivityEligibility)
      const anc = (ancd || []).filter(x => x.camp_id === campId)
      const t = [...(tierd || [])].filter(x => x.camp_id === campId).sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      const sortedTd = [...(td || [])].filter(x => x.camp_id === campId).sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      d = sortedTd.filter((x, i, arr) => arr.findIndex(y => y.day_of_week === x.day_of_week) === i)
      const tierOrderMap = new Map(t.map(tier => [tier.id, tier.sort_order ?? 0]))
      const sortedG = [...g].sort((x, y) => {
        const ox = tierOrderMap.get(x.tier_id) ?? 999
        const oy = tierOrderMap.get(y.tier_id) ?? 999
        return ox !== oy ? ox - oy : x.name.localeCompare(y.name)
      })
      const coh = (cohd || []).filter(x => x.camp_id === campId)
      setGroups(sortedG); setDays(d); setTimeBlocks(b); setActivities(a); setAnchors(anc); setTiers(t); setCohorts(coh)
      // loadAll() re-runs on every op-applied event. Defaulting the selection
      // unconditionally here is right on first load and wrong on every reload
      // after it — it threw the user back to Monday after each drop (T10).
      // Functional updates so this reads the live value, not a stale closure.
      setSelectedGroup(prev => resolveSelection(prev, sortedG))
      setSelectedDay(prev => resolveSelection(prev, d))
    } catch {
      setLoadError('Failed to load schedule data — check your connection and refresh')
      setLoading(false)
      return
    }
    // Both routes are refreshed on every load. loadAll() re-runs on every
    // applied op, and a load that only refreshed the route on screen would
    // leave the other one showing whatever it held before the op arrived.
    try {
      const { templates, slots: allSlots, overlays: overlayData, snapshots: snapData } =
        await repo.loadTemplateData()

      const exists = {}
      const nextTids = {}
      const nextSlots = {}
      const nextOverlays = {}
      const nextSnaps = {}
      const nextStats = {}
      const nextFindings = {}

      for (const r of ROUTES) {
        // Resolution is by (camp_id, kind), never by camp_id alone: a camp now
        // has one row per route, and first-match-wins would silently elect one
        // of them as "the" schedule. It is NOT by derived id either — see
        // resolveTemplateId.
        const tid = resolveTemplateId(templates, campId, r)
        nextTids[r] = tid
        exists[r] = Boolean(templateRowFor(templates, campId, r))
        // Gated on the parent row existing: a route with no schedule_templates
        // row has not been started, whatever orphan child rows may be lying
        // around.
        const saved = exists[r] ? allSlots.filter(x => x.template_id === tid) : []
        nextSlots[r] = saved
        nextOverlays[r] = (overlayData || []).filter(o => o.template_id === tid)
        nextStats[r] = statsFor(saved)
        nextFindings[r] = computeFindings({ slots: saved, groups: g, activities: a, days: d })
        nextSnaps[r] = (snapData || [])
          .filter(x => x.template_id === tid)
          .sort((x, y) => new Date(y.created_at) - new Date(x.created_at))
          // `restorable` is carried so the Versions list and the restore action
          // agree — offering a version restore will refuse is the T8 defect.
          // The payload travels with the row so the Versions list can say,
          // truthfully and at render time, which version is the week on screen.
          .map(x => ({
            id: x.id, template_id: x.template_id, name: x.name,
            is_auto: x.is_auto, created_at: x.created_at,
            slots: x.slots, overlays: x.overlays,
            restorable: isRestorable(x),
          }))
      }

      setExistingTemplates(exists)
      setTemplateIdByRoute(nextTids)
      setSlotsByRoute(nextSlots)
      setOverlaysByRoute(nextOverlays)
      setSnapshotsByRoute(nextSnaps)
      setStatsByRoute(nextStats)
      setFindingsByRoute(nextFindings)
      setDismissedByRoute(EMPTY_BY_ROUTE(() => new Set()))
    } catch {
      setTemplateError('Failed to load saved schedule — check your connection and refresh')
    }
    setLoading(false)
  }

  // Placed after loadAll's declaration so the reload effects reference an
  // already-declared function (react-hooks/immutability). Function hoisting
  // makes the runtime behaviour identical to declaring them at the top.
  //
  // Load-on-mount: loadAll() sets state from its own async body, which is the
  // canonical data-fetch-on-mount pattern the set-state-in-effect rule allows
  // an exception for.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { loadAll() }, [campId])

  // §7.3: Re-run the schedule after any op is applied — this covers conflict
  // resolution (resolveConflict IPC → syncClient.write → server broadcasts
  // op_applied → wireOpApplied → shoresh:op-applied) as well as ordinary
  // writes from other devices. The op_applied event already fires naturally
  // on those paths; we just need ScheduleScreen to react to it.
  //
  // This is best-effort / fire-and-forget: a failure in loadAll() surfaces
  // via setLoadError (the screen's own error banner) rather than crashing
  // the listener. The reload re-fetches all schedule data and calls
  // recalcStats(), ensuring the ScheduleScreen's stats/flags reflect the
  // post-resolution state of the DB.
  useEffect(() => {
    if (typeof localClient.onOpApplied !== 'function') return
    const unsub = localClient.onOpApplied(() => { loadAll() })
    return () => { unsub?.() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function statsFor(slotList) {
    return {
      open: slotList.filter(s => s.is_anchor === false).length,
      filled: slotList.filter(s => s.is_anchor === false && s.activity_id).length,
    }
  }

  function recalcStats(slotList) {
    setStats(statsFor(slotList))
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
    const tid = deriveScheduleTemplateId(campId, routeName)
    await repo.createScheduleTemplate(tid, {
      kind: routeName,
      campId,
      name: routeName === 'manual' ? 'Manual' : 'Generated',
    })
    setExistingTemplates(prev => ({ ...prev, [routeName]: true }))
    setTemplateIdByRoute(prev => ({ ...prev, [routeName]: tid }))
    return tid
  }

  // Findings (UNDERSERVED/DISTRIBUTION) are keyed by (groupId, activityId, kind)
  // — not by a template_slots row — so dismissal lives in ephemeral component
  // state (a Set), never persisted. Cleared on every rebuild alongside
  // `findings` itself. See Architect's ADR §5.
  function dismissFinding(groupId, activityId, kind) {
    setDismissedFindingKeys(prev => {
      const next = new Set(prev)
      next.add(`${groupId}|${activityId}|${kind}`)
      return next
    })
  }

  // Group-view DnD: covers both expand-drag (ExpandHandle) and palette drops.
  // DndContext for group view lives in ScheduleScreen so the sidebar palette chips
  // (outside ScheduleGroupView) share the same DnD context as the droppable cells.
  function handleGroupDragStart({ active }) {
    if (active.data.current?.expandDrag) setIsGroupExpandDragActive(true)
  }

  function handleGroupDragEnd({ active, over }) {
    setIsGroupExpandDragActive(false)
    if (!over) return

    const expandDrag = active.data.current?.expandDrag
    const paletteActivity = active.data.current?.paletteActivity

    if (expandDrag) {
      const { groupId, dayId, blockId: headBlockId } = expandDrag
      const overData = over.data.current || {}
      const tailBlockId = overData.blockId || overData.slot?.blockId
      const tailGroupId = overData.groupId || overData.slot?.groupId
      const tailDayId = overData.dayId || overData.slot?.dayId

      if (!tailBlockId || tailGroupId !== groupId || tailDayId !== dayId) return

      const headBlock = timeBlocks.find(b => b.id === headBlockId)
      const tailBlock = timeBlocks.find(b => b.id === tailBlockId)
      if (!headBlock || !tailBlock) return
      if (tailBlock.sort_order !== headBlock.sort_order + 1) return

      const tailSlot = getSlot(slots, groupId, dayId, tailBlockId)
      if (!tailSlot || !tailSlot.activity_id || tailSlot.is_anchor) return

      const tailActivity = actMap.get(tailSlot.activity_id)
      const day = days.find(d => d.id === dayId)
      expandSlot(groupId, dayId, headBlockId, tailBlockId, tailSlot.activity_id, tailActivity?.name || '', tailBlock.name, day?.label ?? dayId)
      return
    }

    if (paletteActivity) {
      const d = over.data.current || {}
      const groupId = d.groupId ?? d.slot?.groupId
      const dayId = d.dayId ?? d.slot?.dayId
      const blockId = d.blockId ?? d.slot?.blockId
      if (!groupId || !dayId || !blockId) return
      const targetSlot = getSlot(slots, groupId, dayId, blockId)
      if (targetSlot?.is_anchor) return
      placeActivityManual(paletteActivity.id, groupId, dayId, blockId)
    }
  }

  // Day-view DnD: covers expand-drag, palette drops, and slot-swap.
  // DndContext for day view lives in ScheduleScreen so the sidebar palette chips
  // (outside ScheduleDayView) share the same DnD context as the droppable cells.
  function handleDayDragStart({ active }) {
    if (active.data.current?.expandDrag) setIsDayExpandDragActive(true)
  }

  function handleDayDragEnd({ active, over }) {
    setIsDayExpandDragActive(false)
    if (!over) return

    const expandDrag = active.data.current?.expandDrag
    const paletteActivity = active.data.current?.paletteActivity

    if (expandDrag) {
      const { groupId, dayId, blockId: headBlockId } = expandDrag
      const overData = over.data.current || {}
      const tailBlockId = overData.blockId || overData.slot?.blockId
      const tailGroupId = overData.groupId || overData.slot?.groupId
      const tailDayId = overData.dayId || overData.slot?.dayId

      if (!tailBlockId || tailGroupId !== groupId || tailDayId !== dayId) return

      const headBlock = timeBlocks.find(b => b.id === headBlockId)
      const tailBlock = timeBlocks.find(b => b.id === tailBlockId)
      if (!headBlock || !tailBlock) return
      if (tailBlock.sort_order !== headBlock.sort_order + 1) return

      const tailSlot = getSlot(slots, groupId, dayId, tailBlockId)
      if (!tailSlot || !tailSlot.activity_id || tailSlot.is_anchor) return

      const tailActivity = actMap.get(tailSlot.activity_id)
      const day = days.find(d => d.id === dayId)
      expandSlot(groupId, dayId, headBlockId, tailBlockId, tailSlot.activity_id, tailActivity?.name || '', tailBlock.name, day?.label ?? dayId)
      return
    }

    if (paletteActivity) {
      const d = over.data.current || {}
      const groupId = d.groupId ?? d.slot?.groupId
      const dayId = d.dayId ?? d.slot?.dayId
      const blockId = d.blockId ?? d.slot?.blockId
      if (!groupId || !dayId || !blockId) return
      const targetSlot = getSlot(slots, groupId, dayId, blockId)
      if (targetSlot?.is_anchor) return
      placeActivityManual(paletteActivity.id, groupId, dayId, blockId)
      return
    }

    // Slot swap
    const slotA = active.data.current?.slot
    const slotB = over.data.current?.slot
    if (!slotA || !slotB) return
    if (slotA.groupId === slotB.groupId && slotA.dayId === slotB.dayId && slotA.blockId === slotB.blockId) return
    if (slotB.type === 'anchor' || slotB.type === 'unavailable') return
    swapSlots(
      { groupId: slotA.groupId, dayId: slotA.dayId, blockId: slotA.blockId, activityId: slotA.activity_id },
      { groupId: slotB.groupId, dayId: slotB.dayId, blockId: slotB.blockId, activityId: slotB.activity_id }
    )
  }

  // T3 — cell selection (single and multi) and paste mode
  function handleSelectGroup(groupId) {
    setSelectedGroup(groupId)
    clearSelection()
  }

  // Always count flags camp-wide so badges don't change value when switching views
  const flagSlots = slots

  // Findings rail rows: UNFILLABLE (per-slot, unchanged) + UNDERSERVED/
  // DISTRIBUTION (aggregate findings from the last buildSchedule() run) —
  // the header badge counts distinct problems, not flagged slots.
  const isManual = route === 'manual'

  // Flag SET differs by route; flag VOCABULARY does not. The manual route has
  // no UNFILLABLE (an empty cell there is simply not filled yet) and gains
  // OVERLAP; the generated route is unchanged.
  const unfillableSlots = isManual
    ? []
    : flagSlots.filter(s => s.flags?.UNFILLABLE && !s.flags?.UNFILLABLE_dismissed)
  const overlapSlots = isManual ? flagSlots.filter(s => s.flags?.OVERLAP) : []
  const activeFindings = findings.filter(f => !dismissedFindingKeys.has(`${f.groupId}|${f.activityId}|${f.kind}`))
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
      return `Try to fit ${f.requiredBefore} in before ${byDay} — ${f.beforeCount} so far. Spread them out if you can.`
    }
    return f.reason
  }

  const findingsRows = [
    ...unfillableSlots.map(s => ({
      key: s.id,
      kind: 'UNFILLABLE',
      severity: FLAG_SEVERITY.UNFILLABLE,
      reason: s.flags?.UNFILLABLE_reason || 'No activity this group can do fits here',
      locator: slotLocator(s),
      slotIds: [s.id],
      groupId: s.group_id,
    })),
    ...overlapSlots.map(s => ({
      key: `overlap-${s.id}`,
      kind: 'OVERLAP',
      severity: FLAG_SEVERITY.OVERLAP,
      reason: s.flags?.OVERLAP_reason || 'More groups are booked into this than it holds',
      locator: slotLocator(s),
      groupId: s.group_id,
    })),
    ...activeFindings.map(f => ({
      key: `${f.groupId}|${f.activityId}|${f.kind}`,
      kind: f.kind,
      severity: f.severity,
      reason: findingReason(f),
      locator: [groups.find(g => g.id === f.groupId)?.name, activities.find(a => a.id === f.activityId)?.name].filter(Boolean).join(' · '),
      groupId: f.groupId,
      activityId: f.activityId,
    })),
  ].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

  function dismissFindingsRow(row) {
    if (row.kind === 'UNFILLABLE') dismissFlag(row.slotIds, 'UNFILLABLE')
    // OVERLAP is derived from the week on screen, so there is nothing to
    // dismiss — it clears when the director moves one of the clashing
    // placements, which is the only honest way for it to go away.
    else if (row.kind !== 'OVERLAP') dismissFinding(row.groupId, row.activityId, row.kind)
  }

  function locateFindingsRow(row) {
    setView('group')
    setSelectedGroup(row.groupId)
    setFindingsRailOpen(false)
  }

  // Register the colour assignment for this camp's activity set before anything
  // renders a dot. The hash alone collided badly on real data — three of one
  // camp's four activities shared an entry — so the set has to be resolved as a
  // whole rather than each id independently. useMemo, not an effect: the first
  // paint must already have the right colours, and it is idempotent.
  useMemo(() => setActivityPalette(activities), [activities])

  // Which saved version, if any, is the week currently displayed. Derived from
  // the payloads on every change rather than stored, so the label cannot go
  // stale after an edit or a restore — and so it is never inferred from list
  // position, which is what made the newest version unrestorable.
  const versionRows = useMemo(
    () => snapshots.map(s => ({ ...s, on_screen: snapshotMatchesSchedule(s, { slots, overlays }) })),
    [snapshots, slots, overlays]
  )

  // colorIdx carries the activity's stable id, which activityColor() looks up in
  // that assignment (falling back to the bare hash if none is registered).
  const actMap = new Map(activities.map(a => [a.id, { ...a, colorIdx: a.id }]))
  const anchorMap = new Map(anchors.map(a => [a.id, a]))

  // Grid geometry (getSlot / tails / rowspans / overlays) lives in the pure
  // ./schedule/gridGeometry module. Bind the current data once so the views and
  // the handlers below call the readers with just a cell coordinate.
  const geometry = makeGridGeometry({ slots, timeBlocks, groups, overlays, fillState })

  // One required set, shared with the sidebar. This used to be an
  // inline check of a different four areas — see src/engine/readiness.js.
  const setupGaps = getSetupGaps({ cohorts, tiers, groups, days, timeBlocks, activities })

  if (loading) return <div style={S.stateLoading}>Loading…</div>

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
          <button onClick={() => onNavigate(setupGaps[0].screen)} style={{ ...S.btnPrimary, marginTop: 12 }}>
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
      caption: 'The week you\u2019re building',
      captionSub: 'You place everything. The app just watches for clashes.',
      offerTitle: 'Build it myself',
      offerBody: 'Start from a blank week with your meals and fixed events already in place. You place every activity yourself \u2014 the way you would in a spreadsheet, but it watches for clashes and tells you what each group still needs.',
      offerAction: 'Start a blank week',
    },
    generated: {
      label: 'Generated',
      caption: 'The week the app proposed',
      captionSub: 'Drag anything to move it.',
      offerTitle: 'Let the app propose one',
      offerBody: 'The app fills the week from your activity targets. You then move things around by dragging.',
      offerAction: 'Generate a schedule',
    },
  }

  // The neutral 'schedule' entry (AnchorsScreen "Next: Schedule")
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
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>Which week do you want to open?</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6, marginBottom: 20 }}>You have both. Opening one changes nothing about the other, and you can switch any time from the left.</div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          {ROUTES.map(r => (
            <button
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
    const open = rows.filter(x => x.is_anchor === false).length
    const filled = rows.filter(x => x.is_anchor === false && x.activity_id).length
    return `${filled} of ${open} placed`
  }

  const startRoute = { manual: placeAnchors, generated: generate }

  function exportRoute(r) {
    exportToExcel({ slots: slotsByRoute[r], activities, anchors, groups, days, timeBlocks })
  }

  // If only one route has been started there is no choice to make and nothing
  // is being elected. As soon as both exist, the director picks — every time.
  function handleExportClick() {
    const started = ROUTES.filter(r => slotsByRoute[r].length > 0)
    if (started.length <= 1) {
      exportRoute(started[0] ?? route)
      return
    }
    setExportChoosing(true)
  }

  function routeOffer(r) {
    const copy = ROUTE_COPY[r]
    return (
      <div key={r} style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
        padding: '18px 20px', width: 280, display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>{copy.offerTitle}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{copy.offerBody}</div>
        <button
          onClick={() => { setRoute(r); onNavigate?.(`schedule:${r}`); startRoute[r]() }}
          disabled={generating || role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={{
            ...(r === 'generated' ? S.btnPrimary : S.btnSecondary),
            marginTop: 6, alignSelf: 'flex-start',
            ...(generating || role !== 'admin' ? S.buttonDisabled : {}),
          }}
        >{copy.offerAction}</button>
      </div>
    )
  }


  return (
    <div style={{ maxWidth: '100%' }}>
      {loadError && (
        <div style={S.errorBanner}>
          {loadError}
        </div>
      )}
      {templateError && (
        <div style={S.errorBanner}>
          {templateError}
        </div>
      )}
      {actionError && (
        <div style={S.errorBanner}>
          {actionError}
        </div>
      )}
      {/* Controls bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {anyRouteStarted && (
          <>
            {/* Which route this week belongs to. Route SELECTION lives in the
                left sidebar (src/components/layout/Sidebar.jsx) — Manual and
                Generated are two places a director navigates between, not a
                mode toggle sitting on top of one grid. This is a label, not a
                switch, and it designates nothing as "the" schedule. */}
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
              <span style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
                {ROUTE_COPY[route].label}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)' }}>
                {routeSummary(route)}
              </span>
            </div>

            {/* View toggle — how to LOOK at this route's week. "Manual Build"
                is gone from here: it was never a view, it was a route. */}
            <div style={{ display: 'flex', gap: 2, background: 'var(--border)', borderRadius: 8, padding: 3 }}>
              {[['group','Group View'],['day','Daily View'],['activity','Activity View']].map(([v, label]) => (
                <button key={v} onClick={() => { setView(v); if (v !== 'activity') setSelectedActivity(null) }} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', borderBottom: view === v ? '2px solid var(--primary)' : '2px solid transparent', cursor: 'pointer', fontSize: 12, fontWeight: view === v ? 700 : 600, fontFamily: 'var(--font-sans)', background: view === v ? 'var(--surface)' : 'none', color: view === v ? 'var(--primary)' : 'var(--text-secondary)', boxShadow: view === v ? '0 1px 4px rgba(0,0,0,0.12)' : 'none', transition: 'color 0.12s, background 0.12s' }}>{label}</button>
              ))}
            </div>

            {/* Undo / Redo (T5) */}
            <button
              onClick={handleUndo}
              disabled={undoStack.length === 0}
              title={undoStack.length > 0 ? `Undo: ${undoStack[undoStack.length - 1].description}` : 'Nothing to undo'}
              style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', cursor: undoStack.length === 0 ? 'not-allowed' : 'pointer', opacity: undoStack.length === 0 ? 0.35 : 1, fontSize: 14, fontFamily: 'inherit' }}
            >↩</button>
            <button
              onClick={handleRedo}
              disabled={redoStack.length === 0}
              title={redoStack.length > 0 ? `Redo: ${redoStack[redoStack.length - 1].description}` : 'Nothing to redo'}
              style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', cursor: redoStack.length === 0 ? 'not-allowed' : 'pointer', opacity: redoStack.length === 0 ? 0.35 : 1, fontSize: 14, fontFamily: 'inherit' }}
            >↪</button>

            {/* Weather toggle */}
            <button
              onClick={() => setWeatherMode(w => !w)}
              style={{ padding: '6px 14px', border: `1px solid ${weatherMode ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6, background: weatherMode ? 'color-mix(in srgb, var(--accent) 9%, var(--surface))' : 'var(--surface)', color: weatherMode ? 'var(--accent)' : 'var(--text)', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
            >
              ⛅ Weather Mode {weatherMode ? 'ON' : 'OFF'}
            </button>

            <div style={{ flex: 1 }} />

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

            <button
              onClick={() => {
                if (stampMode) {
                  // Cancel active stamp mode instead of opening drawer
                  setStampMode(null)
                } else {
                  setShowFieldTripDrawer(v => !v)
                }
              }}
              style={{
                padding: '6px 14px',
                border: `1px solid ${showFieldTripDrawer || stampMode ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 6,
                background: showFieldTripDrawer || stampMode ? 'color-mix(in srgb, var(--accent) 9%, transparent)' : 'var(--surface)',
                color: showFieldTripDrawer || stampMode ? 'color-mix(in srgb, var(--accent) 60%, var(--text))' : 'var(--text)',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
              title={stampMode ? `Stamp mode active: "${stampMode}" — click to cancel` : showFieldTripDrawer ? 'Click to close' : 'Field Trips'}
            >
              {stampMode ? `✕ ${stampMode}` : showFieldTripDrawer ? '✕ Field Trip' : 'Field Trips'}
            </button>

            {/* Export must act on exactly ONE schedule, and the app does not get
                to pick. With both routes started it asks, every time, and never
                remembers the answer. */}
            <button onClick={handleExportClick} style={S.btnSecondary}>Export to Excel</button>
            {!isManual && (
              <button
                onClick={() => setConfirmRegen(true)}
                disabled={role !== 'admin'}
                title={role !== 'admin' ? 'Admin only' : undefined}
                style={role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
              >Build a new week</button>
            )}
          </>
        )}

        {anyRouteStarted && generating && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>Generating…</span>}
      </div>

      {/* Stats bar — its SHAPE differs by route, which is itself an orientation
          cue: a director who glances at the tiles knows where they are. */}
      {hasSchedule && stats && (
        <div style={{ position: 'relative', display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {/* T18: one concept, one name, on both routes. These labels used to be
              ternaries on isManual — the manual route said "Placed" / "Still
              needed" / "Spread across the week" while the generated route said
              "Filled" / "Underserved" / "Distribution" for the SAME numbers.
              The routes were deliberately given a shared flag vocabulary so a
              director learns it once; two names for one concept defeated that.
              The director's words win over the engine's (Art. V).

              Unfillable vs Overlapping below is NOT this — those are genuinely
              different flags, and the routes share a vocabulary, not a flag set. */}
          <StatBadge
            label="Placed"
            value={`${stats.filled} of ${stats.open}`}
            color={isManual ? 'var(--text-secondary)' : 'var(--success)'}
          />
          {isManual ? (
            <StatBadge
              label="Overlapping"
              value={overlapSlots.length}
              color={overlapSlots.length > 0 ? 'var(--accent)' : 'var(--text-secondary)'}
              onClick={() => setFindingsRailOpen(o => !o)}
            />
          ) : (
            <StatBadge
              label="Unfillable"
              value={unfillableSlots.length}
              color={unfillableSlots.length > 0 ? 'var(--danger)' : 'var(--text-secondary)'}
              onClick={() => setFindingsRailOpen(o => !o)}
            />
          )}
          <StatBadge
            label="Still needed"
            value={activeFindings.filter(f => f.kind === 'UNDERSERVED').length}
            color={activeFindings.some(f => f.kind === 'UNDERSERVED') ? 'var(--accent)' : 'var(--text-secondary)'}
            onClick={() => setFindingsRailOpen(o => !o)}
          />
          <StatBadge
            label="Spread across the week"
            value={activeFindings.filter(f => f.kind === 'DISTRIBUTION').length}
            color={activeFindings.some(f => f.kind === 'DISTRIBUTION') ? 'var(--secondary)' : 'var(--text-secondary)'}
            onClick={() => setFindingsRailOpen(o => !o)}
          />
          {/* Same framing on both routes. An under-target activity means the
              same thing however the week was built: work remaining, not a
              mistake made. The generated route previously got no intro at all,
              so identical findings read as bare failures there. */}
          {findingsRailOpen && (
            <FindingsRail
              rows={findingsRows}
              onDismiss={dismissFindingsRow}
              onLocate={locateFindingsRow}
              onClose={() => setFindingsRailOpen(false)}
              intro={{ title: 'What this week still needs', sub: "Nothing here is a mistake. It's what's left to place." }}
              emptyText="Everything on your list is placed."
            />
          )}
        </div>
      )}

      {/* Paste mode status line */}
      {pasteMode && clipboardItems.length > 0 && (
        <div style={{ ...S.pasteStatusLine, ...(pasteError ? S.pasteStatusLineError : {}), marginBottom: 16 }}>
          <span>
            {pasteError
              ? `⚠ ${pasteError}`
              : `⊡ ${clipboardItems.length - pasteModeIndex} of ${clipboardItems.length} to paste — click a cell to place "${clipboardItems[pasteModeIndex]?.activityName}"`}
          </span>
          <button
            onClick={cancelPaste}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 11, fontFamily: 'inherit', padding: 0 }}
          >Esc to cancel</button>
        </div>
      )}

      {/* === Main content: persistent sidebar + grid area === */}
      {(() => {
        // Slots scoped for the palette count display
        const paletteSlots = view === 'activity'
          ? slots.filter(s => !s.is_anchor)
          : slots.filter(s => s.group_id === selectedGroup && !s.is_anchor)

        const sidebar = (
          <ActivityPalette
            activities={activities}
            slots={paletteSlots}
            showTargets={isManual}
            draggable={view === 'group' || view === 'day'}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(c => !c)}
          />
        )

        const gridContent = (
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Neither route started: a genuine choice, presented as one. */}
            {!anyRouteStarted && !generating && (
              <div style={{ padding: '60px 16px', textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>How do you want to build this week?</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6, marginBottom: 20 }}>You can do both. Nothing you build one way affects the other.</div>
                <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap', textAlign: 'left' }}>
                  {routeOffer('manual')}
                  {routeOffer('generated')}
                </div>
              </div>
            )}

            {/* The other route has work, this one does not: the same offer,
                inline. No warning, no confirmation — nothing is at risk. */}
            {anyRouteStarted && !hasSchedule && !generating && (
              <div style={{ display: 'flex', marginBottom: 8 }}>{routeOffer(route)}</div>
            )}

            {/* Which week am I looking at — in plain language, always present. */}
            {hasSchedule && (
              <div style={{ marginBottom: 12 }}>
                <span style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{ROUTE_COPY[route].caption}</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 8 }}>{ROUTE_COPY[route].captionSub}</span>
              </div>
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
                anchorMap={anchorMap}
                geometry={geometry}
                onEditSlot={setEditSlot}
                onExpandSlot={expandSlot}
                onSplitSlot={splitSlot}
                selectedSlotKeys={selectedSlotKeys}
                pasteMode={pasteMode}
                onCellSelect={handleCellSelect}
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
                stampMode={stampMode}
                actMap={actMap}
                anchorMap={anchorMap}
                releaseCell={releaseCell}
                geometry={geometry}
                handleFillEnter={handleFillEnter}
                startFill={startFill}
                removeOverlay={removeOverlay}
                handleStampClick={handleStampClick}
                onEditSlot={setEditSlot}
                fillState={fillState}
                onExpandSlot={expandSlot}
                onSplitSlot={splitSlot}
                isExpandDragActive={isGroupExpandDragActive}
                selectedSlotKeys={selectedSlotKeys}
                pasteMode={pasteMode}
                onCellSelect={handleCellSelect}
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
                stampMode={stampMode}
                actMap={actMap}
                anchorMap={anchorMap}
                lockActivity={lockActivity}
                releaseCell={releaseCell}
                geometry={geometry}
                handleFillEnter={handleFillEnter}
                startFill={startFill}
                removeOverlay={removeOverlay}
                handleStampClick={handleStampClick}
                onEditSlot={setEditSlot}
                fillState={fillState}
                isExpandDragActive={isDayExpandDragActive}
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
                selectedActivity={selectedActivity}
                onSelectActivity={setSelectedActivity}
              />
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
        // reach the droppable cells. Group view also handles expand-drag.
        if (view === 'group') {
          return (
            <DndContext
              key="group"
              sensors={sensors}
              onDragStart={handleGroupDragStart}
              onDragEnd={handleGroupDragEnd}
              onDragCancel={() => setIsGroupExpandDragActive(false)}
            >
              {twoCol}
            </DndContext>
          )
        }
        if (view === 'day') {
          return (
            <DndContext
              key="day"
              sensors={sensors}
              onDragStart={handleDayDragStart}
              onDragEnd={handleDayDragEnd}
              onDragCancel={() => setIsDayExpandDragActive(false)}
            >
              {twoCol}
            </DndContext>
          )
        }
        return twoCol
      })()}

      {/* Displaced activity palette (floating) */}
      {hasSchedule && (
        <DisplacedPalette
          displacedItems={displacedItems}
          onDismiss={dismissDisplaced}
        />
      )}

      {/* Edit modal */}
      {editSlot && (
        <EditModal
          slot={editSlot}
          activities={activities}
          eligibleActivities={activities.filter(a => {
            const g = groups.find(g => g.id === editSlot.groupId)
            if (!g) return false
            const tierIds = a.eligible_tier_ids || []
            const groupIds = a.eligible_group_ids || []
            if (tierIds.length === 0 && groupIds.length === 0) return true
            if (tierIds.includes(g.tier_id)) return true
            if (groupIds.includes(g.id)) return true
            return false
          })}
          currentActivity={(editSlot.activityId || editSlot.activity_id)
            ? actMap.get(editSlot.activityId || editSlot.activity_id)
            : null}
          currentAnchor={(editSlot.anchorId || editSlot.anchor_id)
            ? anchorMap.get(editSlot.anchorId || editSlot.anchor_id)
            : null}
          weatherAlt={weatherMode && (editSlot.activityId || editSlot.activity_id) ? (() => { const a = actMap.get(editSlot.activityId || editSlot.activity_id); return a?.weather_alternative_id ? actMap.get(a.weather_alternative_id) : null })() : null}
          weatherMode={weatherMode}
          onSave={editSlotSave}
          onClose={() => setEditSlot(null)}
        />
      )}


      {exportChoosing && (
        <ExportChooserModal
          options={ROUTES.map(r => ({
            key: r,
            title: ROUTE_COPY[r].caption,
            filled: slotsByRoute[r].filter(x => x.is_anchor === false && x.activity_id).length,
            total: slotsByRoute[r].filter(x => x.is_anchor === false).length,
          }))}
          onChoose={r => { setExportChoosing(false); exportRoute(r) }}
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

      {/* Grid legend — every treatment the grid can show, from one source
          (LEGEND_ENTRIES) so a new flag cannot ship undocumented. */}
      {hasSchedule && (
        <div style={{ display: 'flex', gap: 16, marginTop: 16, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-secondary)' }}>
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
                      : { width: 10, height: 10, borderRadius: 2, background: entry.color, border: '1px solid var(--border)', display: 'inline-block', flexShrink: 0 }
                }
              />
              {entry.label}
            </span>
          ))}
        </div>
      )}

      <FieldTripDrawer
        isOpen={showFieldTripDrawer}
        onClose={() => setShowFieldTripDrawer(false)}
        activeStamp={stampMode}
        onSelectStamp={label => {
          setStampMode(label)
          if (label) setShowFieldTripDrawer(false)
        }}
      />
    </div>
  )
}

