import { useState, useEffect } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { localClient } from '../localClient'
import buildSchedule from '../engine/buildSchedule'
import { S } from '../styles/shared'
import StatBadge from '../components/schedule/StatBadge'
import { FLAG_COLORS } from '../components/schedule/SlotCell'
import FlagDetailModal from '../components/schedule/FlagDetailModal'
import EditModal from '../components/schedule/EditModal'
import ConfirmRegenModal from '../components/schedule/ConfirmRegenModal'
import VersionsDropdown from '../components/schedule/VersionsDropdown'
import FieldTripDrawer from '../components/schedule/FieldTripDrawer'
import { exportToExcel } from '../utils/exportSchedule'
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

// template_slots rows written via bulk_replace carry `flags` as a
// JSON.stringify'd string (validateBulkReplaceRows in electron/ops/operations.js
// only accepts string/null row values, so an object can't be written directly).
// localClient.list('template_slots') returns the raw stored string — parse it
// back to an object here, at the single read boundary, so every consumer in
// this file (s.flags?.UNFILLABLE, {...(slot.flags||{})}, etc.) can keep
// treating `flags` as a plain object regardless of which write path last
// touched the row.
function normalizeSlots(rows) {
  return (rows || []).map(row => {
    if (typeof row.flags !== 'string') return { ...row, flags: row.flags || {} }
    try {
      return { ...row, flags: row.flags ? JSON.parse(row.flags) : {} }
    } catch {
      return { ...row, flags: {} }
    }
  })
}

export default function ScheduleScreen({ campId, role, onNavigate }) {
  const [groups, setGroups] = useState([])
  const [days, setDays] = useState([])
  const [timeBlocks, setTimeBlocks] = useState([])
  const [activities, setActivities] = useState([])
  const [anchors, setAnchors] = useState([])
  const [tiers, setTiers] = useState([])
  const [templateId, setTemplateId] = useState(null)
  const [slots, setSlots] = useState([]) // saved template_slots from DB
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [view, setView] = useState('group') // 'group' | 'activity' | 'day'
  const [selectedGroup, setSelectedGroup] = useState(null)
  const [selectedDay, setSelectedDay] = useState(null)
  const [weatherMode, setWeatherMode] = useState(false)
  const [editSlot, setEditSlot] = useState(null)
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [activeFlag, setActiveFlag] = useState(null)
  const [selectedActivity, setSelectedActivity] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [templateError, setTemplateError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [snapshots, setSnapshots] = useState([])
  const [overlays, setOverlays] = useState([])
  const [showVersions, setShowVersions] = useState(false)
  const [stampMode, setStampMode] = useState(null) // null | string (label of active stamp)
  const [showFieldTripDrawer, setShowFieldTripDrawer] = useState(false)
  const [fillState, setFillState] = useState(null)  // null | { overlayId, previewToOrder }
  const [_manualMode, setManualMode] = useState(false)
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
          const actIdx = activities.findIndex(a => a.id === s.activity_id)
          const act = activities.find(a => a.id === s.activity_id)
          items.push({ activityId: s.activity_id, activityName: act?.name || '', colorIdx: actIdx >= 0 ? actIdx : 0 })
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
  }, [fillState, overlays])

  async function loadAll() {
    setLoading(true)
    setLoadError(null)
    setTemplateError(null)
    try {
      const [gd, td, bd, ad, ancd, tierd] = await Promise.all([
        localClient.list('groups'),
        localClient.list('days_of_operation'),
        localClient.list('time_blocks'),
        localClient.list('activities'),
        localClient.list('anchor_activities'),
        localClient.list('tiers'),
      ])
      const g = [...(gd || [])].filter(x => x.camp_id === campId).sort((x, y) => x.name.localeCompare(y.name))
      const b = [...(bd || [])].filter(x => x.camp_id === campId).sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      const a = (ad || []).filter(x => x.camp_id === campId)
      const anc = (ancd || []).filter(x => x.camp_id === campId)
      const t = [...(tierd || [])].filter(x => x.camp_id === campId).sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      const sortedTd = [...(td || [])].filter(x => x.camp_id === campId).sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      const d = sortedTd.filter((x, i, arr) => arr.findIndex(y => y.day_of_week === x.day_of_week) === i)
      const tierOrderMap = new Map(t.map(tier => [tier.id, tier.sort_order ?? 0]))
      const sortedG = [...g].sort((x, y) => {
        const ox = tierOrderMap.get(x.tier_id) ?? 999
        const oy = tierOrderMap.get(y.tier_id) ?? 999
        return ox !== oy ? ox - oy : x.name.localeCompare(y.name)
      })
      setGroups(sortedG); setDays(d); setTimeBlocks(b); setActivities(a); setAnchors(anc); setTiers(t)
      if (sortedG.length > 0) setSelectedGroup(sortedG[0].id)
      if (d.length > 0) setSelectedDay(d[0].id)
    } catch {
      setLoadError('Failed to load schedule data — check your connection and refresh')
      setLoading(false)
      return
    }
    try {
      const templates = await localClient.list('schedule_templates')
      const tmpl = (templates || []).find(x => x.camp_id === campId)
      if (tmpl) {
        setTemplateId(tmpl.id)
        const [slotData, overlayData, snapData] = await Promise.all([
          localClient.list('template_slots'),
          localClient.list('template_overlays'),
          localClient.list('schedule_snapshots'),
        ])
        const saved = normalizeSlots(slotData).filter(s => s.template_id === tmpl.id)
        setSlots(saved)
        setOverlays((overlayData || []).filter(o => o.template_id === tmpl.id))
        recalcStats(saved)
        const snaps = (snapData || [])
          .filter(s => s.template_id === tmpl.id)
          .sort((x, y) => new Date(y.created_at) - new Date(x.created_at))
          .map(({ id, template_id, name, is_auto, created_at }) => ({ id, template_id, name, is_auto, created_at }))
        setSnapshots(snaps)
      }
    } catch {
      setTemplateError('Failed to load saved schedule — check your connection and refresh')
    }
    setLoading(false)
  }

  function recalcStats(slotList) {
    const open = slotList.filter(s => s.is_anchor === false).length
    const filled = slotList.filter(s => s.is_anchor === false && s.activity_id).length
    setStats({ open, filled })
  }

  async function generate() {
    setGenerating(true)
    setUndoStack([])
    setRedoStack([])

    const lockedActIds = new Set(activities.filter(a => a.is_locked).map(a => a.id))
    const preplacedSlots = slots
      .filter(s => s.activity_id && lockedActIds.has(s.activity_id) && !s.is_released && !s.is_anchor)
      .map(s => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, activityId: s.activity_id }))

    const result = buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots })

    // Upsert template
    let tid = templateId
    if (!tid) {
      tid = crypto.randomUUID()
      await writeFields('schedule_templates', tid, { camp_id: campId, name: 'Master Template' })
      setTemplateId(tid)
    }

    if (slots.length > 0) {
      try {
        await saveSnapshot(null, true)
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
    setOverlays([])

    const freshSlots = normalizeSlots(await localClient.list('template_slots')).filter(s => s.template_id === tid)
    setSlots(freshSlots)
    recalcStats(freshSlots)
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
    if (!templateId) return
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
    if (!templateId) return
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

  async function saveSnapshot(name, isAuto) {
    if (!templateId) return
    const snapSlots = slots.map(s => ({
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
    const snapOverlays = overlays.map(o => ({ unit_id: o.unit_id, day_id: o.day_id, from_block_order: o.from_block_order, to_block_order: o.to_block_order, label: o.label }))
    setActionError(null)
    try {
      await writeFields('schedule_snapshots', id, {
        template_id: templateId,
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
    setSnapshots(prev => [{ id, template_id: templateId, name: name || null, is_auto: isAuto, created_at: createdAt }, ...prev])
  }

  async function restoreSnapshot(snapshot) {
    if (!templateId) return
    setUndoStack([])
    setRedoStack([])
    const fullSnap = (await localClient.list('schedule_snapshots')).find(s => s.id === snapshot.id)
    if (!fullSnap?.slots) return
    let parsedSlots, parsedOverlays
    try {
      parsedSlots = JSON.parse(fullSnap.slots)
      parsedOverlays = fullSnap.overlays ? JSON.parse(fullSnap.overlays) : []
    } catch {
      setActionError('This snapshot appears to be corrupted and cannot be restored')
      return
    }
    fullSnap.slots = parsedSlots
    fullSnap.overlays = parsedOverlays

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
    setManualMode(false)
    await generate()
  }

  async function placeAnchors() {
    setGenerating(true)
    const result = buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, anchorsOnly: true })

    let tid = templateId
    if (!tid) {
      tid = crypto.randomUUID()
      await writeFields('schedule_templates', tid, { camp_id: campId, name: 'Master Template' })
      setTemplateId(tid)
    }

    if (slots.length > 0) {
      try {
        await saveSnapshot(null, true)
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
    setOverlays([])

    const freshSlots = normalizeSlots(await localClient.list('template_slots')).filter(s => s.template_id === tid)
    setSlots(freshSlots)
    recalcStats(freshSlots)
    setManualMode(true)
    setView('manual')
    if (groups.length > 0) setSelectedGroup(groups[0].id)
    setGenerating(false)
  }

  async function placeActivityManual(activityId, groupId, dayId, blockId) {
    if (!templateId) return
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

    const weekCount = slots.filter(s => s.group_id === groupId && s.activity_id === activityId).length
    const atMax = activity.max_per_week != null && weekCount >= activity.max_per_week

    const coScheduled = slots.filter(s => s.day_id === dayId && s.time_block_id === blockId && s.activity_id === activityId).length
    const locationFull = activity.max_groups_per_slot != null && coScheduled >= activity.max_groups_per_slot

    const flags = {}
    if (!eligible || locationFull) flags.UNFILLABLE = true
    if (atMax) flags.UNDERSERVED = true

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


  function handleManualDragEnd({ active, over }) {
    if (!over) return
    const paletteAct = active.data.current?.paletteActivity
    if (!paletteAct) return
    const d = over.data.current || {}
    const groupId = d.groupId ?? d.slot?.groupId
    const dayId = d.dayId ?? d.slot?.dayId
    const blockId = d.blockId ?? d.slot?.blockId
    if (!groupId || !dayId || !blockId) return
    placeActivityManual(paletteAct.id, groupId, dayId, blockId)
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
    if (!templateId) return
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
    const colorIdx = activities.findIndex(a => a.id === tailActivityId)
    if (tailActivityId) {
      setDisplacedItems(prev => [
        ...prev,
        {
          activityId: tailActivityId,
          activityName: tailActivityName,
          fromBlockName: tailBlockName,
          dayLabel,
          colorIdx: colorIdx >= 0 ? colorIdx : 0,
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
          setDisplacedItems(prev => [...prev, { activityId: tailActivityId, activityName: tailActivityName, fromBlockName: tailBlockName, dayLabel, colorIdx: colorIdx >= 0 ? colorIdx : 0 }])
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
    if (!templateId) return
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
      const colorIdx = activities.findIndex(a => a.id === displacedActivityId)
      const tailBlock = timeBlocks.find(b => b.id === tailBlockId)
      const day = days.find(d => d.id === dayId)
      setDisplacedItems(prev => [
        ...prev,
        {
          activityId: displacedActivityId,
          activityName: displacedActivityName,
          fromBlockName: tailBlock?.name ?? '',
          dayLabel: day?.label ?? '',
          colorIdx: colorIdx >= 0 ? colorIdx : 0,
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

  // Slots scoped to the active context — group view filters to selected group, all other views show camp-wide
  const visibleSlots = view === 'group' && selectedGroup
    ? slots.filter(s => s.group_id === selectedGroup)
    : slots

  // Always count flags camp-wide so badges don't change value when switching views
  const flagSlots = slots

  // Build lookup maps for rendering
  const actMap = new Map(activities.map((a, i) => [a.id, { ...a, colorIdx: i }]))
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

  if (loading) return <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-secondary)' }}>Loading…</div>

  if (setupIncomplete) {
    return (
      <div style={{ maxWidth: 480 }}>
        <div style={{ background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))', border: '1px solid var(--accent)', borderRadius: 12, padding: '20px 24px', fontSize: 13 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 16, marginBottom: 8, color: 'color-mix(in srgb, var(--accent) 60%, var(--text))' }}>Setup incomplete</div>
          Setup the following before generating a schedule:
          <ul style={{ marginTop: 8, paddingLeft: 18, lineHeight: 2 }}>
            {groups.length === 0 && <li>Groups</li>}
            {days.length === 0 && <li>Days of Operation</li>}
            {timeBlocks.length === 0 && <li>Time Blocks</li>}
            {activities.length === 0 && <li>Activities</li>}
          </ul>
          <button onClick={() => onNavigate('setup')} style={{ ...S.btnPrimary, marginTop: 12 }}>Go to Camp Setup</button>
        </div>
      </div>
    )
  }

  const hasSchedule = slots.length > 0

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
        {hasSchedule && (
          <>
            {/* View toggle */}
            <div style={{ display: 'flex', gap: 2, background: 'var(--border)', borderRadius: 8, padding: 3 }}>
              {[
                ...(hasSchedule ? [['manual', 'Manual Build']] : []),
                ['group','Group View'],['day','Daily View'],['activity','Activity View'],
              ].map(([v, label]) => (
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

            <button onClick={() => exportToExcel({ slots, activities, anchors, groups, days, timeBlocks })} style={S.btnSecondary}>Export to Excel</button>
            <button
              onClick={() => setConfirmRegen(true)}
              disabled={role !== 'admin'}
              title={role !== 'admin' ? 'Admin only' : undefined}
              style={role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
            >Regenerate from Scratch</button>
          </>
        )}

        {!hasSchedule && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={generate}
              disabled={generating || role !== 'admin'}
              title={role !== 'admin' ? 'Admin only' : undefined}
              style={role !== 'admin' ? { ...S.btnPrimary, padding: '10px 24px', fontSize: 14, ...S.buttonDisabled } : { ...S.btnPrimary, padding: '10px 24px', fontSize: 14 }}
            >
              {generating ? 'Generating…' : 'Generate Schedule'}
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>or</span>
            <button
              onClick={placeAnchors}
              disabled={generating || role !== 'admin'}
              title={role !== 'admin' ? 'Admin only' : undefined}
              style={role !== 'admin' ? { ...S.btnSecondary, padding: '10px 24px', fontSize: 14, ...S.buttonDisabled } : { ...S.btnSecondary, padding: '10px 24px', fontSize: 14 }}
            >
              Build Manually
            </button>
          </div>
        )}

        {hasSchedule && generating && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>Generating…</span>}
      </div>

      {/* Stats bar */}
      {hasSchedule && stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          <StatBadge label="Filled" value={`${stats.filled}/${stats.open}`} color="var(--success)" />
          <StatBadge label="Unfillable" value={flagSlots.filter(s => s.flags?.UNFILLABLE && !s.flags?.UNFILLABLE_dismissed).length} color={flagSlots.some(s => s.flags?.UNFILLABLE && !s.flags?.UNFILLABLE_dismissed) ? 'var(--danger)' : 'var(--text-secondary)'} onClick={() => setActiveFlag('UNFILLABLE')} />
          <StatBadge label="Underserved" value={flagSlots.filter(s => s.flags?.UNDERSERVED && !s.flags?.UNDERSERVED_dismissed).length} color={flagSlots.some(s => s.flags?.UNDERSERVED && !s.flags?.UNDERSERVED_dismissed) ? 'var(--primary)' : 'var(--text-secondary)'} onClick={() => setActiveFlag('UNDERSERVED')} />
          <StatBadge label="Weather Risk" value={flagSlots.filter(s => s.flags?.WEATHER_RISK && !s.flags?.WEATHER_RISK_dismissed).length} color="var(--accent)" onClick={() => setActiveFlag('WEATHER_RISK')} />
          <StatBadge label="Distribution" value={flagSlots.filter(s => s.flags?.DISTRIBUTION && !s.flags?.DISTRIBUTION_dismissed).length} color="var(--secondary)" onClick={() => setActiveFlag('DISTRIBUTION')} />
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
            draggable={view === 'manual' || view === 'group' || view === 'day'}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(c => !c)}
          />
        )

        const gridContent = (
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* No schedule state */}
            {!hasSchedule && !generating && (
              <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--text-secondary)', fontSize: 13 }}>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 20, color: 'var(--text)', marginBottom: 8 }}>No schedule yet</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Click "Generate Schedule" to build one from your current setup.</div>
              </div>
            )}

            {/* Group view */}
            {hasSchedule && view === 'group' && (
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

            {/* Manual build view — grid only; DndContext wraps sidebar+grid below */}
            {hasSchedule && view === 'manual' && (
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
        if (view === 'manual') {
          return (
            <DndContext
              key="manual"
              sensors={sensors}
              onDragStart={() => {}}
              onDragEnd={handleManualDragEnd}
              onDragCancel={() => {}}
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

      {/* Flag detail modal */}
      {activeFlag && (
        <FlagDetailModal
          flag={activeFlag}
          slots={visibleSlots}
          groups={groups}
          days={days}
          timeBlocks={timeBlocks}
          activities={activities}
          onDismiss={dismissFlag}
          onClose={() => setActiveFlag(null)}
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

      {/* Flag legend */}
      {hasSchedule && (
        <div style={{ display: 'flex', gap: 16, marginTop: 16, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-secondary)' }}>
          {Object.entries(FLAG_COLORS).map(([f, c]) => (
            <span key={f} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, display: 'inline-block' }} />{f}
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

