import { activityColor, cellTd } from '../schedule/SlotCell'
import { S } from '../../styles/shared'

export default function ScheduleActivityView({
  activities, groups, days, timeBlocks, slots,
  selectedActivity, onSelectActivity,
}) {
  return (
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
                onClick={() => onSelectActivity(act.id)}
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
                  onClick={() => onSelectActivity(null)}
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
  )
}
