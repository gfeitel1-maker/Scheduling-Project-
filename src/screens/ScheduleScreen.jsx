import { useState, useEffect, useCallback } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'
import buildSchedule from '../engine/buildSchedule'

const ACTIVITY_COLORS = ['#00ADBB','#2F7DE1','#00AA59','#A63595','#F0585D','#7DC433']
const ANCHOR_COLOR = '#A63595'

const FLAG_COLORS = {
  UNFILLABLE: '#F0585D',
  UNDERSERVED: '#F5A623',
  WEATHER_RISK: '#2F7DE1',
  DISTRIBUTION: '#7DC433',
}

function activityColor(idx) { return ACTIVITY_COLORS[idx % ACTIVITY_COLORS.length] }

function StatBadge({ label, value, color, onClick }) {
  const clickable = onClick && value > 0
  return (
    <div
      onClick={clickable ? onClick : undefined}
      style={{
        background: 'var(--surface)', border: `1px solid ${clickable ? color || 'var(--border)' : 'var(--border)'}`,
        borderRadius: 6, padding: '8px 14px', textAlign: 'center', minWidth: 90,
        cursor: clickable ? 'pointer' : 'default',
        transition: 'border-color 0.15s',
      }}
      title={clickable ? `Click to see details` : undefined}
    >
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, color: color || 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>
        {label}{clickable ? ' ↗' : ''}
      </div>
    </div>
  )
}

const FLAG_DESCRIPTIONS = {
  UNFILLABLE: 'No eligible activity could be placed — the slot was left empty.',
  UNDERSERVED: 'Activity was scheduled fewer times than its minimum per week.',
  WEATHER_RISK: 'Outdoor activity — will be affected by weather.',
  DISTRIBUTION: 'Activity did not meet its early-week distribution preference.',
}

function FlagDetailModal({ flag, slots, groups, days, timeBlocks, activities, onClose }) {
  const groupMap = Object.fromEntries(groups.map(g => [g.id, g.name]))
  const dayMap = Object.fromEntries(days.map(d => [d.id, d.label]))
  const blockMap = Object.fromEntries(timeBlocks.map(b => [b.id, b.name]))
  const actMap = Object.fromEntries(activities.map(a => [a.id, a]))

  const flaggedSlots = slots.filter(s => s.flags?.[flag])

  let rows = []

  if (flag === 'UNFILLABLE') {
    rows = flaggedSlots.map(s => ({
      col1: groupMap[s.group_id] || '?',
      col2: dayMap[s.day_id] || '?',
      col3: blockMap[s.time_block_id] || '?',
      col4: 'No eligible activity',
    }))
  } else if (flag === 'UNDERSERVED') {
    // Deduplicate to group × activity pairs
    const seen = new Set()
    for (const s of flaggedSlots) {
      if (!s.activity_id) continue
      const key = `${s.group_id}|${s.activity_id}`
      if (seen.has(key)) continue
      seen.add(key)
      const act = actMap[s.activity_id]
      const scheduled = slots.filter(x => x.group_id === s.group_id && x.activity_id === s.activity_id).length
      rows.push({
        col1: groupMap[s.group_id] || '?',
        col2: act?.name || '?',
        col3: `${scheduled} / ${act?.min_per_week ?? '?'} needed`,
        col4: '',
      })
    }
  } else if (flag === 'WEATHER_RISK') {
    rows = flaggedSlots.map(s => ({
      col1: groupMap[s.group_id] || '?',
      col2: dayMap[s.day_id] || '?',
      col3: blockMap[s.time_block_id] || '?',
      col4: actMap[s.activity_id]?.name || '?',
    }))
  } else if (flag === 'DISTRIBUTION') {
    const seen = new Set()
    for (const s of flaggedSlots) {
      if (!s.activity_id) continue
      const key = `${s.group_id}|${s.activity_id}`
      if (seen.has(key)) continue
      seen.add(key)
      const act = actMap[s.activity_id]
      rows.push({
        col1: groupMap[s.group_id] || '?',
        col2: act?.name || '?',
        col3: `Prefer ${act?.prefer_before_day_min ?? '?'}× before day ${act?.prefer_before_day ?? '?'}`,
        col4: '',
      })
    }
  }

  const headers = {
    UNFILLABLE:   ['Group', 'Day', 'Block', 'Reason'],
    UNDERSERVED:  ['Group', 'Activity', 'Scheduled / Min', ''],
    WEATHER_RISK: ['Group', 'Day', 'Block', 'Activity'],
    DISTRIBUTION: ['Group', 'Activity', 'Preference', ''],
  }[flag] || ['Col 1', 'Col 2', 'Col 3', 'Col 4']

  const color = FLAG_COLORS[flag] || '#ccc'

  return (
    <div style={overlay}>
      <div style={{ ...modalBox, width: 580 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
              {flag.replace('_', ' ')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{FLAG_DESCRIPTIONS[flag]}</div>
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, color }}>{rows.length}</span>
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>No issues found.</div>
        ) : (
          <div style={{ overflowY: 'auto', maxHeight: 380, border: '1px solid var(--border)', borderRadius: 6, marginTop: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                  {headers.filter(h => h).map(h => (
                    <th key={h} style={{ padding: '7px 12px', textAlign: 'left', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? '' : 'var(--bg)' }}>
                    <td style={{ padding: '7px 12px', fontWeight: 500 }}>{r.col1}</td>
                    <td style={{ padding: '7px 12px', color: 'var(--text-secondary)' }}>{r.col2}</td>
                    <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.col3}</td>
                    {r.col4 !== '' && <td style={{ padding: '7px 12px', fontSize: 12 }}>{r.col4}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={btnPrimary}>Close</button>
        </div>
      </div>
    </div>
  )
}

function SlotCell({ slot, activity, anchor, actColorIdx, weatherMode, onEdit }) {
  if (!slot) return <td style={emptyTd} />

  if (slot.type === 'anchor') {
    return (
      <td style={{ ...cellTd, background: '#F3E8FA', borderLeft: `3px solid ${ANCHOR_COLOR}` }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: ANCHOR_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {anchor?.name || 'Anchor'}
        </div>
      </td>
    )
  }

  if (slot.type === 'unavailable') {
    return <td style={{ ...cellTd, background: 'var(--bg)', opacity: 0.4 }} />
  }

  const flags = slot.flags || {}
  const hasFlags = Object.keys(flags).length > 0
  const isOutdoor = flags.WEATHER_RISK
  const color = activity ? activityColor(actColorIdx) : '#E0E0E0'
  const isWeatherHighlight = weatherMode && isOutdoor

  return (
    <td
      style={{
        ...cellTd,
        background: activity ? `${color}18` : '#F8F8F8',
        borderLeft: activity ? `3px solid ${color}` : '3px solid #E0E0E0',
        outline: isWeatherHighlight ? '2px solid #2F7DE1' : 'none',
        cursor: 'pointer',
        position: 'relative',
      }}
      onClick={() => onEdit(slot)}
      title={activity?.name || 'Empty — click to assign'}
    >
      <div style={{ fontSize: 11, fontWeight: activity ? 600 : 400, color: activity ? color : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {activity?.name || <span style={{ opacity: 0.5 }}>—</span>}
      </div>
      {hasFlags && (
        <div style={{ display: 'flex', gap: 2, marginTop: 2, flexWrap: 'wrap' }}>
          {Object.keys(flags).map(f => (
            <span key={f} style={{ width: 6, height: 6, borderRadius: '50%', background: FLAG_COLORS[f] || '#ccc', display: 'inline-block' }} title={f} />
          ))}
        </div>
      )}
    </td>
  )
}

function EditModal({ slot, activities, eligibleActivities, currentActivity, currentAnchor, weatherAlt, weatherMode, onSave, onClose }) {
  const [selected, setSelected] = useState(slot.activityId || '')

  if (slot.type === 'anchor') {
    return (
      <div style={overlay}>
        <div style={modalBox}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 16, marginBottom: 8, color: ANCHOR_COLOR }}>
            ⚓ Anchor: {currentAnchor?.name}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>Anchors are fixed and cannot be changed here.</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button onClick={onClose} style={btnPrimary}>Close</button></div>
        </div>
      </div>
    )
  }

  return (
    <div style={overlay}>
      <div style={modalBox}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Assign Activity</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, fontFamily: 'var(--font-mono)' }}>
          Currently: {currentActivity?.name || 'Empty'}
        </div>

        {weatherMode && weatherAlt && (
          <div style={{ background: '#EEF4FD', border: '1px solid #2F7DE1', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 13 }}>
            <span style={{ color: '#2F7DE1', fontWeight: 600 }}>Weather alternative: </span>{weatherAlt.name}
            <button onClick={() => { setSelected(weatherAlt.id); setTimeout(() => onSave(weatherAlt.id), 50) }} style={{ ...btnPrimary, padding: '4px 10px', marginLeft: 10, fontSize: 12 }}>Swap</button>
          </div>
        )}

        <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 16 }}>
          <div
            style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', background: selected === '' ? 'var(--surface-elevated)' : '', borderBottom: '1px solid var(--border)' }}
            onClick={() => setSelected('')}
          >
            — Clear slot —
          </div>
          {eligibleActivities.map((a, i) => (
            <div key={a.id}
              style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 500, background: selected === a.id ? 'var(--surface-elevated)' : '', borderBottom: i < eligibleActivities.length - 1 ? '1px solid var(--border)' : '', display: 'flex', alignItems: 'center', gap: 8 }}
              onClick={() => setSelected(a.id)}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: activityColor(i), display: 'inline-block', flexShrink: 0 }} />
              {a.name}
              {a.priority === 'high' && <span style={{ fontSize: 10, background: 'var(--primary)', color: '#fff', borderRadius: 3, padding: '1px 5px', marginLeft: 'auto' }}>HIGH</span>}
            </div>
          ))}
          {eligibleActivities.length === 0 && (
            <div style={{ padding: '16px 12px', fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center' }}>No eligible activities for this group</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => onSave(selected || null)} style={btnPrimary}>Save</button>
        </div>
      </div>
    </div>
  )
}

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

  useEffect(() => { loadAll() }, [campId])

  async function loadAll() {
    setLoading(true)
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
    setGroups(g); setDays(d); setTimeBlocks(b); setActivities(a); setAnchors(anc); setTiers(t)
    if (g.length > 0) setSelectedGroup(g[0].id)
    if (d.length > 0) setSelectedDay(d[0].id)

    // Load template
    const { data: tmpl } = await supabase.from('schedule_templates').select('id').eq('camp_id', campId).single()
    if (tmpl) {
      setTemplateId(tmpl.id)
      const { data: slotData } = await supabase.from('template_slots').select('*').eq('template_id', tmpl.id)
      const saved = slotData || []
      setSlots(saved)
      recalcStats(saved, a)
    }
    setLoading(false)
  }

  function recalcStats(slotList, actList) {
    const actArr = actList || activities
    const open = slotList.filter(s => s.is_anchor === false && !s.flags?.UNFILLABLE_skip)
    const filled = slotList.filter(s => s.is_anchor === false && s.activity_id)
    const unfillable = slotList.filter(s => s.flags?.UNFILLABLE)
    const underserved = slotList.filter(s => s.flags?.UNDERSERVED)
    const allFlags = slotList.reduce((sum, s) => sum + Object.keys(s.flags || {}).length, 0)
    setStats({ open: open.length, filled: filled.length, unfillable: unfillable.length, underserved: underserved.length, allFlags })
  }

  async function generate() {
    setGenerating(true)
    const result = buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId })

    // Upsert template
    let tid = templateId
    if (!tid) {
      const { data } = await supabase.from('schedule_templates').insert({ camp_id: campId, name: 'Master Template' }).select('id').single()
      tid = data.id
      setTemplateId(tid)
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
    recalcStats(freshSlots || [], activities)
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
        <div style={{ background: '#FFF8E7', border: '1px solid #F5A623', borderRadius: 8, padding: '20px 24px', fontSize: 13 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 15, marginBottom: 8 }}>Setup incomplete</div>
          Setup the following before generating a schedule:
          <ul style={{ marginTop: 8, paddingLeft: 18, lineHeight: 2 }}>
            {groups.length === 0 && <li>Groups</li>}
            {days.length === 0 && <li>Days of Operation</li>}
            {timeBlocks.length === 0 && <li>Time Blocks</li>}
            {activities.length === 0 && <li>Activities</li>}
          </ul>
          <button onClick={() => onNavigate('setup')} style={{ ...btnPrimary, marginTop: 12 }}>Go to Camp Setup</button>
        </div>
      </div>
    )
  }

  const hasSchedule = slots.length > 0

  return (
    <div style={{ maxWidth: '100%' }}>
      {/* Controls bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {hasSchedule && (
          <>
            {/* View toggle */}
            <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              {[['group','Group View'],['day','Daily View'],['activity','Activity View']].map(([v, label]) => (
                <button key={v} onClick={() => { setView(v); if (v !== 'activity') setSelectedActivity(null) }} style={{ padding: '6px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: view === v ? 'var(--primary)' : 'var(--surface)', color: view === v ? '#fff' : 'var(--text)' }}>{label}</button>
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

            <button onClick={exportToExcel} style={btnSecondary}>Export to Excel</button>
            <button onClick={() => setConfirmRegen(true)} style={btnDanger}>Regenerate from Scratch</button>
          </>
        )}

        {!hasSchedule && (
          <button onClick={generate} disabled={generating} style={{ ...btnPrimary, padding: '10px 24px', fontSize: 14 }}>
            {generating ? 'Generating…' : 'Generate Schedule'}
          </button>
        )}

        {hasSchedule && generating && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>Generating…</span>}
      </div>

      {/* Stats bar */}
      {hasSchedule && stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          <StatBadge label="Filled" value={`${stats.filled}/${stats.open}`} color="var(--success)" />
          <StatBadge label="Unfillable" value={stats.unfillable} color={stats.unfillable > 0 ? '#F0585D' : 'var(--text-secondary)'} onClick={() => setActiveFlag('UNFILLABLE')} />
          <StatBadge label="Underserved" value={stats.underserved} color={stats.underserved > 0 ? '#F5A623' : 'var(--text-secondary)'} onClick={() => setActiveFlag('UNDERSERVED')} />
          <StatBadge label="Weather Risk" value={slots.filter(s => s.flags?.WEATHER_RISK).length} color="#2F7DE1" onClick={() => setActiveFlag('WEATHER_RISK')} />
          <StatBadge label="Distribution" value={slots.filter(s => s.flags?.DISTRIBUTION).length} color="#7DC433" onClick={() => setActiveFlag('DISTRIBUTION')} />
        </div>
      )}

      {/* No schedule state */}
      {!hasSchedule && !generating && (
        <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--text-secondary)', fontSize: 13 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📅</div>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18, color: 'var(--text)', marginBottom: 8 }}>No schedule yet</div>
          <div>Click "Generate Schedule" to build one from your current setup.</div>
        </div>
      )}

      {/* Group view */}
      {hasSchedule && view === 'group' && (
        <div>
          {/* Group pills */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {groups.map(g => (
              <button key={g.id} onClick={() => setSelectedGroup(g.id)} style={{
                padding: '5px 12px', borderRadius: 20, border: `1px solid ${selectedGroup === g.id ? 'var(--primary)' : 'var(--border)'}`,
                background: selectedGroup === g.id ? 'var(--primary)' : 'var(--surface)',
                color: selectedGroup === g.id ? '#fff' : 'var(--text)',
                fontSize: 12, fontWeight: 500, cursor: 'pointer',
              }}>{g.name}</button>
            ))}
          </div>

          {selectedGroup && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', minWidth: 500, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <thead>
                  <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ ...th, minWidth: 100 }}>Block</th>
                    {days.map(d => <th key={d.id} style={th}>{d.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {timeBlocks.map(block => (
                    <tr key={block.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)' }}>{block.name}</div>
                        <div>{block.start_time?.slice(0,5)}–{block.end_time?.slice(0,5)}</div>
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
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {days.map(d => (
              <button key={d.id} onClick={() => setSelectedDay(d.id)} style={{
                padding: '5px 16px', borderRadius: 20,
                border: `1px solid ${selectedDay === d.id ? 'var(--primary)' : 'var(--border)'}`,
                background: selectedDay === d.id ? 'var(--primary)' : 'var(--surface)',
                color: selectedDay === d.id ? '#fff' : 'var(--text)',
                fontSize: 12, fontWeight: 500, cursor: 'pointer',
              }}>{d.label}</button>
            ))}
          </div>

          {selectedDay && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <thead>
                  <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ ...th, minWidth: 110, position: 'sticky', left: 0, background: 'var(--bg)', zIndex: 1 }}>Block</th>
                    {groups.map(g => <th key={g.id} style={{ ...th, minWidth: 90 }}>{g.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {timeBlocks.map(block => (
                    <tr key={block.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1, borderRight: '1px solid var(--border)' }}>
                        <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)' }}>{block.name}</div>
                        <div>{block.start_time?.slice(0,5)}–{block.end_time?.slice(0,5)}</div>
                      </td>
                      {groups.map(group => {
                        const slot = getSlot(group.id, selectedDay, block.id)
                        if (!slot) return <td key={group.id} style={emptyTd} />
                        const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                        const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
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
                      style={{ ...btnSecondary, padding: '5px 12px', fontSize: 12 }}
                    >← All Activities</button>
                    <span style={{ width: 12, height: 12, borderRadius: '50%', background: color, display: 'inline-block' }} />
                    <span style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18, color: 'var(--text)' }}>{act?.name}</span>
                    {act?.location && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{act.location}</span>}
                    {act?.priority === 'high' && <span style={{ fontSize: 11, background: color, color: '#fff', borderRadius: 3, padding: '2px 8px', fontWeight: 700 }}>HIGH PRIORITY</span>}
                    {act?.is_outdoor && <span style={{ fontSize: 11, color: '#2F7DE1', fontWeight: 600 }}>OUTDOOR</span>}
                  </div>

                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                      <thead>
                        <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                          <th style={{ ...th, minWidth: 110, position: 'sticky', left: 0, background: 'var(--bg)', zIndex: 1 }}>Block</th>
                          {days.map(d => <th key={d.id} style={th}>{d.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {timeBlocks.map(block => (
                          <tr key={block.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1, borderRight: '1px solid var(--border)' }}>
                              <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)' }}>{block.name}</div>
                              <div>{block.start_time?.slice(0,5)}–{block.end_time?.slice(0,5)}</div>
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
          slots={slots}
          groups={groups}
          days={days}
          timeBlocks={timeBlocks}
          activities={activities}
          onClose={() => setActiveFlag(null)}
        />
      )}

      {/* Regen confirm */}
      {confirmRegen && (
        <div style={overlay}>
          <div style={{ ...modalBox, maxWidth: 400 }}>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Regenerate from Scratch?</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
              This will delete your current schedule including all manual edits. Continue?
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmRegen(false)} style={btnSecondary}>Cancel</button>
              <button onClick={regenFromScratch} style={btnDanger}>Yes, Regenerate</button>
            </div>
          </div>
        </div>
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

const td = { padding: '8px 10px', textAlign: 'left', fontSize: 12, verticalAlign: 'middle' }
const th = { padding: '8px 10px', textAlign: 'left', fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }
const cellTd = { padding: '6px 8px', width: 100, minWidth: 80, verticalAlign: 'top', cursor: 'pointer' }
const emptyTd = { padding: '6px 8px', width: 100, minWidth: 80, background: 'var(--bg)', opacity: 0.3 }
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }
const modalBox = { background: 'var(--surface)', borderRadius: 10, padding: 28, width: 480, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto' }
const btnPrimary = { padding: '7px 14px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 5, fontWeight: 600, fontSize: 13, cursor: 'pointer' }
const btnSecondary = { padding: '7px 14px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 5, fontWeight: 500, fontSize: 13, cursor: 'pointer' }
const btnDanger = { padding: '7px 14px', background: 'none', color: 'var(--warning)', border: '1px solid var(--warning)', borderRadius: 5, fontWeight: 500, fontSize: 13, cursor: 'pointer' }
