import { activityColor } from '../schedule/slotCellConstants'
import { buildRowTracks, columnTracks } from '../../screens/schedule/gridTracks'
import { placeCell, placeRowHeader } from '../../screens/schedule/gridPlacement'
import { S } from '../../styles/shared'
import { cellAccessibleName, blockNamesForSpan } from './cellLabel'
import useGridKeyboardNav from './useGridKeyboardNav'
import './scheduleGrid.css'

const NO_COLLAPSE = new Set()

// M4 §D7: the M3b interim `act.location` fallback is removed. By this point
// every activity's location_id is either correctly bound (M1's migration
// backfill re-pointed every pre-v32 activity; every post-v32 create/update
// goes through location_id exclusively — ingest is the last writer of the
// frozen `location` string, and this ADR closes it) or genuinely unset. The
// fallback was not merely dead — it was actively misleading for a DELETED
// place: a delete clears location_id to null but never touches the frozen
// `location` string, so the fallback would show a deleted place's stale name
// as if still assigned. A location_id that doesn't resolve (dangling) shows
// nothing — same unconstrained-not-stale treatment as the other
// place-capacity consumers, not the display-affordance C5 gives the edit modal.
function placeNameFor(act, locMap) {
  return act?.location_id ? (locMap.get(act.location_id)?.name || null) : null
}

export default function ScheduleActivityView({
  activities, groups, days, timeBlocks, slots,
  locations = [],
  selectedActivity, onSelectActivity,
  // T55/T56. Collapse is per-route state, shared by every view of that route.
  collapsedBlockIds = NO_COLLAPSE,
  onToggleBlockCollapsed,
}) {
  const gridNav = useGridKeyboardNav()
  const locMap = new Map(locations.map(l => [l.id, l]))
  return (
    <div>
      {!selectedActivity ? (
        /* Card grid */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
          {activities.map((act) => {
            const color = activityColor(act.id)
            const totalSlots = slots.filter(s => s.activity_id === act.id).length
            const weeklyGroups = new Set(slots.filter(s => s.activity_id === act.id).map(s => s.group_id)).size
            const place = placeNameFor(act, locMap)
            return (
              <button
                key={act.id}
                onClick={() => onSelectActivity(act.id)}
                className="activity-card press-97"
                style={{
                  '--activity-color': color,
                  background: 'var(--surface)', border: `1px solid var(--border)`,
                  borderRadius: 8, padding: '14px 16px', textAlign: 'left',
                  cursor: 'pointer', transition: 'border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)',
                  borderTop: `4px solid ${color}`,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 6, lineHeight: 1.3 }}>{act.name}</div>
                {place && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>{place}</div>}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {act.priority === 'high' && (
                    <span style={S.chip(color, true, { fontSize: 10, borderRadius: 3, padding: '1px 6px', border: 'none', cursor: 'default' })}>HIGH</span>
                  )}
                  {act.is_outdoor && (
                    <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 600 }}>OUTDOOR</span>
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
          const act = activities.find(a => a.id === selectedActivity)
          const place = placeNameFor(act, locMap)
          const color = activityColor(selectedActivity)
          const gridTemplateColumns = columnTracks(days.length)
          const rowTracks = buildRowTracks({ timeBlocks, collapsedBlockIds })
          return (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <button className="press-97"
                  onClick={() => onSelectActivity(null)}
                  style={{ ...S.btnSecondary, padding: '5px 12px', fontSize: 12 }}
                >← All Activities</button>
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: color, display: 'inline-block' }} />
                <span style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 18, color: 'var(--text)' }}>{act?.name}</span>
                {place && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{place}</span>}
                {act?.priority === 'high' && <span style={S.chip(color, true, { fontSize: 11, borderRadius: 3, padding: '2px 8px', border: 'none', cursor: 'default' })}>HIGH PRIORITY</span>}
                {act?.is_outdoor && <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>OUTDOOR</span>}
              </div>

              <div style={{ overflowX: 'auto' }}>
                <div
                  role="grid"
                  className="schedule-grid-frame"
                  aria-rowcount={timeBlocks.length + 1}
                  aria-colcount={days.length + 1}
                  {...gridNav}
                >
                  <div role="rowgroup" className="schedule-grid schedule-grid--header" style={{ gridTemplateColumns }}>
                    <div role="row" aria-rowindex={1} style={{ display: 'contents' }}>
                      <div role="columnheader" className="cell row-header" aria-colindex={1} style={placeRowHeader({ blockIndex: 0 })}>Block</div>
                      {days.map((d, dayIndex) => (
                        <div
                          key={d.id}
                          role="columnheader"
                          className="cell"
                          aria-colindex={dayIndex + 2}
                          style={placeCell({ blockIndex: 0, columnIndex: dayIndex })}
                        >{d.label}</div>
                      ))}
                    </div>
                  </div>

                  <div
                    role="rowgroup"
                    className="schedule-grid schedule-grid--body"
                    style={{ gridTemplateColumns, '--grid-rows': rowTracks }}
                  >
                    {timeBlocks.map((block, blockIndex) => {
                      const isCollapsed = collapsedBlockIds.has(block.id)
                      const toggle = () => onToggleBlockCollapsed?.(block.id)
                      return (
                        <div
                          key={block.id}
                          role="row"
                          aria-rowindex={blockIndex + 2}
                          style={{ display: 'contents' }}
                        >
                          <div
                            role="rowheader"
                            className="cell row-header"
                            aria-colindex={1}
                            data-collapsed={isCollapsed ? '' : undefined}
                            style={placeRowHeader({ blockIndex })}
                          >
                            <button
                              type="button"
                              className="row-header-toggle"
                              aria-expanded={!isCollapsed}
                              onClick={toggle}
                            >
                              <span className="block-name">{block.name}</span>
                              <span className="block-time">{block.start_time?.slice(0,5)}–{block.end_time?.slice(0,5)}</span>
                            </button>
                          </div>
                          {days.map((day, dayIndex) => {
                            const assigned = slots.filter(s => s.activity_id === selectedActivity && s.day_id === day.id && s.time_block_id === block.id)
                            return (
                              <div
                                key={day.id}
                                role="gridcell"
                                className="cell"
                                aria-colindex={dayIndex + 2}
                                data-cell-key={`${selectedActivity}|${day.id}|${block.id}`}
                                data-collapsed={isCollapsed ? '' : undefined}
                                // T59. This view's cells list the GROUPS doing
                                // this activity in that slot; an unassigned one
                                // announces as not scheduled, never as blank.
                                aria-label={cellAccessibleName({
                                  subject: assigned.length
                                    ? assigned.map(s => groups.find(g => g.id === s.group_id)?.name || 'Unknown group').join(', ')
                                    : 'Not scheduled',
                                  blockNames: blockNamesForSpan(timeBlocks, blockIndex),
                                  column: day.label,
                                })}
                                style={{
                                  ...placeCell({ blockIndex, columnIndex: dayIndex }),
                                  // Data-derived paint (the activity's own hue), so it stays inline.
                                  background: assigned.length ? `${color}12` : '',
                                  borderLeft: assigned.length ? `3px solid ${color}` : '3px solid transparent',
                                  cursor: 'default',
                                }}
                              >
                                {/* The .cell-inner wrapper is what makes T55's
                                    collapsed rules reach this view unchanged;
                                    --activity resets the painted box back to
                                    the bare table cell this replaces. */}
                                <div className="cell-inner cell-inner--activity">
                                  {assigned.map(s => {
                                    const g = groups.find(g => g.id === s.group_id)
                                    return (
                                      <div
                                        key={s.id}
                                        className="cell-name"
                                        style={{ '--cell-name-color': color, fontSize: 11 }}
                                      >
                                        {g?.name || '?'}
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )
        })()
      )}
    </div>
  )
}
