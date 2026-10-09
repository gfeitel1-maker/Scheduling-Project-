// The one page both sub-grid editors render: Special Day (SpecialDayGridEditor)
// and Event (EventGridEditor). Back row + title, banners, toolbar with the
// filled count, the group × block grid with editable block rows, and a footer
// with Print (and the special day's notes). The editors keep their data and
// writes; this owns only what they had duplicated, so the two pages look alike.
import { useState } from 'react'
import { S } from '../../styles/shared'
import { ArrowIcon, CloseIcon } from '../icons'
import { buildRowTracks, columnTracks } from '../../screens/schedule/gridTracks'
import { placeCell, placeRowHeader } from '../../screens/schedule/gridPlacement'
import { timeRangeLabel } from '../../utils/timeBlockLabel'
import './scheduleGrid.css'

export default function GridEditorFrame({
  enterStyle, onBack, backLabel, title, meta, banners,
  toolbarActions, groups, timeBlocks, filledCount, totalCells,
  empty, renderColumnHeader, renderCell,
  onMoveBlock, onRenameBlock, onRemoveBlock,
  footerLabel, onPrint, printLabel, children,
}) {
  const rowTracks = buildRowTracks({ timeBlocks })
  const gridTemplateColumns = columnTracks(groups.length)

  return (
    <div style={enterStyle}>
      <div className="back-row" style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <button className="press-97" onClick={onBack} style={S.backBar}>{backLabel}</button>
        {title}
      </div>

      {meta}

      {banners}

      <div className="grid-toolbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{toolbarActions}</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
          {groups.length} group{groups.length !== 1 ? 's' : ''} × {timeBlocks.length} block{timeBlocks.length !== 1 ? 's' : ''} — {filledCount} / {totalCells} filled
        </div>
      </div>

      {empty ?? (
        <div style={{ overflowX: 'auto' }}>
          <div role="grid" className="schedule-grid-frame" aria-rowcount={timeBlocks.length + 1} aria-colcount={groups.length + 1}>
            <div role="rowgroup" className="schedule-grid schedule-grid--header" style={{ gridTemplateColumns }}>
              <div role="row" style={{ display: 'contents' }}>
                <div role="columnheader" className="cell row-header" aria-colindex={1} style={placeRowHeader({ blockIndex: 0 })}>Block</div>
                {groups.map((g, groupIndex) => (
                  <div key={g.id} role="columnheader" className="cell" aria-colindex={groupIndex + 2}
                    style={placeCell({ blockIndex: 0, columnIndex: groupIndex })}>
                    {renderColumnHeader ? renderColumnHeader(g, groupIndex) : g.name}
                  </div>
                ))}
              </div>
            </div>

            <div role="rowgroup" className="schedule-grid schedule-grid--body" style={{ gridTemplateColumns, '--grid-rows': rowTracks }}>
              {timeBlocks.map((block, blockIndex) => (
                <div key={block.id} role="row" style={{ display: 'contents' }}>
                  <div role="rowheader" className="cell row-header" aria-colindex={1} style={placeRowHeader({ blockIndex })}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%' }}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <button type="button" className="cell-action" title="Move up" onClick={() => onMoveBlock(block.id, -1)} disabled={blockIndex === 0}><ArrowIcon direction="up" /></button>
                        <button type="button" className="cell-action" title="Move down" onClick={() => onMoveBlock(block.id, 1)} disabled={blockIndex === timeBlocks.length - 1}><ArrowIcon direction="down" /></button>
                      </div>
                      <InlineName name={block.name} sub={timeRangeLabel(block)} onRename={(name) => onRenameBlock(block.id, name)} />
                      <button type="button" className="cell-action" title="Remove block" onClick={() => onRemoveBlock(block.id)} style={{ color: 'var(--danger)' }}><CloseIcon size={10} /></button>
                    </div>
                  </div>
                  {groups.map((g, groupIndex) => renderCell(g, block, groupIndex, blockIndex))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: children ? 8 : 0 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>
            {footerLabel}
          </div>
          <button className="press-97" onClick={onPrint} style={S.btnSecondary}>{printLabel}</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// Click-to-rename label for a block row header or an event group column header.
export function InlineName({ name, sub, onRename }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  function startEditing() {
    setDraft(name)
    setEditing(true)
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); onRename(draft) }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        style={{ ...S.input, fontSize: 12, padding: '2px 6px', flex: 1 }}
      />
    )
  }
  return (
    <span className="block-name" onClick={startEditing} style={{ cursor: 'text', flex: 1, borderBottom: '1px dotted var(--border)' }}>
      {name}
      {sub && (
        <span style={{ display: 'block', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
          {sub}
        </span>
      )}
    </span>
  )
}
