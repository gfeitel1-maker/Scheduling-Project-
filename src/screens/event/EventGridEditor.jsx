// Events internal sub-schedule Slice 2 (docs/adr/2026-08-22-event-internal-
// subschedule.md; docs/work/specs/2026-08-22-event-internal-subschedule-
// slices.md Step 4).
//
// Grid editor sub-view: structural mirror of SpecialDayGridEditor.jsx with
// `special_day` renamed to `event` throughout, PLUS the one real addition
// beyond a straight mirror — the grid COLUMNS are this event's OWN editable
// `event_groups` (not the camp's fixed `groups`), so both axes get the
// identical add/rename/reorder/remove quartet. Reuses the generic
// SlotCell/EmptyCell/CellInlineEditor leaf layer and gridPlacement/gridTracks
// geometry from the weekly schedule grid — no new grid-rendering primitive.
// The event placement writer writes event_slots.activity_id DIRECTLY, never
// placeActivityManual, which is schedule_templates-specific (this is the one
// seam Red Hat should check, doubled by event_group_id replacing group_id).
import { useEffect, useRef, useState } from 'react'
import { localClient } from '../../localClient'
import { describeWriteFailure } from '../../utils/writeErrorMessage'
import { S, useEnterTransition } from '../../styles/shared'
import { createActivity } from '../schedule/createActivityHelper'
import { buildRowTracks, columnTracks } from '../schedule/gridTracks'
import { placeCell, placeRowHeader } from '../schedule/gridPlacement'
import { blockNamesForSpan } from '../../components/schedule/cellLabel'
import EventCell from './EventCell'
import '../../components/schedule/scheduleGrid.css'

const LABELS = {
  backLink: '← Back to Event',
  addBlock: '+ Add Block',
  addGroup: '+ Add Group',
  notesLabel: 'Notes',
  printAction: 'Print',
  emptyBlocksTitle: 'No time blocks yet.',
  emptyBlocksBody: 'Add your first block and group to start building this schedule.',
  deletedElsewhere: 'This event was deleted.',
}

async function writeField(entity, id, field, value) {
  const token = localStorage.getItem('shoresh-token')
  const result = await localClient.write(token, entity, id, field, value)
  if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
    throw new Error(`write failed for field "${field}"`)
  }
  return result
}

const repo = {
  async writeActivityFields(activityId, fields) {
    for (const [field, value] of Object.entries(fields)) {
      await writeField('activities', activityId, field, value)
    }
  },
}

export default function EventGridEditor({ campId, eventId, onBack, onDeletedElsewhere }) {
  const [event, setEvent] = useState(null)
  const [timeBlocks, setTimeBlocks] = useState([])
  const [eventGroups, setEventGroups] = useState([])
  const [slots, setSlots] = useState([])
  const [activities, setActivities] = useState([])
  const [locations, setLocations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const enterStyle = useEnterTransition('liftFade')
  const seededEventIdsRef = useRef(new Set())

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [
        events, blocks, groupsData, slotsData, campGroups, campTimeBlocks, actsData, locsData,
      ] = await Promise.all([
        localClient.list('events'),
        localClient.list('event_time_blocks'),
        localClient.list('event_groups'),
        localClient.list('event_slots'),
        localClient.list('groups'),
        localClient.list('time_blocks'),
        localClient.list('activities'),
        localClient.list('locations'),
      ])
      const evt = (events || []).find((e) => e.id === eventId)
      if (!evt) {
        onDeletedElsewhere?.()
        return
      }
      setEvent(evt)

      let blocksForEvent = (blocks || [])
        .filter((b) => b.event_id === eventId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      let groupsForEvent = (groupsData || [])
        .filter((g) => g.event_id === eventId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

      // First-entry seed (ADR §4): when an event has zero event_time_blocks
      // AND zero event_groups, seed both axes once from the camp's current
      // time_blocks/groups — ordinary per-field writeField calls, not a
      // special import path. Independent per axis; no re-seed afterward.
      if (blocksForEvent.length === 0 && groupsForEvent.length === 0 && !seededEventIdsRef.current.has(eventId)) {
        seededEventIdsRef.current.add(eventId)
        const campBlocks = (campTimeBlocks || []).filter((b) => b.camp_id === campId)
        const camp_groups = (campGroups || []).filter((g) => g.camp_id === campId)
        const seededBlocks = []
        const seededGroups = []
        try {
          for (const b of campBlocks) {
            const id = crypto.randomUUID()
            await writeField('event_time_blocks', id, 'event_id', eventId)
            await writeField('event_time_blocks', id, 'name', b.name)
            await writeField('event_time_blocks', id, 'sort_order', b.sort_order ?? 0)
            if (b.start_time) await writeField('event_time_blocks', id, 'start_time', b.start_time)
            if (b.end_time) await writeField('event_time_blocks', id, 'end_time', b.end_time)
            seededBlocks.push({ id, event_id: eventId, name: b.name, sort_order: b.sort_order ?? 0, start_time: b.start_time ?? null, end_time: b.end_time ?? null })
          }
          for (const g of camp_groups) {
            const id = crypto.randomUUID()
            await writeField('event_groups', id, 'event_id', eventId)
            await writeField('event_groups', id, 'name', g.name)
            await writeField('event_groups', id, 'sort_order', g.sort_order ?? 0)
            seededGroups.push({ id, event_id: eventId, name: g.name, sort_order: g.sort_order ?? 0 })
          }
          blocksForEvent = seededBlocks
          groupsForEvent = seededGroups
        } catch (err) {
          setError(describeWriteFailure(err, 'Could not seed this schedule from your camp setup.'))
        }
      }

      setTimeBlocks(blocksForEvent)
      setEventGroups(groupsForEvent)
      setSlots((slotsData || []).filter((s) => s.event_id === eventId))
      setActivities((actsData || []).filter((a) => a.camp_id === campId))
      setLocations(
        (locsData || [])
          .filter((l) => l.camp_id === campId)
          .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
      )
    } catch {
      setError("Couldn't load your camp setup — check your connection and refresh.")
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [eventId])

  const onDeletedElsewhereRef = useRef(onDeletedElsewhere)
  useEffect(() => { onDeletedElsewhereRef.current = onDeletedElsewhere }, [onDeletedElsewhere])

  useEffect(() => {
    if (typeof localClient.onOpApplied !== 'function') return
    const unsub = localClient.onOpApplied((op) => {
      if (op?.entity === 'events' && op?.entity_id === eventId && op?.field === '__deleted__') {
        onDeletedElsewhereRef.current?.()
      }
    })
    return () => { unsub?.() }
  }, [eventId])

  const activityMap = new Map(activities.map((a) => [a.id, a]))
  const locationMap = new Map(locations.map((l) => [l.id, l]))
  const slotFor = (eventGroupId, blockId) =>
    slots.find((s) => s.event_group_id === eventGroupId && s.time_block_id === blockId)

  const filledCount = slots.filter((s) => s.activity_id).length
  const totalCells = eventGroups.length * timeBlocks.length

  // -- Row axis: event_time_blocks (verbatim port of SpecialDayGridEditor's
  //    addBlock/renameBlock/moveBlock/removeBlock, event_id replacing
  //    special_day_id). --
  async function addBlock() {
    const id = crypto.randomUUID()
    const sortOrder = timeBlocks.length
    try {
      await writeField('event_time_blocks', id, 'event_id', eventId)
      await writeField('event_time_blocks', id, 'name', 'New Block')
      await writeField('event_time_blocks', id, 'sort_order', sortOrder)
      setTimeBlocks((prev) => [...prev, { id, event_id: eventId, name: 'New Block', sort_order: sortOrder }])
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not add a time block.'))
    }
  }

  async function renameBlock(blockId, name) {
    const trimmed = name.trim() || 'Block'
    try {
      await writeField('event_time_blocks', blockId, 'name', trimmed)
      setTimeBlocks((prev) => prev.map((b) => (b.id === blockId ? { ...b, name: trimmed } : b)))
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not rename that block.'))
    }
  }

  async function moveBlock(blockId, direction) {
    const idx = timeBlocks.findIndex((b) => b.id === blockId)
    const swapIdx = idx + direction
    if (idx < 0 || swapIdx < 0 || swapIdx >= timeBlocks.length) return
    const a = timeBlocks[idx]
    const b = timeBlocks[swapIdx]
    try {
      await writeField('event_time_blocks', a.id, 'sort_order', b.sort_order)
      await writeField('event_time_blocks', b.id, 'sort_order', a.sort_order)
      const next = [...timeBlocks]
      next[idx] = { ...b }
      next[swapIdx] = { ...a }
      setTimeBlocks(next)
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not reorder that block.'))
    }
  }

  async function removeBlock(blockId) {
    const hasFilled = slots.some((s) => s.time_block_id === blockId && s.activity_id)
    if (hasFilled && !window.confirm('This block has filled cells. Remove it anyway?')) return
    try {
      const token = localStorage.getItem('shoresh-token')
      const blockSlots = slots.filter((s) => s.time_block_id === blockId)
      for (const s of blockSlots) {
        await localClient.deleteEntity(token, 'event_slots', s.id)
      }
      await localClient.deleteEntity(token, 'event_time_blocks', blockId)
      setTimeBlocks((prev) => prev.filter((b) => b.id !== blockId))
      setSlots((prev) => prev.filter((s) => s.time_block_id !== blockId))
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not remove that block.'))
    }
  }

  // -- Column axis: event_groups — new, SpecialDayGridEditor has no analogue.
  //    Structurally identical to the row quartet above. --
  async function addEventGroup() {
    const id = crypto.randomUUID()
    const sortOrder = eventGroups.length
    try {
      await writeField('event_groups', id, 'event_id', eventId)
      await writeField('event_groups', id, 'name', 'New Group')
      await writeField('event_groups', id, 'sort_order', sortOrder)
      setEventGroups((prev) => [...prev, { id, event_id: eventId, name: 'New Group', sort_order: sortOrder }])
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not add a group.'))
    }
  }

  async function renameEventGroup(groupId, name) {
    const trimmed = name.trim() || 'Group'
    try {
      await writeField('event_groups', groupId, 'name', trimmed)
      setEventGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g)))
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not rename that group.'))
    }
  }

  async function moveEventGroup(groupId, direction) {
    const idx = eventGroups.findIndex((g) => g.id === groupId)
    const swapIdx = idx + direction
    if (idx < 0 || swapIdx < 0 || swapIdx >= eventGroups.length) return
    const a = eventGroups[idx]
    const b = eventGroups[swapIdx]
    try {
      await writeField('event_groups', a.id, 'sort_order', b.sort_order)
      await writeField('event_groups', b.id, 'sort_order', a.sort_order)
      const next = [...eventGroups]
      next[idx] = { ...b }
      next[swapIdx] = { ...a }
      setEventGroups(next)
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not reorder that group.'))
    }
  }

  async function removeEventGroup(groupId) {
    const hasFilled = slots.some((s) => s.event_group_id === groupId && s.activity_id)
    if (hasFilled && !window.confirm('This group has filled cells. Remove it anyway?')) return
    try {
      const token = localStorage.getItem('shoresh-token')
      const groupSlots = slots.filter((s) => s.event_group_id === groupId)
      for (const s of groupSlots) {
        await localClient.deleteEntity(token, 'event_slots', s.id)
      }
      await localClient.deleteEntity(token, 'event_groups', groupId)
      setEventGroups((prev) => prev.filter((g) => g.id !== groupId))
      setSlots((prev) => prev.filter((s) => s.event_group_id !== groupId))
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not remove that group.'))
    }
  }

  // The event placement path: writes event_slots.activity_id DIRECTLY via
  // the generic per-field write path. Deliberately NOT placeActivityManual
  // (schedule_templates-specific) — never touches template_slots/
  // schedule_templates.
  async function placeActivity(eventGroupId, blockId, activityId) {
    const existing = slotFor(eventGroupId, blockId)
    const id = existing?.id ?? crypto.randomUUID()
    try {
      if (!existing) {
        await writeField('event_slots', id, 'event_id', eventId)
        await writeField('event_slots', id, 'event_group_id', eventGroupId)
        await writeField('event_slots', id, 'time_block_id', blockId)
      }
      await writeField('event_slots', id, 'activity_id', activityId)
      setSlots((prev) => {
        if (existing) return prev.map((s) => (s.id === id ? { ...s, activity_id: activityId } : s))
        return [...prev, { id, event_id: eventId, event_group_id: eventGroupId, time_block_id: blockId, activity_id: activityId, location_id: null }]
      })
    } catch (err) {
      if (/not.?found|tombstone/i.test(err?.message ?? '')) { onDeletedElsewhere?.(); return }
      setError(describeWriteFailure(err, 'Could not place that activity.'))
    }
  }

  async function createAndPlace(eventGroupId, blockId, name) {
    try {
      const { activityId, activity, isNew } = await createActivity(
        { name, groupId: eventGroupId, campId, activities },
        repo
      )
      if (isNew) setActivities((prev) => [...prev, activity])
      await placeActivity(eventGroupId, blockId, activityId)
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not create that activity.'))
    }
  }

  async function changeLocation(slotRow, locationId) {
    const id = slotRow.id
    try {
      await writeField('event_slots', id, 'location_id', locationId)
      setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, location_id: locationId } : s)))
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not set that location.'))
    }
  }

  function doPrint() {
    window.print()
  }

  if (loading) return <div style={S.stateLoading}>Loading…</div>
  if (!event) return null

  const rowTracks = buildRowTracks({ timeBlocks })
  const gridTemplateColumns = columnTracks(eventGroups.length)

  return (
    <div style={enterStyle}>
      <div className="back-row" style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <button className="press-97" onClick={onBack} style={S.btnSecondary}>{LABELS.backLink}</button>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18 }}>
          {event.name} — Internal schedule
        </div>
      </div>

      {error && <div style={S.errorBanner}>{error}</div>}

      <div className="grid-toolbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="press-97" onClick={addBlock} style={S.btnSecondary}>{LABELS.addBlock}</button>
          <button className="press-97" onClick={addEventGroup} style={S.btnSecondary}>{LABELS.addGroup}</button>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
          {eventGroups.length} group{eventGroups.length !== 1 ? 's' : ''} × {timeBlocks.length} block{timeBlocks.length !== 1 ? 's' : ''} — {filledCount} / {totalCells} filled
        </div>
      </div>

      {timeBlocks.length === 0 || eventGroups.length === 0 ? (
        <div style={S.emptyState}>
          <div style={S.emptyStateTitle}>{LABELS.emptyBlocksTitle}</div>
          <div style={S.emptyStateBody}>{LABELS.emptyBlocksBody}</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
            <button className="press-97" onClick={addBlock} style={S.btnPrimary}>{LABELS.addBlock}</button>
            <button className="press-97" onClick={addEventGroup} style={S.btnPrimary}>{LABELS.addGroup}</button>
          </div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div role="grid" className="schedule-grid-frame" aria-rowcount={timeBlocks.length + 1} aria-colcount={eventGroups.length + 1}>
            <div role="rowgroup" className="schedule-grid schedule-grid--header" style={{ gridTemplateColumns }}>
              <div role="row" style={{ display: 'contents' }}>
                <div role="columnheader" className="cell row-header" aria-colindex={1} style={placeRowHeader({ blockIndex: 0 })}>Block</div>
                {eventGroups.map((g, groupIndex) => (
                  <div key={g.id} role="columnheader" className="cell" aria-colindex={groupIndex + 2}
                    style={placeCell({ blockIndex: 0, columnIndex: groupIndex })}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%' }}>
                      <EventGroupName group={g} onRename={(name) => renameEventGroup(g.id, name)} />
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <button type="button" className="cell-action" title="Move left" onClick={() => moveEventGroup(g.id, -1)} disabled={groupIndex === 0}>◀</button>
                        <button type="button" className="cell-action" title="Move right" onClick={() => moveEventGroup(g.id, 1)} disabled={groupIndex === eventGroups.length - 1}>▶</button>
                      </div>
                      <button type="button" className="cell-action" title="Remove group" onClick={() => removeEventGroup(g.id)} style={{ color: 'var(--danger)' }}>×</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div role="rowgroup" className="schedule-grid schedule-grid--body" style={{ gridTemplateColumns, '--grid-rows': rowTracks }}>
              {timeBlocks.map((block, blockIndex) => (
                <div key={block.id} role="row" style={{ display: 'contents' }}>
                  <div role="rowheader" className="cell row-header" aria-colindex={1} style={placeRowHeader({ blockIndex })}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <button type="button" className="cell-action" title="Move up" onClick={() => moveBlock(block.id, -1)} disabled={blockIndex === 0}>▲</button>
                          <button type="button" className="cell-action" title="Move down" onClick={() => moveBlock(block.id, 1)} disabled={blockIndex === timeBlocks.length - 1}>▼</button>
                        </div>
                        <BlockName block={block} onRename={(name) => renameBlock(block.id, name)} />
                        <button type="button" className="cell-action" title="Remove block" onClick={() => removeBlock(block.id)} style={{ color: 'var(--danger)' }}>×</button>
                      </div>
                    </div>
                  </div>
                  {eventGroups.map((g, groupIndex) => {
                    const slotRow = slotFor(g.id, block.id)
                    return (
                      <EventCell
                        key={g.id}
                        slotRow={slotRow}
                        activity={slotRow?.activity_id ? activityMap.get(slotRow.activity_id) ?? null : null}
                        location={slotRow?.location_id ? locationMap.get(slotRow.location_id) ?? null : null}
                        eventGroupId={g.id}
                        blockId={block.id}
                        eventId={eventId}
                        ariaColIndex={groupIndex + 2}
                        blockNames={blockNamesForSpan(timeBlocks, blockIndex)}
                        column={g.name}
                        eligibleActivities={activities}
                        locations={locations}
                        onPlace={(_slot, activityId) => placeActivity(g.id, block.id, activityId)}
                        onCreateNew={(_slot, name) => createAndPlace(g.id, block.id, name)}
                        onLocationChange={changeLocation}
                        {...placeCell({ blockIndex, columnIndex: groupIndex })}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid var(--border)', textAlign: 'right' }}>
        <button className="press-97" onClick={doPrint} style={{ ...S.btnSecondary, marginRight: 8 }}>{LABELS.printAction}</button>
        <button className="press-97" onClick={onBack} style={S.btnPrimary}>{LABELS.backLink.replace('← ', '')}</button>
      </div>
    </div>
  )
}

function BlockName({ block, onRename }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(block.name)

  function startEditing() {
    setDraft(block.name)
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
    <span className="block-name" onClick={startEditing} style={{ cursor: 'text', flex: 1 }}>
      {block.name}
    </span>
  )
}

// Sibling to BlockName above, editing an event_groups' name (the column
// header) instead of an event_time_blocks' name (the row header).
function EventGroupName({ group, onRename }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(group.name)

  function startEditing() {
    setDraft(group.name)
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
    <span className="block-name" onClick={startEditing} style={{ cursor: 'text', flex: 1 }}>
      {group.name}
    </span>
  )
}
