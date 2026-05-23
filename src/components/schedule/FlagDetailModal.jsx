import React from 'react'
import { FLAG_COLORS } from './SlotCell'
import { S } from '../../styles/shared'

const FLAG_DESCRIPTIONS = {
  UNFILLABLE: 'No eligible activity could be placed — the slot was left empty.',
  UNDERSERVED: 'Activity was scheduled fewer times than its minimum per week.',
  WEATHER_RISK: 'Outdoor activity — will be affected by weather.',
  DISTRIBUTION: 'Activity did not meet its early-week distribution preference.',
}

export default function FlagDetailModal({ flag, slots, groups, days, timeBlocks, activities, onDismiss, onClose }) {
  const groupMap = Object.fromEntries(groups.map(g => [g.id, g.name]))
  const dayMap = Object.fromEntries(days.map(d => [d.id, d.label]))
  const blockMap = Object.fromEntries(timeBlocks.map(b => [b.id, b.name]))
  const actMap = Object.fromEntries(activities.map(a => [a.id, a]))

  // Only include slots where flag is set AND not dismissed
  const flaggedSlots = slots.filter(s => s.flags?.[flag] && !s.flags?.[`${flag}_dismissed`])

  let rows = []

  if (flag === 'UNFILLABLE') {
    rows = flaggedSlots.map(s => ({
      col1: groupMap[s.group_id] || '?',
      col2: dayMap[s.day_id] || '?',
      col3: blockMap[s.time_block_id] || '?',
      col4: 'No eligible activity',
      reason: s.flags?.[`${flag}_reason`] || '',
      slotIds: [s.id],
    }))
  } else if (flag === 'UNDERSERVED') {
    const seen = new Set()
    for (const s of flaggedSlots) {
      if (!s.activity_id) continue
      const key = `${s.group_id}|${s.activity_id}`
      if (seen.has(key)) continue
      seen.add(key)
      const act = actMap[s.activity_id]
      const scheduled = slots.filter(x => x.group_id === s.group_id && x.activity_id === s.activity_id).length
      const matchingSlotIds = flaggedSlots
        .filter(x => x.group_id === s.group_id && x.activity_id === s.activity_id)
        .map(x => x.id)
      rows.push({
        col1: groupMap[s.group_id] || '?',
        col2: act?.name || '?',
        col3: `${scheduled} / ${act?.min_per_week ?? '?'} needed`,
        col4: '',
        reason: s.flags?.[`${flag}_reason`] || '',
        slotIds: matchingSlotIds,
      })
    }
  } else if (flag === 'WEATHER_RISK') {
    rows = flaggedSlots.map(s => ({
      col1: groupMap[s.group_id] || '?',
      col2: dayMap[s.day_id] || '?',
      col3: blockMap[s.time_block_id] || '?',
      col4: actMap[s.activity_id]?.name || '?',
      reason: s.flags?.[`${flag}_reason`] || '',
      slotIds: [s.id],
    }))
  } else if (flag === 'DISTRIBUTION') {
    const seen = new Set()
    for (const s of flaggedSlots) {
      if (!s.activity_id) continue
      const key = `${s.group_id}|${s.activity_id}`
      if (seen.has(key)) continue
      seen.add(key)
      const act = actMap[s.activity_id]
      const matchingSlotIds = flaggedSlots
        .filter(x => x.group_id === s.group_id && x.activity_id === s.activity_id)
        .map(x => x.id)
      rows.push({
        col1: groupMap[s.group_id] || '?',
        col2: act?.name || '?',
        col3: `Prefer ${act?.prefer_before_day_min ?? '?'}× before day ${act?.prefer_before_day ?? '?'}`,
        col4: '',
        reason: s.flags?.[`${flag}_reason`] || '',
        slotIds: matchingSlotIds,
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
    <div style={S.overlay}>
      <div style={{ ...S.modalLg, width: 640 }}>
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
                  <th style={{ padding: '7px 12px', textAlign: 'left', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Reason</th>
                  {onDismiss && <th style={{ padding: '7px 12px', width: 80 }} />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? '' : 'var(--bg)' }}>
                    <td style={{ padding: '7px 12px', fontWeight: 500 }}>{r.col1}</td>
                    <td style={{ padding: '7px 12px', color: 'var(--text-secondary)' }}>{r.col2}</td>
                    <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.col3}</td>
                    {r.col4 !== '' && <td style={{ padding: '7px 12px', fontSize: 12 }}>{r.col4}</td>}
                    <td style={{ padding: '7px 12px', fontSize: 11, color: 'var(--text-secondary)', maxWidth: 180, whiteSpace: 'normal', lineHeight: 1.4 }}>{r.reason}</td>
                    {onDismiss && (
                      <td style={{ padding: '7px 12px' }}>
                        <button
                          onClick={() => onDismiss(r.slotIds, flag)}
                          style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', background: 'none', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer', padding: '3px 8px', fontFamily: 'inherit' }}
                        >
                          Dismiss
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={S.btnPrimary}>Close</button>
        </div>
      </div>
    </div>
  )
}
