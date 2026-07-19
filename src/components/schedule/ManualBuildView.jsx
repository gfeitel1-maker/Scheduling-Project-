import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { useDroppable } from '@dnd-kit/core'
import { S } from '../../styles/shared'
import ActivityPalette from './ActivityPalette'
import SlotCell, { emptyTd } from './SlotCell'

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
        background: isOver ? 'var(--primary)22' : 'transparent',
        border: isOver ? '2px dashed var(--primary)' : '1px dashed var(--border)',
        borderRadius: 6,
        minHeight: 40,
        transition: 'background 0.1s',
      }}
    />
  )
}

export default function ManualBuildView({
  groups, days, timeBlocks, activities, slots,
  selectedGroup, onSelectGroup,
  actMap, anchorMap,
  isAnchorTail, getAnchorRowSpan,
  getSlot, onPlaceActivity, onEditSlot,
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  function handleDragEnd({ active, over }) {
    if (!over) return
    const paletteAct = active.data.current?.paletteActivity
    if (!paletteAct) return
    const { groupId, dayId, blockId } = over.data.current || {}
    if (!groupId || !dayId || !blockId) return
    onPlaceActivity(paletteAct.id, groupId, dayId, blockId)
  }

  const groupSlots = slots.filter(s => s.group_id === selectedGroup)

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <ActivityPalette
          activities={activities}
          slots={groupSlots}
          selectedGroupId={selectedGroup}
        />

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

                        // Anchor tail — covered by head rowSpan, skip
                        if (slot?.is_anchor && isAnchorTail(selectedGroup, day.id, block.id)) return null

                        // Anchor head — render non-editable SlotCell
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

                        // Filled activity slot — render SlotCell (click to edit/clear)
                        if (slot?.activity_id) {
                          const act = actMap.get(slot.activity_id)
                          const colorIdx = activities.findIndex(a => a.id === slot.activity_id)
                          return (
                            <SlotCell
                              key={day.id}
                              rowSpan={1}
                              slot={{ ...slot, type: 'activity', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                              activity={act}
                              actColorIdx={colorIdx >= 0 ? colorIdx : 0}
                              weatherMode={false}
                              onEdit={s => onEditSlot(s)}
                              isDndEnabled={false}
                            />
                          )
                        }

                        // Open slot — droppable
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
            Drag activities from the left panel onto open slots. Flags appear on cells where constraints are violated.
          </div>
        </div>
      </div>
    </DndContext>
  )
}
