import { useState, useEffect } from 'react'
import { PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { supabase } from '../supabase'
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


export default function ScheduleScreen({ campId, onNavigate }) {
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
  const [snapshots, setSnapshots] = useState([])
  const [overlays, setOverlays] = useState([])
  const [showVersions, setShowVersions] = useState(false)
  const [stampMode, setStampMode] = useState(null) // null | string (label of active stamp)
  const [showFieldTripDrawer, setShowFieldTripDrawer] = useState(false)
  const [fillState, setFillState] = useState(null)  // null | { overlayId, previewToOrder }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  useEffect(() => { loadAll() }, [campId])

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
    let loadedActivities = []
    try {
      const [{ data: gd }, { data: td }, { data: bd }, { data: ad }, { data: ancd }, { data: tierd }] = await Promise.all([
        supabase.from('groups').select('*').eq('camp_id', campId).order('name'),
        supabase.from('days_of_operation').select('*').eq('camp_id', campId).order('sort_order'),
        supabase.from('time_blocks').select('*').eq('camp_id', campId).order('sort_order'),
        supabase.from('activities').select('*').eq('camp_id', campId),
        supabase.from('anchor_activities').select('*').eq('camp_id', campId),
        supabase.from('tiers').select('*').eq('camp_id', campId).order('sort_order'),
      ])
      const g = gd || []; const b = bd || []; const a = ad || []; const anc = ancd || []; const t = tierd || []
      const d = (td || []).filter((x, i, arr) => arr.findIndex(y => y.day_of_week === x.day_of_week) === i)
      const tierOrderMap = new Map(t.map(tier => [tier.id, tier.sort_order ?? 0]))
      const sortedG = [...g].sort((x, y) => {
        const ox = tierOrderMap.get(x.tier_id) ?? 999
        const oy = tierOrderMap.get(y.tier_id) ?? 999
        return ox !== oy ? ox - oy : x.name.localeCompare(y.name)
      })
      setGroups(sortedG); setDays(d); setTimeBlocks(b); setActivities(a); setAnchors(anc); setTiers(t)
      if (sortedG.length > 0) setSelectedGroup(sortedG[0].id)
      if (d.length > 0) setSelectedDay(d[0].id)
      loadedActivities = a
    } catch {
      setLoadError('Failed to load schedule data — check your connection and refresh')
      setLoading(false)
      return
    }
    try {
      const { data: tmpl } = await supabase.from('schedule_templates').select('id').eq('camp_id', campId).single()
      if (tmpl) {
        setTemplateId(tmpl.id)
        const { data: slotData } = await supabase.from('template_slots').select('*').eq('template_id', tmpl.id)
        const saved = slotData || []
        setSlots(saved)
        // Load overlays for this template
        const { data: overlayData } = await supabase
          .from('template_overlays')
          .select('*')
          .eq('template_id', tmpl.id)
        setOverlays(overlayData || [])
        recalcStats(saved)
        const { data: snapData } = await supabase
          .from('schedule_snapshots')
          .select('id, template_id, name, is_auto, created_at')
          .eq('template_id', tmpl.id)
          .order('created_at', { ascending: false })
        setSnapshots(snapData || [])
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

    const lockedActIds = new Set(activities.filter(a => a.is_locked).map(a => a.id))
    const preplacedSlots = slots
      .filter(s => s.activity_id && lockedActIds.has(s.activity_id) && !s.is_released && !s.is_anchor)
      .map(s => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, activityId: s.activity_id }))

    const result = buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots })

    // Upsert template
    let tid = templateId
    if (!tid) {
      const { data } = await supabase.from('schedule_templates').insert({ camp_id: campId, name: 'Master Template' }).select('id').single()
      tid = data.id
      setTemplateId(tid)
    }

    if (slots.length > 0) {
      await saveSnapshot(null, true)
    }

    // Delete existing slots
    await supabase.from('template_slots').delete().eq('template_id', tid)

    // Clear overlays when regenerating (post-generation stamps are re-applied manually)
    await supabase.from('template_overlays').delete().eq('template_id', tid)
    setOverlays([])

    // Insert new slots
    const rows = result.slots.map(s => ({
      template_id: tid,
      group_id: s.groupId,
      day_id: s.dayId,
      time_block_id: s.blockId,
      activity_id: s.activityId,
      anchor_id: s.anchorId,
      is_anchor: s.type === 'anchor',
      flags: s.flags || {},
    }))

    // Insert in batches of 500
    for (let i = 0; i < rows.length; i += 500) {
      await supabase.from('template_slots').insert(rows.slice(i, i + 500))
    }

    const { data: freshSlots } = await supabase.from('template_slots').select('*').eq('template_id', tid)
    setSlots(freshSlots || [])
    recalcStats(freshSlots || [])
    setGenerating(false)
  }

  async function editSlotSave(newActivityId) {
    if (!editSlot || !templateId) return
    const { groupId, dayId, blockId } = editSlot
    await supabase.from('template_slots')
      .update({ activity_id: newActivityId || null, flags: {} })
      .eq('template_id', templateId)
      .eq('group_id', groupId)
      .eq('day_id', dayId)
      .eq('time_block_id', blockId)
    setSlots(prev => prev.map(s =>
      s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
        ? { ...s, activity_id: newActivityId || null, flags: {} }
        : s
    ))
    setEditSlot(null)
  }

  async function swapSlots(slotA, slotB) {
    // slotA and slotB are { groupId, dayId, blockId, activityId }
    if (!templateId) return
    await Promise.all([
      supabase.from('template_slots')
        .update({ activity_id: slotB.activityId || null, flags: {} })
        .eq('template_id', templateId)
        .eq('group_id', slotA.groupId)
        .eq('day_id', slotA.dayId)
        .eq('time_block_id', slotA.blockId),
      supabase.from('template_slots')
        .update({ activity_id: slotA.activityId || null, flags: {} })
        .eq('template_id', templateId)
        .eq('group_id', slotB.groupId)
        .eq('day_id', slotB.dayId)
        .eq('time_block_id', slotB.blockId),
    ])
    setSlots(prev => prev.map(s => {
      if (s.group_id === slotA.groupId && s.day_id === slotA.dayId && s.time_block_id === slotA.blockId)
        return { ...s, activity_id: slotB.activityId || null, flags: {} }
      if (s.group_id === slotB.groupId && s.day_id === slotB.dayId && s.time_block_id === slotB.blockId)
        return { ...s, activity_id: slotA.activityId || null, flags: {} }
      return s
    }))
  }

  async function dismissFlag(slotIds, flagName) {
    const updates = slotIds.map(id => {
      const slot = slots.find(s => s.id === id)
      if (!slot) return null
      const newFlags = { ...(slot.flags || {}), [`${flagName}_dismissed`]: true }
      return { id, newFlags }
    }).filter(Boolean)

    await Promise.all(updates.map(({ id, newFlags }) =>
      supabase.from('template_slots').update({ flags: newFlags }).eq('id', id)
    ))

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
    await supabase.from('activities').update({ is_locked: true }).eq('id', activityId)
    setActivities(prev => prev.map(a => a.id === activityId ? { ...a, is_locked: true } : a))
  }

  async function releaseCell(slotId) {
    await supabase.from('template_slots').update({ is_released: true }).eq('id', slotId)
    setSlots(prev => prev.map(s => s.id === slotId ? { ...s, is_released: true } : s))
  }

  async function addOverlay({ unitId, dayId, fromBlockOrder, toBlockOrder, label }) {
    if (!templateId) return
    if (!unitId) {
      console.warn('addOverlay: group has no tier_id — cannot create overlay')
      return
    }
    const { data, error } = await supabase
      .from('template_overlays')
      .insert({ template_id: templateId, unit_id: unitId, day_id: dayId, from_block_order: fromBlockOrder, to_block_order: toBlockOrder, label })
      .select()
      .single()
    if (error) { console.error('addOverlay error:', error); return }
    if (data) setOverlays(prev => [...prev, data])
  }

  async function removeOverlay(overlayId) {
    await supabase.from('template_overlays').delete().eq('id', overlayId)
    setOverlays(prev => prev.filter(o => o.id !== overlayId))
  }

  async function updateOverlayRange(overlayId, toBlockOrder) {
    await supabase.from('template_overlays').update({ to_block_order: toBlockOrder }).eq('id', overlayId)
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
    const { data: snap } = await supabase
      .from('schedule_snapshots')
      .insert({ template_id: templateId, name: name || null, is_auto: isAuto, slots: snapSlots, overlays: overlays.map(o => ({ unit_id: o.unit_id, day_id: o.day_id, from_block_order: o.from_block_order, to_block_order: o.to_block_order, label: o.label })) })
      .select('id, template_id, name, is_auto, created_at')
      .single()
    if (snap) setSnapshots(prev => [snap, ...prev])
  }

  async function restoreSnapshot(snapshot) {
    if (!templateId) return
    const { data: fullSnap } = await supabase
      .from('schedule_snapshots')
      .select('slots, overlays')
      .eq('id', snapshot.id)
      .single()
    if (!fullSnap?.slots) return

    await supabase.from('template_slots').delete().eq('template_id', templateId)

    const rows = fullSnap.slots.map(s => ({
      template_id: templateId,
      group_id: s.group_id,
      day_id: s.day_id,
      time_block_id: s.time_block_id,
      activity_id: s.activity_id,
      anchor_id: s.anchor_id,
      is_anchor: s.is_anchor,
      flags: s.flags || {},
    }))

    for (let i = 0; i < rows.length; i += 500) {
      await supabase.from('template_slots').insert(rows.slice(i, i + 500))
    }

    const { data: freshSlots } = await supabase.from('template_slots').select('*').eq('template_id', templateId)
    setSlots(freshSlots || [])
    // Restore overlays from snapshot
    if (templateId) {
      await supabase.from('template_overlays').delete().eq('template_id', templateId)
      const snapOverlays = fullSnap.overlays || []
      if (snapOverlays.length > 0) {
        const overlayRows = snapOverlays.map(o => ({ template_id: templateId, unit_id: o.unit_id, day_id: o.day_id, from_block_order: o.from_block_order, to_block_order: o.to_block_order, label: o.label }))
        await supabase.from('template_overlays').insert(overlayRows)
      }
      const { data: freshOverlays } = await supabase.from('template_overlays').select('*').eq('template_id', templateId)
      setOverlays(freshOverlays || [])
    }
    recalcStats(freshSlots || [])
  }

  async function renameSnapshot(snapshotId, newName) {
    await supabase.from('schedule_snapshots').update({ name: newName, is_auto: false }).eq('id', snapshotId)
    setSnapshots(prev => prev.map(s => s.id === snapshotId ? { ...s, name: newName, is_auto: false } : s))
  }

  async function regenFromScratch() {
    setConfirmRegen(false)
    await generate()
  }


  // Slots scoped to the active context — group view filters to selected group, all other views show camp-wide
  const visibleSlots = view === 'group' && selectedGroup
    ? slots.filter(s => s.group_id === selectedGroup)
    : slots

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
        <div style={{ background: '#FFF8E7', border: '1px solid #F5A623', borderRadius: 12, padding: '20px 24px', fontSize: 13 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 16, marginBottom: 8, color: '#7A5100' }}>Setup incomplete</div>
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
      {/* Controls bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {hasSchedule && (
          <>
            {/* View toggle */}
            <div style={{ display: 'flex', gap: 2, background: 'var(--border)', borderRadius: 8, padding: 3 }}>
              {[['group','Group View'],['day','Daily View'],['activity','Activity View']].map(([v, label]) => (
                <button key={v} onClick={() => { setView(v); if (v !== 'activity') setSelectedActivity(null) }} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-sans)', background: view === v ? 'var(--surface)' : 'none', color: view === v ? 'var(--text)' : 'var(--text-secondary)', boxShadow: view === v ? '0 1px 3px rgba(0,0,0,0.08)' : 'none' }}>{label}</button>
              ))}
            </div>

            {/* Weather toggle */}
            <button
              onClick={() => setWeatherMode(w => !w)}
              style={{ padding: '6px 14px', border: `1px solid ${weatherMode ? '#2F7DE1' : 'var(--border)'}`, borderRadius: 6, background: weatherMode ? '#EEF4FD' : 'var(--surface)', color: weatherMode ? '#2F7DE1' : 'var(--text)', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
            >
              ⛅ Weather Mode {weatherMode ? 'ON' : 'OFF'}
            </button>

            <div style={{ flex: 1 }} />

            <VersionsDropdown
              snapshots={snapshots}
              isOpen={showVersions}
              onToggle={() => setShowVersions(v => !v)}
              onRestore={restoreSnapshot}
              onSaveNamed={name => saveSnapshot(name, false)}
              onRenameAutoSave={renameSnapshot}
            />

            <button
              onClick={() => setShowFieldTripDrawer(v => !v)}
              style={{
                padding: '6px 14px',
                border: `1px solid ${showFieldTripDrawer || stampMode ? '#f59e0b' : 'var(--border)'}`,
                borderRadius: 6,
                background: showFieldTripDrawer || stampMode ? '#f59e0b18' : 'var(--surface)',
                color: showFieldTripDrawer || stampMode ? '#92400e' : 'var(--text)',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Field Trips {stampMode ? `· ${stampMode}` : ''}
            </button>

            <button onClick={() => exportToExcel({ slots, activities, anchors, groups, days, timeBlocks })} style={S.btnSecondary}>Export to Excel</button>
            <button onClick={() => setConfirmRegen(true)} style={S.btnDanger}>Regenerate from Scratch</button>
          </>
        )}

        {!hasSchedule && (
          <button onClick={generate} disabled={generating} style={{ ...S.btnPrimary, padding: '10px 24px', fontSize: 14 }}>
            {generating ? 'Generating…' : 'Generate Schedule'}
          </button>
        )}

        {hasSchedule && generating && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>Generating…</span>}
      </div>

      {/* Stats bar */}
      {hasSchedule && stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          <StatBadge label="Filled" value={`${stats.filled}/${stats.open}`} color="var(--success)" />
          <StatBadge label="Unfillable" value={visibleSlots.filter(s => s.flags?.UNFILLABLE && !s.flags?.UNFILLABLE_dismissed).length} color={visibleSlots.some(s => s.flags?.UNFILLABLE && !s.flags?.UNFILLABLE_dismissed) ? '#F0585D' : 'var(--text-secondary)'} onClick={() => setActiveFlag('UNFILLABLE')} />
          <StatBadge label="Underserved" value={visibleSlots.filter(s => s.flags?.UNDERSERVED && !s.flags?.UNDERSERVED_dismissed).length} color={visibleSlots.some(s => s.flags?.UNDERSERVED && !s.flags?.UNDERSERVED_dismissed) ? '#F5A623' : 'var(--text-secondary)'} onClick={() => setActiveFlag('UNDERSERVED')} />
          <StatBadge label="Weather Risk" value={visibleSlots.filter(s => s.flags?.WEATHER_RISK && !s.flags?.WEATHER_RISK_dismissed).length} color="#2F7DE1" onClick={() => setActiveFlag('WEATHER_RISK')} />
          <StatBadge label="Distribution" value={visibleSlots.filter(s => s.flags?.DISTRIBUTION && !s.flags?.DISTRIBUTION_dismissed).length} color="#7DC433" onClick={() => setActiveFlag('DISTRIBUTION')} />
        </div>
      )}

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
          onSelectGroup={setSelectedGroup}
          weatherMode={weatherMode}
          stampMode={stampMode}
          actMap={actMap}
          anchorMap={anchorMap}
          overlayForCell={overlayForCell}
          isOverlayHead={isOverlayHead}
          getOverlayRowSpan={getOverlayRowSpan}
          isAnchorTail={isAnchorTail}
          getAnchorRowSpan={getAnchorRowSpan}
          handleFillEnter={handleFillEnter}
          startFill={startFill}
          removeOverlay={removeOverlay}
          handleStampClick={handleStampClick}
          onEditSlot={setEditSlot}
          fillState={fillState}
          getSlot={getSlot}
        />
      )}

      {/* Daily view — all groups for one day */}
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
          sensors={sensors}
          swapSlots={swapSlots}
          lockActivity={lockActivity}
          releaseCell={releaseCell}
          overlayForCell={overlayForCell}
          isOverlayHead={isOverlayHead}
          getOverlayRowSpan={getOverlayRowSpan}
          isAnchorTail={isAnchorTail}
          getAnchorRowSpan={getAnchorRowSpan}
          handleFillEnter={handleFillEnter}
          startFill={startFill}
          removeOverlay={removeOverlay}
          handleStampClick={handleStampClick}
          onEditSlot={setEditSlot}
          fillState={fillState}
          getSlot={getSlot}
        />
      )}

      {/* Activity view — card grid + drilldown */}
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
          currentActivity={editSlot.activityId ? actMap.get(editSlot.activityId) : null}
          currentAnchor={editSlot.anchorId ? anchorMap.get(editSlot.anchorId) : null}
          weatherAlt={weatherMode && editSlot.activityId ? (() => { const a = actMap.get(editSlot.activityId); return a?.weather_alternative_id ? actMap.get(a.weather_alternative_id) : null })() : null}
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

