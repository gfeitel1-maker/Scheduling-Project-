import { useState, useEffect, useCallback } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'
import buildSchedule from '../engine/buildSchedule'
import { S } from '../styles/shared'
import StatBadge from '../components/schedule/StatBadge'
import SlotCell, { FLAG_COLORS, activityColor, cellTd, emptyTd } from '../components/schedule/SlotCell'
import FlagDetailModal from '../components/schedule/FlagDetailModal'
import EditModal from '../components/schedule/EditModal'
import ConfirmRegenModal from '../components/schedule/ConfirmRegenModal'
import VersionsDropdown from '../components/schedule/VersionsDropdown'


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
  const [showVersions, setShowVersions] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  useEffect(() => { loadAll() }, [campId])

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
      .insert({ template_id: templateId, name: name || null, is_auto: isAuto, slots: snapSlots })
      .select('id, template_id, name, is_auto, created_at')
      .single()
    if (snap) setSnapshots(prev => [snap, ...prev])
  }

  async function restoreSnapshot(snapshot) {
    if (!templateId) return
    const { data: fullSnap } = await supabase
      .from('schedule_snapshots')
      .select('slots')
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

  function exportToExcel() {
    const wb = XLSX.utils.book_new()
    const actLookup = new Map(activities.map(a => [a.id, a.name]))
    const anchorLookup = new Map(anchors.map(a => [a.id, a.name]))

    // One sheet per day
    for (const day of days) {
      const header = ['Time Block', ...groups.map(g => g.name)]
      const dataRows = timeBlocks.map(block => {
        const row = [`${block.name} (${block.start_time?.slice(0,5)}–${block.end_time?.slice(0,5)})`]
        for (const group of groups) {
          const slot = slots.find(s => s.group_id === group.id && s.day_id === day.id && s.time_block_id === block.id)
          if (!slot) { row.push(''); continue }
          if (slot.is_anchor) { row.push(anchorLookup.get(slot.anchor_id) || 'Anchor'); continue }
          if (slot.activity_id) { row.push(actLookup.get(slot.activity_id) || ''); continue }
          row.push('')
        }
        return row
      })
      const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows])
      // Column widths
      ws['!cols'] = [{ wch: 22 }, ...groups.map(() => ({ wch: 16 }))]
      XLSX.utils.book_append_sheet(wb, ws, day.label)
    }

    // Master flat sheet
    const masterHeader = ['Group', 'Day', 'Time Block', 'Activity']
    const masterRows = []
    for (const group of groups) {
      for (const day of days) {
        for (const block of timeBlocks) {
          const slot = slots.find(s => s.group_id === group.id && s.day_id === day.id && s.time_block_id === block.id)
          if (!slot) continue
          const actName = slot.is_anchor
            ? `[Anchor] ${anchorLookup.get(slot.anchor_id) || ''}`
            : (actLookup.get(slot.activity_id) || '')
          masterRows.push([group.name, day.label, block.name, actName])
        }
      }
    }
    const masterWs = XLSX.utils.aoa_to_sheet([masterHeader, ...masterRows])
    masterWs['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 22 }, { wch: 20 }]
    XLSX.utils.book_append_sheet(wb, masterWs, 'All Groups')

    XLSX.writeFile(wb, 'camp_schedule.xlsx')
  }

  // Slots scoped to the active context — group view filters to selected group, all other views show camp-wide
  const visibleSlots = view === 'group' && selectedGroup
    ? slots.filter(s => s.group_id === selectedGroup)
    : slots

  // Build lookup maps for rendering
  const actMap = new Map(activities.map((a, i) => [a.id, { ...a, colorIdx: i }]))
  const anchorMap = new Map(anchors.map(a => [a.id, a]))
  const dayMap = new Map(days.map(d => [d.id, d]))
  const blockMap = new Map(timeBlocks.map(b => [b.id, b]))

  function getSlot(groupId, dayId, blockId) {
    return slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId)
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

            <button onClick={exportToExcel} style={S.btnSecondary}>Export to Excel</button>
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
        <div>
          {/* Group pills */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {groups.map(g => (
              <button key={g.id} onClick={() => setSelectedGroup(g.id)} style={{
                padding: '5px 12px', borderRadius: 20, border: `1.5px solid ${selectedGroup === g.id ? 'var(--primary)' : 'var(--border)'}`,
                background: selectedGroup === g.id ? 'var(--primary)' : 'var(--surface)',
                color: selectedGroup === g.id ? '#fff' : 'var(--text)',
                fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}>{g.name}</button>
            ))}
          </div>

          {selectedGroup && (
            <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 500, width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1.5px solid var(--border)' }}>
                      <th style={{ ...S.th, whiteSpace: 'nowrap', width: 140, position: 'sticky', top: 0, left: 0, background: 'var(--surface-elevated)', zIndex: 3 }}>Block</th>
                      {days.map(d => <th key={d.id} style={{ ...S.th, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--surface-elevated)', zIndex: 2 }}>{d.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {timeBlocks.map(block => (
                      <tr key={block.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '10px 14px', verticalAlign: 'middle', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1, borderRight: '1px solid var(--border)' }}>
                          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{block.name}</div>
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>{block.start_time?.slice(0,5)}–{block.end_time?.slice(0,5)}</div>
                        </td>
                        {days.map(day => {
                          const slot = getSlot(selectedGroup, day.id, block.id)
                          if (!slot) return <td key={day.id} style={emptyTd} />
                          const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                          const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
                          return (
                            <SlotCell
                              key={day.id}
                              slot={slot.is_anchor ? { ...slot, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id } : { ...slot, type: slot.activity_id || !slot.is_anchor ? 'activity' : 'unavailable', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                              activity={act}
                              anchor={anchor}
                              actColorIdx={act?.colorIdx || 0}
                              weatherMode={weatherMode}
                              onEdit={s => setEditSlot(s)}
                            />
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
          )}
        </div>
      )}

      {/* Daily view — all groups for one day */}
      {hasSchedule && view === 'day' && (
        <div>
          {/* Day pills */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {days.map(d => (
              <button key={d.id} onClick={() => setSelectedDay(d.id)} style={{
                padding: '5px 16px', borderRadius: 20,
                border: `1.5px solid ${selectedDay === d.id ? 'var(--primary)' : 'var(--border)'}`,
                background: selectedDay === d.id ? 'var(--primary)' : 'var(--surface)',
                color: selectedDay === d.id ? '#fff' : 'var(--text)',
                fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}>{d.label}</button>
            ))}
          </div>

          {selectedDay && (
            <DndContext
              sensors={sensors}
              onDragEnd={({ active, over }) => {
                if (!over) return
                const slotA = active.data.current?.slot
                const slotB = over.data.current?.slot
                if (!slotA || !slotB) return
                if (slotA.groupId === slotB.groupId && slotA.dayId === slotB.dayId && slotA.blockId === slotB.blockId) return
                if (slotB.type === 'anchor' || slotB.type === 'unavailable') return
                swapSlots(
                  { groupId: slotA.groupId, dayId: slotA.dayId, blockId: slotA.blockId, activityId: slotA.activity_id },
                  { groupId: slotB.groupId, dayId: slotB.dayId, blockId: slotB.blockId, activityId: slotB.activity_id }
                )
              }}
            >
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: '100%', minWidth: 140 + groups.length * 130, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                <thead>
                  <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1.5px solid var(--border)' }}>
                    <th style={{ ...S.th, whiteSpace: 'nowrap', width: 140, position: 'sticky', top: 0, left: 0, background: 'var(--surface-elevated)', zIndex: 3 }}>Block</th>
                    {groups.map(g => <th key={g.id} style={{ ...S.th, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--surface-elevated)', zIndex: 2 }}>{g.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {timeBlocks.map(block => (
                    <tr key={block.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px 14px', verticalAlign: 'middle', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1, borderRight: '1px solid var(--border)' }}>
                        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{block.name}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>{block.start_time?.slice(0,5)}–{block.end_time?.slice(0,5)}</div>
                      </td>
                      {groups.map(group => {
                        const slot = getSlot(group.id, selectedDay, block.id)
                        if (!slot) return <td key={group.id} style={emptyTd} />
                        const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                        const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
                        const actIsLocked = slot.activity_id && act?.is_locked
                        const isLocked = Boolean(actIsLocked && !slot.is_released)
                        return (
                          <SlotCell
                            key={group.id}
                            slot={slot.is_anchor
                              ? { ...slot, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id }
                              : { ...slot, type: 'activity', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                            activity={act}
                            anchor={anchor}
                            actColorIdx={act?.colorIdx || 0}
                            weatherMode={weatherMode}
                            onEdit={s => setEditSlot(s)}
                            onLock={s => lockActivity(s.activity_id)}
                            onRelease={s => releaseCell(s.id)}
                            isLocked={isLocked}
                            isDndEnabled={!isLocked}
                          />
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </DndContext>
          )}
        </div>
      )}

      {/* Activity view — card grid + drilldown */}
      {hasSchedule && view === 'activity' && (
        <div>
          {!selectedActivity ? (
            /* Card grid */
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
              {activities.map((act, idx) => {
                const color = activityColor(idx)
                const totalSlots = slots.filter(s => s.activity_id === act.id).length
                const weeklyGroups = new Set(slots.filter(s => s.activity_id === act.id).map(s => s.group_id)).size
                return (
                  <button
                    key={act.id}
                    onClick={() => setSelectedActivity(act.id)}
                    style={{
                      background: 'var(--surface)', border: `1px solid var(--border)`,
                      borderRadius: 8, padding: '14px 16px', textAlign: 'left',
                      cursor: 'pointer', transition: 'border-color 0.15s, box-shadow 0.15s',
                      borderTop: `4px solid ${color}`,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = color; e.currentTarget.style.boxShadow = `0 2px 8px ${color}30` }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.borderTopColor = color }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)', marginBottom: 6, lineHeight: 1.3 }}>{act.name}</div>
                    {act.location && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>{act.location}</div>}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      {act.priority === 'high' && (
                        <span style={{ fontSize: 10, background: color, color: '#fff', borderRadius: 3, padding: '1px 6px', fontWeight: 700 }}>HIGH</span>
                      )}
                      {act.is_outdoor && (
                        <span style={{ fontSize: 10, color: '#2F7DE1', fontWeight: 600 }}>OUTDOOR</span>
                      )}
                    </div>
                    <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
                      {weeklyGroups} group{weeklyGroups !== 1 ? 's' : ''} · {totalSlots} slots/wk
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            /* Drilldown: weekly schedule for selected activity */
            (() => {
              const actIdx = activities.findIndex(a => a.id === selectedActivity)
              const act = activities[actIdx]
              const color = activityColor(actIdx)
              return (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                    <button
                      onClick={() => setSelectedActivity(null)}
                      style={{ ...S.btnSecondary, padding: '5px 12px', fontSize: 12 }}
                    >← All Activities</button>
                    <span style={{ width: 12, height: 12, borderRadius: '50%', background: color, display: 'inline-block' }} />
                    <span style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18, color: 'var(--text)' }}>{act?.name}</span>
                    {act?.location && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{act.location}</span>}
                    {act?.priority === 'high' && <span style={{ fontSize: 11, background: color, color: '#fff', borderRadius: 3, padding: '2px 8px', fontWeight: 700 }}>HIGH PRIORITY</span>}
                    {act?.is_outdoor && <span style={{ fontSize: 11, color: '#2F7DE1', fontWeight: 600 }}>OUTDOOR</span>}
                  </div>

                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                      <thead>
                        <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1.5px solid var(--border)' }}>
                          <th style={{ ...S.th, whiteSpace: 'nowrap', width: 140, position: 'sticky', top: 0, left: 0, background: 'var(--surface-elevated)', zIndex: 3 }}>Block</th>
                          {days.map(d => <th key={d.id} style={{ ...S.th, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--surface-elevated)', zIndex: 2 }}>{d.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {timeBlocks.map(block => (
                          <tr key={block.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '10px 14px', verticalAlign: 'middle', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1, borderRight: '1px solid var(--border)' }}>
                              <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{block.name}</div>
                              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>{block.start_time?.slice(0,5)}–{block.end_time?.slice(0,5)}</div>
                            </td>
                            {days.map(day => {
                              const assigned = slots.filter(s => s.activity_id === selectedActivity && s.day_id === day.id && s.time_block_id === block.id)
                              return (
                                <td key={day.id} style={{ ...cellTd, background: assigned.length ? `${color}12` : '', borderLeft: assigned.length ? `3px solid ${color}` : '3px solid transparent', verticalAlign: 'top' }}>
                                  {assigned.length === 0 ? null : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                      {assigned.map(s => {
                                        const g = groups.find(g => g.id === s.group_id)
                                        return (
                                          <span key={s.id} style={{ fontSize: 11, fontWeight: 600, color, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {g?.name || '?'}
                                          </span>
                                        )
                                      })}
                                    </div>
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })()
          )}
        </div>
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
    </div>
  )
}

