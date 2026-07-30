import { useState, useEffect } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { localClient } from '../localClient'
import buildSchedule, { computeFindings } from '../engine/buildSchedule'
import { S } from '../styles/shared'
import StatBadge from '../components/schedule/StatBadge'
import { legendEntriesFor, FLAG_SEVERITY } from '../components/schedule/slotCellConstants'
import FindingsRail from '../components/schedule/FindingsRail'
import EditModal from '../components/schedule/EditModal'
import ConfirmRegenModal from '../components/schedule/ConfirmRegenModal'
import ExportChooserModal from '../components/schedule/ExportChooserModal'
import VersionsDropdown from '../components/schedule/VersionsDropdown'
import { isRestorable, parseSnapshotPayload, unrestorableMessage } from './snapshotRestore'
import FieldTripDrawer from '../components/schedule/FieldTripDrawer'
import { exportToExcel } from '../utils/exportSchedule'
import { normalizeSlots } from '../utils/normalizeSlots'
import { withOverlapFlags } from '../utils/computeOverlaps'
import { deriveScheduleTemplateId } from '../../electron/ops/scheduleTemplateId'
import { resolveSelection } from './resolveSelection'
import { normalizeActivityEligibility } from '../utils/normalizeActivityEligibility'
import ScheduleGroupView from '../components/schedule/ScheduleGroupView'
import ScheduleDayView from '../components/schedule/ScheduleDayView'
import ScheduleActivityView from '../components/schedule/ScheduleActivityView'
import ManualBuildView from '../components/schedule/ManualBuildView'
import ActivityPalette from '../components/schedule/ActivityPalette'
import DisplacedPalette from '../components/schedule/DisplacedPalette'

// Fires one write() per field (the op-log is field-level) and surfaces the
// first failure rather than a silent partial write — mirrors
// DayOverridesScreen.jsx/ActivitiesScreen.jsx's identical helper.
async function writeFields(entity, id, fields) {
  const token = localStorage.getItem('shoresh-token')
  for (const [field, value] of Object.entries(fields)) {
    const result = await localClient.write(token, entity, id, field, value)
    if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
      throw new Error(`write failed for field "${field}"`)
    }
  }
}

// Two routes to a schedule, each with its own candidate: the director builds
// one themselves (the spreadsheet replacement) or the app proposes one and they
// edit it. NEITHER is the real schedule — that call is the director's, and the
// app must never make it for them (CONSTITUTION.md Art. V, and the ADR on
// plural candidate schedules). Route selection is local UI state and does not
// replicate.
const ROUTES = ['generated', 'manual']
const EMPTY_BY_ROUTE = (value) => ({ generated: value(), manual: value() })

// Keeps the ~20 existing call sites writing `setSlots(prev => ...)` exactly as
// they were, while the value they touch is the current route's.
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

function routeSetter(setState, route) {
  return updater =>
    setState(prev => ({
      ...prev,
      [route]: typeof updater === 'function' ? updater(prev[route]) : updater,
    }))
}

export default function ScheduleScreen({ campId, role, onNavigate, initialRoute }) {
  const [groups, setGroups] = useState([])
  const [days, setDays] = useState([])
  const [timeBlocks, setTimeBlocks] = useState([])
  const [activities, setActivities] = useState([])
  const [anchors, setAnchors] = useState([])
  const [tiers, setTiers] = useState([])
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
  // Which routes actually have a schedule_templates row today. The id itself is
  // derived, never minted — two devices that independently create a candidate
  // for the same camp and route must agree on its id or their work forks.
  const [existingTemplates, setExistingTemplates] = useState(() => EMPTY_BY_ROUTE(() => false))
  // The id a route's schedule_templates row ACTUALLY has. Resolved from the
  // database by (camp_id, kind); the derived id is only a fallback used when
  // minting a row that does not exist yet. See resolveTemplateId below.
  const [templateIdByRoute, setTemplateIdByRoute] = useState(() => ({ generated: null, manual: null }))
  const [slotsByRoute, setSlotsByRoute] = useState(() => EMPTY_BY_ROUTE(() => []))
  const [statsByRoute, setStatsByRoute] = useState(() => EMPTY_BY_ROUTE(() => null))
  // Aggregate UNDERSERVED/DISTRIBUTION findings from the last buildSchedule()
  // call — never persisted, recomputed fresh on every generate()/placeAnchors()
  // (docs/adr/2026-07-28-schedule-flag-findings-reshape.md §"findings never persisted").
  const [findingsByRoute, setFindingsByRoute] = useState(() => EMPTY_BY_ROUTE(() => []))
  const [dismissedByRoute, setDismissedByRoute] = useState(() => EMPTY_BY_ROUTE(() => new Set()))
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
  const [snapshotsByRoute, setSnapshotsByRoute] = useState(() => EMPTY_BY_ROUTE(() => []))
  const [overlaysByRoute, setOverlaysByRoute] = useState(() => EMPTY_BY_ROUTE(() => []))
  const [exportChoosing, setExportChoosing] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [stampMode, setStampMode] = useState(null) // null | string (label of active stamp)
  const [showFieldTripDrawer, setShowFieldTripDrawer] = useState(false)
  const [fillState, setFillState] = useState(null)  // null | { overlayId, previewToOrder }
  const [displacedItems, setDisplacedItems] = useState([])
  const [isDayExpandDragActive, setIsDayExpandDragActive] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isGroupExpandDragActive, setIsGroupExpandDragActive] = useState(false)
  // T5 — undo / redo
  const [undoStack, setUndoStack] = useState([])
  const [redoStack, setRedoStack] = useState([])
  // T3 — selection and copy/paste
  const [selectedSlotKeys, setSelectedSlotKeys] = useState(new Set())
  const [clipboardItems, setClipboardItems] = useState([])
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteModeIndex, setPasteModeIndex] = useState(0)
  const [pasteError, setPasteError] = useState(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  // Everything below reads and writes the CURRENT route's candidate. Names and
  // shapes are unchanged from the single-schedule version on purpose.
  const templateIdFor = (r) => templateIdByRoute[r] || deriveScheduleTemplateId(campId, r)
  const templateId = templateIdFor(route)
  const rawSlots = slotsByRoute[route]
  // OVERLAP is derived, never persisted — so it clears from every participating
  // cell the moment any one of them moves, and only on the manual route, where
  // a clashing placement is accepted rather than refused.
  const slots = route === 'manual' ? withOverlapFlags(rawSlots, activities) : rawSlots
  const stats = statsByRoute[route]
  const findings = findingsByRoute[route]
  const dismissedFindingKeys = dismissedByRoute[route]
  const overlays = overlaysByRoute[route]
  const snapshots = snapshotsByRoute[route]

  const setSlots = routeSetter(setSlotsByRoute, route)
  const setStats = routeSetter(setStatsByRoute, route)
  const setFindings = routeSetter(setFindingsByRoute, route)
  const setDismissedFindingKeys = routeSetter(setDismissedByRoute, route)
  const setOverlays = routeSetter(setOverlaysByRoute, route)
  const setSnapshots = routeSetter(setSnapshotsByRoute, route)

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
    setUndoStack([])
    setRedoStack([])
    setClipboardItems([])
    setPasteMode(false)
    setPasteModeIndex(0)
    setPasteError(null)
    setSelectedSlotKeys(new Set())
    setEditSlot(null)
    setStampMode(null)
    setFillState(null)
    setDisplacedItems([])
  }

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

  // T3 — keyboard shortcuts: Ctrl+C (copy), Ctrl+A (select all), Escape
  useEffect(() => {
    function onKeyDown(e) {
      const isMeta = e.ctrlKey || e.metaKey
      if (e.key === 'Escape') {
        if (pasteMode) {
          setPasteMode(false)
          setClipboardItems([])
          setPasteModeIndex(0)
        } else {
          setSelectedSlotKeys(new Set())
        }
        return
      }
      if (isMeta && e.key === 'c') {
        e.preventDefault()
        if (selectedSlotKeys.size === 0) return
        const items = []
        for (const key of selectedSlotKeys) {
          const [gId, dId, bId] = key.split('|')
          const s = slots.find(sl => sl.group_id === gId && sl.day_id === dId && sl.time_block_id === bId)
          if (!s || !s.activity_id) continue
          const act = activities.find(a => a.id === s.activity_id)
          items.push({ activityId: s.activity_id, activityName: act?.name || '' })
        }
        if (items.length === 0) return
        setClipboardItems(items)
        setPasteModeIndex(0)
        setPasteMode(true)
        setSelectedSlotKeys(new Set())
      }
      if (isMeta && e.key === 'a') {
        e.preventDefault()
        const newKeys = new Set()
        for (const s of slots) {
          if (s.is_anchor || !s.activity_id || s.is_span_head === false) continue
          if (selectedGroup && s.group_id !== selectedGroup) continue
          newKeys.add(`${s.group_id}|${s.day_id}|${s.time_block_id}`)
        }
        setSelectedSlotKeys(newKeys)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pasteMode, selectedSlotKeys, slots, activities, selectedGroup])

  // T5 — undo/redo keyboard shortcuts: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
  useEffect(() => {
    function onKeyDown(e) {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const ctrl = isMac ? e.metaKey : e.ctrlKey
      if (!ctrl) return
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo() }
      if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); handleRedo() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoStack, redoStack])

  useEffect(() => {
    if (!fillState) return
    function onPointerUp() {
      const previewTo = fillState.previewToOrder
      if (previewTo !== undefined) {
        const overlay = overlays.find(o => o.id === fillState.overlayId)
        if (overlay && previewTo !== overlay.to_block_order) {
          updateOverlayRange(fillState.overlayId, previewTo)
        }
      }
      setFillState(null)
    }
    window.addEventListener('pointerup', onPointerUp)
    return () => window.removeEventListener('pointerup', onPointerUp)
  // updateOverlayRange is redefined every render now that `overlays` is a
  // derived, route-scoped value; listing it would re-bind the listener on
  // every render for no behavioural gain. The values it reads are in the deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillState, overlays])

  async function loadAll() {
    setLoading(true)
    setLoadError(null)
    setTemplateError(null)
    let g, a, d
    try {
      const [gd, td, bd, ad, ancd, tierd] = await Promise.all([
        localClient.list('groups'),
        localClient.list('days_of_operation'),
        localClient.list('time_blocks'),
        localClient.list('activities'),
        localClient.list('anchor_activities'),
        localClient.list('tiers'),
      ])
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
      setGroups(sortedG); setDays(d); setTimeBlocks(b); setActivities(a); setAnchors(anc); setTiers(t)
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
      const templates = (await localClient.list('schedule_templates')) || []
      const [slotData, overlayData, snapData] = await Promise.all([
        localClient.list('template_slots'),
        localClient.list('template_overlays'),
        localClient.list('schedule_snapshots'),
      ])
      const allSlots = normalizeSlots(slotData)

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
          .map(x => ({
            id: x.id, template_id: x.template_id, name: x.name,
            is_auto: x.is_auto, created_at: x.created_at,
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
    await writeFields('schedule_templates', tid, {
      kind: routeName,
      camp_id: campId,
      name: routeName === 'manual' ? 'Manual' : 'Master Template',
    })
    setExistingTemplates(prev => ({ ...prev, [routeName]: true }))
    setTemplateIdByRoute(prev => ({ ...prev, [routeName]: tid }))
    return tid
  }

  // Writes ONLY to the generated candidate — the manual one is never read,
  // moved or cleared here.
  async function generate() {
    setGenerating(true)
    setUndoStack([])
    setRedoStack([])

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

    const lockedActIds = new Set(activities.filter(a => a.is_locked).map(a => a.id))
    const preplacedSlots = slotsByRoute.generated
      .filter(s => s.activity_id && lockedActIds.has(s.activity_id) && !s.is_released && !s.is_anchor)
      .map(s => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, activityId: s.activity_id }))

    const result = buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots })
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

    const token = localStorage.getItem('shoresh-token')

    // Replace all slots in one transactional bulk_replace op
    const rows = result.slots.map(s => ({
      id: crypto.randomUUID(),
      template_id: tid,
      group_id: s.groupId,
      day_id: s.dayId,
      time_block_id: s.blockId,
      activity_id: s.activityId,
      anchor_id: s.anchorId,
      is_anchor: s.type === 'anchor' ? '1' : '0',
      is_span_head: s.is_span_head !== false ? '1' : '0',
      flags: JSON.stringify(s.flags || {}),
    }))

    setActionError(null)
    try {
      // Clear overlays when regenerating (post-generation stamps are re-applied manually)
      await localClient.bulkReplace(token, 'template_overlays', tid, [])
      await localClient.bulkReplace(token, 'template_slots', tid, rows)
    } catch (err) {
      setActionError(
        err?.message?.includes('admin role required')
          ? 'Only an admin can regenerate the schedule'
          : 'Failed to regenerate schedule — check your connection and try again'
      )
      setGenerating(false)
      return
    }
    setGenOverlays([])

    const freshSlots = normalizeSlots(await localClient.list('template_slots')).filter(s => s.template_id === tid)
    setGenSlots(freshSlots)
    setGenStats(statsFor(freshSlots))
    setGenerating(false)
  }

  async function editSlotSave(newActivityId) {
    if (!editSlot || !templateId) return
    const { groupId, dayId, blockId } = editSlot
    const slot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId)
    if (!slot) return

    const prevActivityId = slot.activity_id ?? null
    const prevFlags = slot.flags ?? {}
    const nextActivityId = newActivityId || null

    setActionError(null)
    try {
      await writeFields('template_slots', slot.id, { activity_id: nextActivityId, flags: {} })
    } catch {
      setActionError('Failed to save slot — check your connection and try again')
      return
    }
    setSlots(prev => prev.map(s =>
      s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
        ? { ...s, activity_id: nextActivityId, flags: {} }
        : s
    ))
    setEditSlot(null)

    const actAfter = activities.find(a => a.id === nextActivityId)
    const day = days.find(d => d.id === dayId)
    const block = timeBlocks.find(b => b.id === blockId)
    pushUndo({
      description: `Edited slot → ${actAfter?.name ?? 'empty'} ${day?.label ?? dayId} ${block?.name ?? blockId}`,
      undo: async () => {
        await writeFields('template_slots', slot.id, { activity_id: prevActivityId, flags: prevFlags })
        setSlots(prev => prev.map(s =>
          s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
            ? { ...s, activity_id: prevActivityId, flags: prevFlags }
            : s
        ))
      },
      redo: async () => {
        await writeFields('template_slots', slot.id, { activity_id: nextActivityId, flags: {} })
        setSlots(prev => prev.map(s =>
          s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
            ? { ...s, activity_id: nextActivityId, flags: {} }
            : s
        ))
      },
    })
  }

  async function swapSlots(slotA, slotB) {
    // slotA and slotB are { groupId, dayId, blockId, activityId }
    if (!existingTemplates[route]) return
    const rowA = slots.find(s => s.group_id === slotA.groupId && s.day_id === slotA.dayId && s.time_block_id === slotA.blockId)
    const rowB = slots.find(s => s.group_id === slotB.groupId && s.day_id === slotB.dayId && s.time_block_id === slotB.blockId)
    if (!rowA || !rowB) return
    setActionError(null)
    try {
      await Promise.all([
        writeFields('template_slots', rowA.id, { activity_id: slotB.activityId || null, flags: {} }),
        writeFields('template_slots', rowB.id, { activity_id: slotA.activityId || null, flags: {} }),
      ])
    } catch {
      setActionError('Failed to swap slots — check your connection and try again')
      return
    }
    setSlots(prev => prev.map(s => {
      if (s.group_id === slotA.groupId && s.day_id === slotA.dayId && s.time_block_id === slotA.blockId)
        return { ...s, activity_id: slotB.activityId || null, flags: {} }
      if (s.group_id === slotB.groupId && s.day_id === slotB.dayId && s.time_block_id === slotB.blockId)
        return { ...s, activity_id: slotA.activityId || null, flags: {} }
      return s
    }))

    const actA = activities.find(a => a.id === slotA.activityId)
    const actB = activities.find(a => a.id === slotB.activityId)
    pushUndo({
      description: `Swapped ${actA?.name ?? 'slot'} ↔ ${actB?.name ?? 'slot'}`,
      undo: async () => {
        await Promise.all([
          writeFields('template_slots', rowA.id, { activity_id: slotA.activityId || null, flags: {} }),
          writeFields('template_slots', rowB.id, { activity_id: slotB.activityId || null, flags: {} }),
        ])
        setSlots(prev => prev.map(s => {
          if (s.group_id === slotA.groupId && s.day_id === slotA.dayId && s.time_block_id === slotA.blockId)
            return { ...s, activity_id: slotA.activityId || null, flags: {} }
          if (s.group_id === slotB.groupId && s.day_id === slotB.dayId && s.time_block_id === slotB.blockId)
            return { ...s, activity_id: slotB.activityId || null, flags: {} }
          return s
        }))
      },
      redo: async () => {
        await Promise.all([
          writeFields('template_slots', rowA.id, { activity_id: slotB.activityId || null, flags: {} }),
          writeFields('template_slots', rowB.id, { activity_id: slotA.activityId || null, flags: {} }),
        ])
        setSlots(prev => prev.map(s => {
          if (s.group_id === slotA.groupId && s.day_id === slotA.dayId && s.time_block_id === slotA.blockId)
            return { ...s, activity_id: slotB.activityId || null, flags: {} }
          if (s.group_id === slotB.groupId && s.day_id === slotB.dayId && s.time_block_id === slotB.blockId)
            return { ...s, activity_id: slotA.activityId || null, flags: {} }
          return s
        }))
      },
    })
  }

  async function dismissFlag(slotIds, flagName) {
    const updates = slotIds.map(id => {
      const slot = slots.find(s => s.id === id)
      if (!slot) return null
      const newFlags = { ...(slot.flags || {}), [`${flagName}_dismissed`]: true }
      return { id, newFlags }
    }).filter(Boolean)

    setActionError(null)
    try {
      await Promise.all(updates.map(({ id, newFlags }) => writeFields('template_slots', id, { flags: newFlags })))
    } catch {
      setActionError('Failed to dismiss flag — check your connection and try again')
      return
    }

    setSlots(prev => {
      const next = prev.map(s => {
        const u = updates.find(u => u.id === s.id)
        return u ? { ...s, flags: u.newFlags } : s
      })
      recalcStats(next)
      return next
    })
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

  async function lockActivity(activityId) {
    setActionError(null)
    try {
      await writeFields('activities', activityId, { is_locked: true })
    } catch {
      setActionError('Failed to lock activity — check your connection and try again')
      return
    }
    setActivities(prev => prev.map(a => a.id === activityId ? { ...a, is_locked: true } : a))
  }

  async function releaseCell(slotId) {
    setActionError(null)
    try {
      await writeFields('template_slots', slotId, { is_released: true })
    } catch {
      setActionError('Failed to release cell — check your connection and try again')
      return
    }
    setSlots(prev => prev.map(s => s.id === slotId ? { ...s, is_released: true } : s))
  }

  async function addOverlay({ unitId, dayId, fromBlockOrder, toBlockOrder, label }) {
    if (!existingTemplates[route]) return
    if (!unitId) {
      console.warn('addOverlay: group has no tier_id — cannot create overlay')
      return
    }
    const id = crypto.randomUUID()
    const overlay = { id, template_id: templateId, unit_id: unitId, day_id: dayId, from_block_order: fromBlockOrder, to_block_order: toBlockOrder, label }
    setActionError(null)
    try {
      await writeFields('template_overlays', id, { template_id: templateId, unit_id: unitId, day_id: dayId, from_block_order: fromBlockOrder, to_block_order: toBlockOrder, label })
    } catch {
      setActionError('Failed to add overlay — check your connection and try again')
      return
    }
    setOverlays(prev => [...prev, overlay])
  }

  async function removeOverlay(overlayId) {
    const token = localStorage.getItem('shoresh-token')
    setActionError(null)
    try {
      const result = await localClient.deleteEntity(token, 'template_overlays', overlayId)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error('delete failed')
      }
    } catch {
      setActionError('Failed to remove overlay — check your connection and try again')
      return
    }
    setOverlays(prev => prev.filter(o => o.id !== overlayId))
  }

  async function updateOverlayRange(overlayId, toBlockOrder) {
    setActionError(null)
    try {
      await writeFields('template_overlays', overlayId, { to_block_order: toBlockOrder })
    } catch {
      setActionError('Failed to update overlay — check your connection and try again')
      return
    }
    setOverlays(prev => prev.map(o => o.id === overlayId ? { ...o, to_block_order: toBlockOrder } : o))
  }

  // routeName is explicit so generate()/placeAnchors() can snapshot the route
  // they are building rather than whichever one happens to be on screen; every
  // other caller is a user action on the visible route and defaults to it.
  async function saveSnapshot(name, isAuto, routeName = route) {
    if (!existingTemplates[routeName]) return
    const tid = templateIdFor(routeName)
    const setRouteSnapshots = routeSetter(setSnapshotsByRoute, routeName)
    const snapSlots = slotsByRoute[routeName].map(s => ({
      group_id: s.group_id,
      day_id: s.day_id,
      time_block_id: s.time_block_id,
      activity_id: s.activity_id,
      anchor_id: s.anchor_id,
      is_anchor: s.is_anchor,
      flags: s.flags || {},
    }))
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const snapOverlays = overlaysByRoute[routeName].map(o => ({ unit_id: o.unit_id, day_id: o.day_id, from_block_order: o.from_block_order, to_block_order: o.to_block_order, label: o.label }))
    setActionError(null)
    try {
      await writeFields('schedule_snapshots', id, {
        template_id: tid,
        name: name || null,
        is_auto: isAuto,
        created_at: createdAt,
        slots: JSON.stringify(snapSlots),
        overlays: JSON.stringify(snapOverlays),
      })
    } catch (err) {
      setActionError('Failed to save snapshot — check your connection and try again')
      throw err
    }
    setRouteSnapshots(prev => [{ id, template_id: tid, name: name || null, is_auto: isAuto, created_at: createdAt, restorable: true }, ...prev])
  }

  // Deleting a version is the director's call, never an automatic cleanup.
  // Every snapshot saved before the op-value coercion fix (af6a9d8) recorded no
  // schedule data and shows as "Empty" — this is how those get cleared, one at a
  // time, by a human who can see what they are removing.
  //
  // deleteEntity routes to a DELETE_FIELD write, which main.js gates to admin.
  // A refused delete must surface: the row is still there, and saying otherwise
  // would repeat the exact silent-no-op failure this ticket exists to fix.
  async function deleteSnapshot(snapshotId) {
    setActionError(null)
    let result
    try {
      const token = localStorage.getItem('shoresh-token')
      result = await localClient.deleteEntity(token, 'schedule_snapshots', snapshotId)
    } catch (err) {
      setActionError(
        err?.message?.includes('admin role required')
          ? 'Only an admin can delete a saved version'
          : 'Failed to delete that version — check your connection and try again'
      )
      return
    }
    if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
      setActionError('That version could not be deleted. It is still in the list.')
      return
    }
    setSnapshots(prev => prev.filter(s => s.id !== snapshotId))
  }

  async function restoreSnapshot(snapshot) {
    if (!existingTemplates[route]) return
    setUndoStack([])
    setRedoStack([])
    const fullSnap = (await localClient.list('schedule_snapshots')).find(s => s.id === snapshot.id)
    const parsed = parseSnapshotPayload(fullSnap)
    if (!parsed.ok) {
      // Never a bare return: a restore that cannot proceed must say so. This
      // failing silently is the whole of T8.
      setActionError(unrestorableMessage(parsed.reason))
      setSnapshots(prev => prev.map(s => s.id === snapshot.id ? { ...s, restorable: false } : s))
      return
    }
    // restoreSnapshot re-stamps template_id from component state onto every
    // row below. With two candidates per camp, restoring a version that belongs
    // to the OTHER route would silently overwrite this route's entire week —
    // so the version must be one of this route's before anything is written.
    if (fullSnap.template_id !== templateId) {
      setActionError('That saved version belongs to the other schedule. Switch to it to restore this version.')
      return
    }

    fullSnap.slots = parsed.slots
    fullSnap.overlays = parsed.overlays

    const token = localStorage.getItem('shoresh-token')

    const rows = fullSnap.slots.map(s => ({
      id: crypto.randomUUID(),
      template_id: templateId,
      group_id: s.group_id,
      day_id: s.day_id,
      time_block_id: s.time_block_id,
      activity_id: s.activity_id,
      anchor_id: s.anchor_id,
      is_anchor: s.is_anchor ? '1' : '0',
      flags: JSON.stringify(s.flags || {}),
    }))

    const snapOverlays = fullSnap.overlays || []
    const overlayRows = snapOverlays.map(o => ({
      id: crypto.randomUUID(),
      template_id: templateId,
      unit_id: o.unit_id,
      day_id: o.day_id,
      from_block_order: o.from_block_order != null ? String(o.from_block_order) : null,
      to_block_order: o.to_block_order != null ? String(o.to_block_order) : null,
      label: o.label,
    }))

    setActionError(null)
    try {
      await localClient.bulkReplace(token, 'template_slots', templateId, rows)
      // Restore overlays from snapshot
      await localClient.bulkReplace(token, 'template_overlays', templateId, overlayRows)
    } catch (err) {
      setActionError(
        err?.message?.includes('admin role required')
          ? 'Only an admin can restore a schedule snapshot'
          : 'Failed to restore snapshot — check your connection and try again'
      )
      return
    }

    const freshSlots = normalizeSlots(await localClient.list('template_slots')).filter(s => s.template_id === templateId)
    setSlots(freshSlots)

    const freshOverlays = (await localClient.list('template_overlays')).filter(o => o.template_id === templateId)
    setOverlays(freshOverlays)

    recalcStats(freshSlots)
    setFindings(computeFindings({ slots: freshSlots, groups, activities, days }))
    setDismissedFindingKeys(new Set())
  }

  async function renameSnapshot(snapshotId, newName) {
    setActionError(null)
    try {
      await writeFields('schedule_snapshots', snapshotId, { name: newName, is_auto: false })
    } catch {
      setActionError('Failed to rename snapshot — check your connection and try again')
      return
    }
    setSnapshots(prev => prev.map(s => s.id === snapshotId ? { ...s, name: newName, is_auto: false } : s))
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

    const result = buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, anchorsOnly: true })
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

    const token = localStorage.getItem('shoresh-token')

    const rows = result.slots.map(s => ({
      id: crypto.randomUUID(),
      template_id: tid,
      group_id: s.groupId,
      day_id: s.dayId,
      time_block_id: s.blockId,
      activity_id: s.activityId,
      anchor_id: s.anchorId,
      is_anchor: s.type === 'anchor' ? '1' : '0',
      is_span_head: s.is_span_head !== false ? '1' : '0',
      flags: JSON.stringify(s.flags || {}),
    }))

    setActionError(null)
    try {
      await localClient.bulkReplace(token, 'template_overlays', tid, [])
      await localClient.bulkReplace(token, 'template_slots', tid, rows)
    } catch (err) {
      setActionError(
        err?.message?.includes('admin role required')
          ? 'Only an admin can place anchors'
          : 'Failed to place anchors — check your connection and try again'
      )
      setGenerating(false)
      return
    }
    setManualOverlays([])

    const freshSlots = normalizeSlots(await localClient.list('template_slots')).filter(s => s.template_id === tid)
    setManualSlots(freshSlots)
    setManualStats(statsFor(freshSlots))
    // Findings are shown the moment the blank week opens — every activity still
    // under its weekly target, as an honest list of what the week owes you.
    setManualFindings(computeFindings({ slots: freshSlots, groups, activities, days }))
    setManualDismissed(new Set())
    if (groups.length > 0) setSelectedGroup(prev => prev ?? groups[0].id)
    setGenerating(false)
  }

  async function placeActivityManual(activityId, groupId, dayId, blockId) {
    if (!existingTemplates[route]) return
    const slot = getSlot(groupId, dayId, blockId)
    if (!slot || slot.is_anchor) return

    const activity = activities.find(a => a.id === activityId)
    if (!activity) return

    const group = groups.find(g => g.id === groupId)
    const tierIds = activity.eligible_tier_ids || []
    const groupIds = activity.eligible_group_ids || []
    const eligible = (tierIds.length === 0 && groupIds.length === 0)
      || tierIds.includes(group?.tier_id)
      || groupIds.includes(groupId)

    const coScheduled = slots.filter(s => s.day_id === dayId && s.time_block_id === blockId && s.activity_id === activityId).length
    const locationFull = activity.max_groups_per_slot != null && coScheduled >= activity.max_groups_per_slot

    // Weekly-max enforcement is ActivityPalette disabling the drag source —
    // it's not a per-slot flag kind anymore (UNDERSERVED moved to
    // buildSchedule()'s aggregate findings).
    //
    // On the MANUAL route the placement is always accepted: a director building
    // their own week is never blocked and never has a placement silently
    // corrected. An over-booking is surfaced instead, as a derived OVERLAP
    // marker computed from the week on screen (src/utils/computeOverlaps.js),
    // and there is no UNFILLABLE here at all — an empty cell is simply not
    // filled yet. On the generated route the existing behaviour is unchanged.
    const flags = {}
    if (route !== 'manual' && (!eligible || locationFull)) flags.UNFILLABLE = true

    const prevActivityId = slot.activity_id ?? null
    const prevFlags = slot.flags ?? {}

    setActionError(null)
    try {
      await writeFields('template_slots', slot.id, { activity_id: activityId, flags })
    } catch {
      setActionError('Failed to place activity — check your connection and try again')
      return
    }

    setSlots(prev => prev.map(s =>
      s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
        ? { ...s, activity_id: activityId, flags }
        : s
    ))

    const day = days.find(d => d.id === dayId)
    const block = timeBlocks.find(b => b.id === blockId)
    pushUndo({
      description: `Placed ${activity.name} → ${group?.name ?? groupId} ${day?.label ?? dayId} ${block?.name ?? blockId}`,
      undo: async () => {
        await writeFields('template_slots', slot.id, { activity_id: prevActivityId, flags: prevFlags })
        setSlots(prev => prev.map(s =>
          s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
            ? { ...s, activity_id: prevActivityId, flags: prevFlags }
            : s
        ))
      },
      redo: async () => {
        await writeFields('template_slots', slot.id, { activity_id: activityId, flags })
        setSlots(prev => prev.map(s =>
          s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
            ? { ...s, activity_id: activityId, flags }
            : s
        ))
      },
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

      const tailSlot = getSlot(groupId, dayId, tailBlockId)
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
      const targetSlot = getSlot(groupId, dayId, blockId)
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

      const tailSlot = getSlot(groupId, dayId, tailBlockId)
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
      const targetSlot = getSlot(groupId, dayId, blockId)
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

  async function expandSlot(groupId, dayId, headBlockId, tailBlockId, tailActivityId, tailActivityName, tailBlockName, dayLabel) {
    if (!existingTemplates[route]) return
    const headSlot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
    const tailSlot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
    if (!headSlot || !tailSlot) return

    const headActivityId = headSlot.activity_id
    const existingFlags = headSlot.flags || {}
    const newFlags = {
      ...existingFlags,
      expanded: {
        displacedActivityId: tailActivityId,
        displacedActivityName: tailActivityName,
        from_block: tailBlockId,
      },
    }

    setActionError(null)
    try {
      // Update tail slot: now owned by head activity, marked as tail (is_span_head = false)
      await writeFields('template_slots', tailSlot.id, { activity_id: headActivityId, is_span_head: false })

      // Write flag to head slot
      await writeFields('template_slots', headSlot.id, { flags: newFlags })
    } catch {
      setActionError('Failed to expand slot — check your connection and try again')
      return
    }

    // Update local state
    setSlots(prev => prev.map(s => {
      if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId) {
        return { ...s, activity_id: headActivityId, is_span_head: false }
      }
      if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId) {
        return { ...s, flags: newFlags }
      }
      return s
    }))

    // Add displaced activity to palette
    if (tailActivityId) {
      setDisplacedItems(prev => [
        ...prev,
        {
          activityId: tailActivityId,
          activityName: tailActivityName,
          fromBlockName: tailBlockName,
          dayLabel,
        },
      ])
    }

    const prevHeadFlags = headSlot.flags ?? {}
    const prevTailActivityId = tailSlot.activity_id ?? null
    pushUndo({
      description: `Merged ${headActivityId ? actMap.get(headActivityId)?.name ?? 'slot' : 'slot'} down → ${tailBlockName} ${dayLabel}`,
      undo: async () => {
        await writeFields('template_slots', tailSlot.id, { activity_id: prevTailActivityId, is_span_head: true })
        await writeFields('template_slots', headSlot.id, { flags: prevHeadFlags })
        setSlots(prev => prev.map(s => {
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
            return { ...s, activity_id: prevTailActivityId, is_span_head: true }
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
            return { ...s, flags: prevHeadFlags }
          return s
        }))
        if (tailActivityId) setDisplacedItems(prev => prev.filter(i => !(i.activityId === tailActivityId && i.fromBlockName === tailBlockName)))
      },
      redo: async () => {
        await writeFields('template_slots', tailSlot.id, { activity_id: headActivityId, is_span_head: false })
        await writeFields('template_slots', headSlot.id, { flags: newFlags })
        setSlots(prev => prev.map(s => {
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
            return { ...s, activity_id: headActivityId, is_span_head: false }
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
            return { ...s, flags: newFlags }
          return s
        }))
        if (tailActivityId) {
          setDisplacedItems(prev => [...prev, { activityId: tailActivityId, activityName: tailActivityName, fromBlockName: tailBlockName, dayLabel }])
        }
      },
    })
  }

  function dismissDisplaced(activityId, fromBlockName) {
    setDisplacedItems(prev => prev.filter(
      item => !(item.activityId === activityId && item.fromBlockName === fromBlockName)
    ))
  }

  // T5 — undo/redo helpers
  function pushUndo(entry) {
    setUndoStack(prev => {
      const next = [...prev, entry]
      return next.length > 50 ? next.slice(next.length - 50) : next
    })
    setRedoStack([])
  }

  async function handleUndo() {
    if (undoStack.length === 0) return
    const entry = undoStack[undoStack.length - 1]
    try {
      await entry.undo()
      setUndoStack(prev => prev.slice(0, -1))
      setRedoStack(prev => [...prev, entry])
    } catch {
      setActionError('Undo failed — check your connection and try again')
    }
  }

  async function handleRedo() {
    if (redoStack.length === 0) return
    const entry = redoStack[redoStack.length - 1]
    try {
      await entry.redo()
      setRedoStack(prev => prev.slice(0, -1))
      setUndoStack(prev => [...prev, entry])
    } catch {
      setActionError('Redo failed — check your connection and try again')
    }
  }

  // T4 — split a merged span back into two independent slots
  async function splitSlot(groupId, dayId, headBlockId) {
    if (!existingTemplates[route]) return
    const headSlot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
    if (!headSlot || !headSlot.flags?.expanded) return

    const { displacedActivityId, displacedActivityName, from_block: tailBlockId } = headSlot.flags.expanded
    const tailSlot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
    if (!tailSlot) return

    const cleanedFlags = { ...headSlot.flags }
    delete cleanedFlags.expanded

    setActionError(null)
    try {
      await writeFields('template_slots', tailSlot.id, { activity_id: null, is_span_head: true, flags: {} })
      await writeFields('template_slots', headSlot.id, { flags: cleanedFlags })
    } catch {
      setActionError('Failed to split slot — check your connection and try again')
      return
    }

    setSlots(prev => prev.map(s => {
      if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
        return { ...s, activity_id: null, is_span_head: true, flags: {} }
      if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
        return { ...s, flags: cleanedFlags }
      return s
    }))

    const prevHeadFlags = headSlot.flags
    const prevTailActivityId = tailSlot.activity_id ?? null
    const prevTailIsSpanHead = tailSlot.is_span_head

    if (displacedActivityId && displacedActivityName) {
      const tailBlock = timeBlocks.find(b => b.id === tailBlockId)
      const day = days.find(d => d.id === dayId)
      setDisplacedItems(prev => [
        ...prev,
        {
          activityId: displacedActivityId,
          activityName: displacedActivityName,
          fromBlockName: tailBlock?.name ?? '',
          dayLabel: day?.label ?? '',
        },
      ])
    }

    pushUndo({
      description: `Split merged slot ${headBlockId}`,
      undo: async () => {
        await writeFields('template_slots', tailSlot.id, { activity_id: prevTailActivityId, is_span_head: prevTailIsSpanHead ?? false, flags: tailSlot.flags ?? {} })
        await writeFields('template_slots', headSlot.id, { flags: prevHeadFlags })
        setSlots(prev => prev.map(s => {
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
            return { ...s, activity_id: prevTailActivityId, is_span_head: prevTailIsSpanHead ?? false }
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
            return { ...s, flags: prevHeadFlags }
          return s
        }))
        if (displacedActivityId) {
          const tailBlock = timeBlocks.find(b => b.id === tailBlockId)
          setDisplacedItems(prev => prev.filter(i => !(i.activityId === displacedActivityId && i.fromBlockName === (tailBlock?.name ?? ''))))
        }
      },
      redo: async () => {
        await writeFields('template_slots', tailSlot.id, { activity_id: null, is_span_head: true, flags: {} })
        await writeFields('template_slots', headSlot.id, { flags: cleanedFlags })
        setSlots(prev => prev.map(s => {
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
            return { ...s, activity_id: null, is_span_head: true, flags: {} }
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
            return { ...s, flags: cleanedFlags }
          return s
        }))
      },
    })
  }

  // T3 — cell selection (single and multi) and paste mode
  function handleSelectGroup(groupId) {
    setSelectedGroup(groupId)
    setSelectedSlotKeys(new Set())
  }

  function handleCellSelect(slot, e) {
    if (pasteMode) {
      handlePasteClick(slot)
      return
    }
    const key = `${slot.groupId}|${slot.dayId}|${slot.blockId}`
    if (e?.ctrlKey || e?.metaKey) {
      setSelectedSlotKeys(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    } else {
      setSelectedSlotKeys(new Set([key]))
    }
  }

  async function handlePasteClick(slot) {
    if (slot.is_anchor || slot.is_span_head === false) {
      setPasteError('Cannot paste onto an anchor or merged tail')
      setTimeout(() => setPasteError(null), 2000)
      return
    }
    const item = clipboardItems[pasteModeIndex]
    if (!item) return
    await placeActivityManual(item.activityId, slot.groupId, slot.dayId, slot.blockId)
    const nextIndex = pasteModeIndex + 1
    if (nextIndex >= clipboardItems.length) {
      setPasteMode(false)
      setClipboardItems([])
      setPasteModeIndex(0)
    } else {
      setPasteModeIndex(nextIndex)
    }
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
      reason: s.flags?.UNFILLABLE_reason || 'No eligible activity could be placed in this slot',
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

  // Build lookup maps for rendering. colorIdx carries the activity's stable
  // id (not array position) so activityColor() can derive a djb2-stable hue
  // that survives reordering/additions — see slotCellConstants.js.
  const actMap = new Map(activities.map(a => [a.id, { ...a, colorIdx: a.id }]))
  const anchorMap = new Map(anchors.map(a => [a.id, a]))

  function getSlot(groupId, dayId, blockId) {
    return slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId)
  }

  // Returns true if this slot is a tail block of a multi-block anchor
  // (i.e., the previous block for this group+day has the same anchor_id)
  function isAnchorTail(groupId, dayId, blockId) {
    const slot = getSlot(groupId, dayId, blockId)
    if (!slot?.is_anchor || !slot?.anchor_id) return false
    const blockIdx = timeBlocks.findIndex(b => b.id === blockId)
    if (blockIdx <= 0) return false
    const prevSlot = getSlot(groupId, dayId, timeBlocks[blockIdx - 1].id)
    return Boolean(prevSlot?.is_anchor && prevSlot?.anchor_id === slot.anchor_id)
  }

  // Returns how many consecutive blocks share the same anchor_id starting at blockId
  function getAnchorRowSpan(groupId, dayId, blockId) {
    const slot = getSlot(groupId, dayId, blockId)
    if (!slot?.is_anchor || !slot?.anchor_id) return 1
    const startIdx = timeBlocks.findIndex(b => b.id === blockId)
    if (startIdx === -1) return 1
    let span = 1
    for (let i = startIdx + 1; i < timeBlocks.length; i++) {
      const nextSlot = getSlot(groupId, dayId, timeBlocks[i].id)
      if (nextSlot?.is_anchor && nextSlot?.anchor_id === slot.anchor_id) {
        span++
      } else {
        break
      }
    }
    return span
  }

  function isActivityTail(groupId, dayId, blockId) {
    const slot = getSlot(groupId, dayId, blockId)
    if (slot?.is_anchor || !slot?.activity_id) return false
    return slot.is_span_head === false
  }

  function getActivityRowSpan(groupId, dayId, blockId) {
    const slot = getSlot(groupId, dayId, blockId)
    if (!slot?.activity_id || slot.is_anchor) return 1
    const startIdx = timeBlocks.findIndex(b => b.id === blockId)
    if (startIdx === -1) return 1
    let span = 1
    for (let i = startIdx + 1; i < timeBlocks.length; i++) {
      const nextSlot = getSlot(groupId, dayId, timeBlocks[i].id)
      if (nextSlot?.activity_id === slot.activity_id && nextSlot.is_span_head === false) {
        span++
      } else {
        break
      }
    }
    return span
  }

  // Returns the overlay object if an overlay covers this (group, day, block), else null
  function overlayForCell(groupId, dayId, blockId) {
    const group = groups.find(g => g.id === groupId)
    const block = timeBlocks.find(b => b.id === blockId)
    if (!group || !block) return null
    return overlays.find(o => {
      const effectiveTo = (fillState?.overlayId === o.id && fillState.previewToOrder !== undefined)
        ? fillState.previewToOrder
        : o.to_block_order
      return (
        o.unit_id === group.tier_id &&
        o.day_id === dayId &&
        block.sort_order >= o.from_block_order &&
        block.sort_order <= effectiveTo
      )
    }) || null
  }

  // Returns true if this block is the FIRST block of an overlay (render the OverlayCell here)
  function isOverlayHead(groupId, dayId, blockId) {
    const group = groups.find(g => g.id === groupId)
    const block = timeBlocks.find(b => b.id === blockId)
    if (!group || !block) return false
    const overlay = overlayForCell(groupId, dayId, blockId)
    if (!overlay) return false
    return block.sort_order === overlay.from_block_order
  }

  // Returns the rowSpan for an overlay starting at this block (uses live preview during fill drag)
  function getOverlayRowSpan(overlay) {
    const effectiveTo = (fillState?.overlayId === overlay.id && fillState.previewToOrder !== undefined)
      ? fillState.previewToOrder
      : overlay.to_block_order
    return timeBlocks.filter(b => b.sort_order >= overlay.from_block_order && b.sort_order <= effectiveTo).length
  }

  async function handleStampClick(groupId, dayId, blockId) {
    if (!stampMode) return
    const group = groups.find(g => g.id === groupId)
    const block = timeBlocks.find(b => b.id === blockId)
    if (!group || !block) return
    await addOverlay({
      unitId: group.tier_id,
      dayId,
      fromBlockOrder: block.sort_order,
      toBlockOrder: block.sort_order,
      label: stampMode,
    })
  }

  function startFill(overlay) {
    setFillState({ overlayId: overlay.id, previewToOrder: overlay.to_block_order })
  }

  function handleFillEnter(blockSortOrder) {
    if (!fillState) return
    const overlay = overlays.find(o => o.id === fillState.overlayId)
    if (!overlay) return
    if (blockSortOrder >= overlay.from_block_order) {
      setFillState(prev => ({ ...prev, previewToOrder: blockSortOrder }))
    }
  }

  const setupIncomplete = groups.length === 0 || days.length === 0 || timeBlocks.length === 0 || activities.length === 0

  if (loading) return <div style={S.stateLoading}>Loading…</div>

  if (setupIncomplete) {
    return (
      <div style={{ maxWidth: 480 }}>
        <div style={{ background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))', border: '1px solid var(--accent)', borderRadius: 12, padding: '20px 24px', fontSize: 13 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 16, marginBottom: 8, color: 'color-mix(in srgb, var(--accent) 60%, var(--text))' }}>Setup incomplete</div>
          Setup the following before generating a schedule:
          <ul style={{ marginTop: 8, paddingLeft: 18, lineHeight: 2 }}>
            {groups.length === 0 && <li>Groups</li>}
            {days.length === 0 && <li>Days</li>}
            {timeBlocks.length === 0 && <li>Time Blocks</li>}
            {activities.length === 0 && <li>Activities</li>}
          </ul>
          <button onClick={() => onNavigate('setup')} style={{ ...S.btnPrimary, marginTop: 12 }}>Go to Camp Setup</button>
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

  // The neutral 'schedule' entry (CampSetup / AnchorsScreen "Next: Schedule")
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
              snapshots={snapshots}
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
              >Regenerate from Scratch</button>
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
            onClick={() => { setPasteMode(false); setClipboardItems([]); setPasteModeIndex(0) }}
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
                isAnchorTail={isAnchorTail}
                getAnchorRowSpan={getAnchorRowSpan}
                getSlot={getSlot}
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
                overlayForCell={overlayForCell}
                isOverlayHead={isOverlayHead}
                getOverlayRowSpan={getOverlayRowSpan}
                isAnchorTail={isAnchorTail}
                getAnchorRowSpan={getAnchorRowSpan}
                isActivityTail={isActivityTail}
                getActivityRowSpan={getActivityRowSpan}
                handleFillEnter={handleFillEnter}
                startFill={startFill}
                removeOverlay={removeOverlay}
                handleStampClick={handleStampClick}
                onEditSlot={setEditSlot}
                fillState={fillState}
                getSlot={getSlot}
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
                overlayForCell={overlayForCell}
                isOverlayHead={isOverlayHead}
                getOverlayRowSpan={getOverlayRowSpan}
                isAnchorTail={isAnchorTail}
                getAnchorRowSpan={getAnchorRowSpan}
                isActivityTail={isActivityTail}
                getActivityRowSpan={getActivityRowSpan}
                handleFillEnter={handleFillEnter}
                startFill={startFill}
                removeOverlay={removeOverlay}
                handleStampClick={handleStampClick}
                onEditSlot={setEditSlot}
                fillState={fillState}
                getSlot={getSlot}
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

