import { useDroppable } from '@dnd-kit/core'
import { S } from '../../styles/shared'
import SlotCell from './SlotCell'
import { emptyTd } from './slotCellConstants'

function EmptyDropCell({ groupId, dayId, blockId }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop-${groupId}-${dayId}-${blockId}`,
    data: { groupId, dayId, blockId },
  })
  return (
    <td
      ref={setNodeRef}
      style={{
        ...emptyTd,
        background: isOver ? 'color-mix(in srgb, var(--primary) 13%, transparent)' : 'transparent',
        border: isOver ? '2px dashed var(--primary)' : '1px dashed var(--border)',
        borderRadius: 6,
        minHeight: 40,
        transition: 'background 0.1s',
      }}
    />
  )
}

// DndContext lives in ScheduleScreen (for manual mode). This component is
// just the grid — group pills + droppable slot table.
export default function ManualBuildView({
  groups, days, timeBlocks,
  selectedGroup, onSelectGroup,
  actMap, anchorMap,
  isAnchorTail, getAnchorRowSpan,
  getSlot, onEditSlot,
  onExpandSlot, onSplitSlot,
  selectedSlotKeys, pasteMode, onCellSelect,
}) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      {/* Group pills */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {groups.map(g => (
          <button key={g.id} onClick={() => onSelectGroup(g.id)} style={{
            padding: '5px 12px', borderRadius: 20,
            border: `1.5px solid ${selectedGroup === g.id ? 'var(--primary)' : 'var(--border)'}`,
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

                    if (slot?.is_anchor && isAnchorTail(selectedGroup, day.id, block.id)) return null

                    if (slot?.is_anchor) {
                      const rowSpan = getAnchorRowSpan(selectedGroup, day.id, block.id)
                      const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
                      return (
                        <SlotCell
                          key={day.id}
                          rowSpan={rowSpan}
                          slot={{ ...slot, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id }}
                          anchor={anchor}
                          actColorIdx={0}
                          weatherMode={false}
                          onEdit={() => {}}
                          isDndEnabled={false}
                        />
                      )
                    }

                    if (slot?.activity_id) {
                      const act = actMap.get(slot.activity_id)
                      const slotKey = `${selectedGroup}|${day.id}|${block.id}`
                      const isMerged = Boolean(slot.flags?.expanded)
                      const isSelected = selectedSlotKeys?.has(slotKey) ?? false
                      const isMultiSelected = isSelected && (selectedSlotKeys?.size ?? 0) > 1
                      const nextBlock = timeBlocks.find(b => b.sort_order === block.sort_order + 1)
                      const nextSlot = nextBlock ? getSlot(selectedGroup, day.id, nextBlock.id) : null
                      const hasMergeDown = !isMerged && Boolean(nextBlock) && !nextSlot?.is_anchor && nextSlot?.is_span_head !== false
                      const onMergeDown = hasMergeDown && onExpandSlot ? () => {
                        const tailAct = nextSlot?.activity_id ? actMap.get(nextSlot.activity_id) : null
                        const dayObj = days.find(d => d.id === day.id)
                        onExpandSlot(selectedGroup, day.id, block.id, nextBlock.id, nextSlot?.activity_id ?? null, tailAct?.name ?? '', nextBlock.name, dayObj?.label ?? day.id)
                      } : undefined
                      const onSplit = isMerged && onSplitSlot ? () => onSplitSlot(selectedGroup, day.id, block.id) : undefined
                      return (
                        <SlotCell
                          key={day.id}
                          rowSpan={1}
                          slot={{ ...slot, type: 'activity', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                          activity={act}
                          actColorIdx={slot.activity_id}
                          weatherMode={false}
                          onEdit={s => onEditSlot(s)}
                          onSelect={onCellSelect}
                          isDndEnabled={true}
                          isSelected={isSelected}
                          isMultiSelected={isMultiSelected}
                          pasteMode={pasteMode}
                          hasMergeDown={hasMergeDown}
                          isMerged={isMerged}
                          onMergeDown={onMergeDown}
                          onSplitSlot={onSplit}
                        />
                      )
                    }

                    return (
                      <EmptyDropCell
                        key={day.id}
                        groupId={selectedGroup}
                        dayId={day.id}
                        blockId={block.id}
                      />
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>
        Drag activities from the left panel onto any open cell, or click a cell to pick one. An empty cell just isn’t filled yet.
      </div>
    </div>
  )
}
