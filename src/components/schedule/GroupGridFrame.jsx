import { buildRowTracks, columnTracks } from '../../screens/schedule/gridTracks'
import { placeCell, placeRowHeader } from '../../screens/schedule/gridPlacement'
import { rowFlagKind, ROW_FLAG_TITLE } from '../../screens/schedule/rowFlags'
import useGridKeyboardNav from './useGridKeyboardNav'
import ReplacedLane, { ReplacedColumnHeader } from './ReplacedLane'
import { S } from '../../styles/shared'
import './scheduleGrid.css'
import BlockRowLabel from './BlockRowLabel'

const NO_COLLAPSE = new Set()
const NO_REPLACEMENTS = new Map()

// Design F4. The one frame both group views draw — Generated (ScheduleGroupView)
// and Manual (ManualBuildView): group pills, the role="grid" frame, the day
// header row, the collapsible row headers and the collapsed-row flag dot. The
// routes differ only in what goes in a cell, so that is the one thing they pass:
// renderCell(ctx) returns the cell element, or null for a span tail.
export default function GroupGridFrame({
  groups, days, timeBlocks, selectedGroup, onSelectGroup, geometry,
  // T55. Collapse is two concerns: the TRACK (the row string on the container)
  // and the CONTENT PRESENTATION (data-collapsed on the row's cells, styled by
  // scheduleGrid.css). Neither implies the other, which is why both are written.
  collapsedBlockIds = NO_COLLAPSE,
  onToggleBlockCollapsed,
  renderCell,
  // T350 slice 4: dayId -> replacement. A replaced day is one read-only lane,
  // the same on both routes, so the frame draws it rather than renderCell.
  replacements = NO_REPLACEMENTS,
  actMap,
  onOpenSpecialDay,
}) {
  const allReplaced = days.length > 0 && days.every(d => replacements.has(d.id))
  const rowTracks = allReplaced ? 'minmax(200px, auto)' : buildRowTracks({ timeBlocks, collapsedBlockIds })
  const rowCells = days.filter(d => !replacements.has(d.id)).map(d => ({ groupId: selectedGroup, dayId: d.id }))
  const gridTemplateColumns = columnTracks(days.length, { rowHeader: !allReplaced })
  const colOffset = allReplaced ? 1 : 2
  const place = dayIndex => ({ gridRow: '1 / span 1', gridColumn: `${dayIndex + colOffset} / span 1` })
  const gridNav = useGridKeyboardNav()

  return (
    <div className="schedule-view-enter" style={{ flex: 1, minWidth: 0 }}>
      <div style={{ ...S.centeredRow, gap: 8, marginBottom: 16 }}>
        {groups.map(g => (
          <button key={g.id} onClick={() => onSelectGroup(g.id)} className="press-98" style={S.chip('var(--primary)', selectedGroup === g.id, { fontSize: 12, fontFamily: 'var(--font-sans)' })}>{g.name}</button>
        ))}
      </div>

      {selectedGroup && (
        <div style={{ overflowX: 'auto' }}>
          {/* role="grid" sits on the frame; the two role="rowgroup" children
              are the CSS Grid containers. Two rather than one because
              --grid-rows carries a track per TIME BLOCK and placeCell maps
              blockIndex 0 -> row line 1: a day-header row in the same container
              would consume a block's track and force a +1 offset into every
              call site. Both share one column template, so their tracks align. */}
          <div
            role="grid"
            className="schedule-grid-frame"
            aria-rowcount={timeBlocks.length + 1}
            aria-colcount={days.length + (allReplaced ? 0 : 1)}
            data-all-replaced={allReplaced ? '' : undefined}
            {...gridNav}
          >
            <div role="rowgroup" className="schedule-grid schedule-grid--header" style={{ gridTemplateColumns }}>
              <div role="row" aria-rowindex={1} style={{ display: 'contents' }}>
                {!allReplaced && <div role="columnheader" className="cell row-header" aria-colindex={1} style={placeRowHeader({ blockIndex: 0 })}>Block</div>}
                {days.map((d, dayIndex) => replacements.has(d.id) ? (
                  <ReplacedColumnHeader
                    key={d.id}
                    label={d.label}
                    replacement={replacements.get(d.id)}
                    ariaColIndex={dayIndex + colOffset}
                    style={place(dayIndex)}
                    onOpenSpecialDay={onOpenSpecialDay}
                  />
                ) : (
                  <div
                    key={d.id}
                    role="columnheader"
                    className="cell"
                    aria-colindex={dayIndex + 2}
                    style={{ ...placeCell({ blockIndex: 0, columnIndex: dayIndex }), position: 'relative' }}
                  >
                    {d.label}
                  </div>
                ))}
              </div>
            </div>

            <div
              role="rowgroup"
              className="schedule-grid schedule-grid--body"
              style={{ gridTemplateColumns, '--grid-rows': rowTracks }}
            >
              {days.map((d, dayIndex) => replacements.has(d.id) && (
                <ReplacedLane
                  key={`lane-${d.id}`}
                  replacement={replacements.get(d.id)}
                  subjectId={selectedGroup}
                  groupId={selectedGroup}
                  campBlockCount={allReplaced ? 1 : timeBlocks.length}
                  ariaColIndex={dayIndex + colOffset}
                  style={place(dayIndex)}
                  actMap={actMap}
                  onOpenSpecialDay={onOpenSpecialDay}
                />
              ))}
              {!allReplaced && timeBlocks.map((block, blockIndex) => {
                const isCollapsed = collapsedBlockIds.has(block.id)
                const flagKind = rowFlagKind(geometry, rowCells, block.id)
                const toggle = () => onToggleBlockCollapsed?.(block.id)
                return (
                  <div
                    key={block.id}
                    role="row"
                    aria-rowindex={blockIndex + 2}
                    style={{ display: 'contents' }}
                    // The whole 20px strip is the re-expand target — half of the
                    // accepted WCAG 2.5.8 deviation (the row header's
                    // aria-expanded button is the other half). Capture phase, so
                    // a click on a folded cell re-expands instead of opening its
                    // editor; the cell keeps every handler, nothing is unmounted.
                    onClickCapture={isCollapsed ? (e => { e.stopPropagation(); toggle() }) : undefined}
                  >
                    <div
                      role="rowheader"
                      className="cell row-header"
                      aria-colindex={1}
                      data-collapsed={isCollapsed ? '' : undefined}
                      style={placeRowHeader({ blockIndex })}
                    >
                      {/* A real <button>: Enter and Space come free, and that
                          keyboard path is what makes the 20px target's deviation
                          an accepted equivalent mechanism. */}
                      <button
                        type="button"
                        className="row-header-toggle"
                        aria-expanded={!isCollapsed}
                        onClick={toggle}
                      >
                        <svg className="row-header-chevron" aria-hidden="true" width="10" height="10" viewBox="0 0 10 10">
                          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <BlockRowLabel block={block} />
                      </button>
                    </div>
                    {days.map((day, dayIndex) => !replacements.has(day.id) && renderCell({
                      day, dayIndex, block, blockIndex, isCollapsed,
                      ariaColIndex: dayIndex + 2,
                      cellKey: `${selectedGroup}|${day.id}|${block.id}`,
                    }))}
                    {/* Always mounted, shown by CSS only when the row is both
                        collapsed and flagged — so toggling collapse stays an
                        attribute write. Decorative: every flagged cell keeps its
                        own title and glyph for a screen reader. */}
                    <div
                      className="row-flag-dot"
                      aria-hidden="true"
                      data-collapsed={isCollapsed ? '' : undefined}
                      data-flag={flagKind || undefined}
                      title={flagKind ? ROW_FLAG_TITLE[flagKind] : undefined}
                      style={placeCell({ blockIndex, columnIndex: days.length - 1 })}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
