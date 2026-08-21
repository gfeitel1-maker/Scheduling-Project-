// T106 (docs/work/tickets/T106-special-day-author-ui.md;
// docs/work/specs/2026-08-21-special-day-author-ui-design.md;
// docs/work/specs/2026-08-21-special-day-author-ui-designer-spec.md §2).
//
// Grid editor sub-view: groups (ALL the camp's groups, no cohort filter — a
// special day is camp-wide) x the special day's OWN time blocks
// (special_day_time_blocks) -> special_day_slots cells. Reuses the generic
// SlotCell/EmptyCell/CellInlineEditor leaf layer and gridPlacement/gridTracks
// geometry from the weekly schedule grid (design doc approach C) — no new
// grid-rendering primitive. The special-day placement writer writes
// special_day_slots.activity_id DIRECTLY, never placeActivityManual, which
// is schedule_templates-specific (this is the one seam Red Hat should check).
import { useEffect, useRef, useState } from 'react'
import { localClient } from '../../localClient'
import { describeWriteFailure } from '../../utils/writeErrorMessage'
import { S, useEnterTransition } from '../../styles/shared'
import { createActivity } from '../schedule/createActivityHelper'
import { buildRowTracks, columnTracks } from '../schedule/gridTracks'
import { placeCell, placeRowHeader } from '../schedule/gridPlacement'
import { blockNamesForSpan } from '../../components/schedule/cellLabel'
import SpecialDayCell from './SpecialDayCell'
import '../../components/schedule/scheduleGrid.css'

const LABELS = {
  backLink: '← Back to Special Days',
  addBlock: '+ Add Block',
  notesLabel: 'Notes',
  printAction: 'Print',
  locationPlaceholder: '— No location —',
  locationAddHint: '+ location',
  emptyBlocksTitle: 'No time blocks yet.',
  emptyBlocksBody: "Add your first block, or go back and seed from your camp's regular time blocks.",
  deletedElsewhere: 'This special day was deleted.',
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

export default function SpecialDayGridEditor({ campId, specialDayId, onBack, onDeletedElsewhere }) {
  const [specialDay, setSpecialDay] = useState(null)
  const [timeBlocks, setTimeBlocks] = useState([])
  const [slots, setSlots] = useState([])
  const [groups, setGroups] = useState([])
  const [activities, setActivities] = useState([])
  const [locations, setLocations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState('')
  const enterStyle = useEnterTransition('liftFade')
  const notesPrintRef = useRef(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [days, blocks, slotsData, groupsData, actsData, locsData] = await Promise.all([
        localClient.list('special_days'),
        localClient.list('special_day_time_blocks'),
        localClient.list('special_day_slots'),
        localClient.list('groups'),
        localClient.list('activities'),
        localClient.list('locations'),
      ])
      const day = (days || []).find((d) => d.id === specialDayId)
      if (!day) {
        onDeletedElsewhere?.()
        return
      }
      setSpecialDay(day)
      setNameDraft(day.name || '')
      setNotesDraft(day.notes || '')
      setTimeBlocks(
        (blocks || [])
          .filter((b) => b.special_day_id === specialDayId)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      )
      setSlots((slotsData || []).filter((s) => s.special_day_id === specialDayId))
      // ALL camp groups, no cohort filter — a special day is a camp-wide event
      // (design doc §5, Governor decision 5).
      setGroups(
        (groupsData || [])
          .filter((g) => g.camp_id === campId)
          .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
      )
      setActivities((actsData || []).filter((a) => a.camp_id === campId))
      setLocations(
        (locsData || [])
          .filter((l) => l.camp_id === campId)
          .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
      )
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [specialDayId])

  useEffect(() => {
    function beforePrint() {
      if (notesPrintRef.current) notesPrintRef.current.textContent = notesDraft
    }
    window.addEventListener('beforeprint', beforePrint)
    return () => window.removeEventListener('beforeprint', beforePrint)
  }, [notesDraft])

  const activityMap = new Map(activities.map((a) => [a.id, a]))
  const locationMap = new Map(locations.map((l) => [l.id, l]))
  const slotFor = (groupId, blockId) =>
    slots.find((s) => s.group_id === groupId && s.time_block_id === blockId)

  const filledCount = slots.filter((s) => s.activity_id).length
  const totalCells = groups.length * timeBlocks.length

  async function commitName() {
    setEditingName(false)
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === specialDay.name) { setNameDraft(specialDay.name); return }
    try {
      await writeField('special_days', specialDayId, 'name', trimmed)
      setSpecialDay((d) => ({ ...d, name: trimmed }))
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not rename this special day.'))
      setNameDraft(specialDay.name)
    }
  }

  async function commitNotes(value) {
    try {
      await writeField('special_days', specialDayId, 'notes', value)
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not save your notes.'))
    }
  }

  async function addBlock() {
    const id = crypto.randomUUID()
    const sortOrder = timeBlocks.length
    try {
      await writeField('special_day_time_blocks', id, 'special_day_id', specialDayId)
      await writeField('special_day_time_blocks', id, 'name', 'New Block')
      await writeField('special_day_time_blocks', id, 'sort_order', sortOrder)
      setTimeBlocks((prev) => [...prev, { id, special_day_id: specialDayId, name: 'New Block', sort_order: sortOrder }])
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not add a time block.'))
    }
  }

  async function renameBlock(blockId, name) {
    const trimmed = name.trim() || 'Block'
    try {
      await writeField('special_day_time_blocks', blockId, 'name', trimmed)
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
      await writeField('special_day_time_blocks', a.id, 'sort_order', b.sort_order)
      await writeField('special_day_time_blocks', b.id, 'sort_order', a.sort_order)
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
        await localClient.deleteEntity(token, 'special_day_slots', s.id)
      }
      await localClient.deleteEntity(token, 'special_day_time_blocks', blockId)
      setTimeBlocks((prev) => prev.filter((b) => b.id !== blockId))
      setSlots((prev) => prev.filter((s) => s.time_block_id !== blockId))
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not remove that block.'))
    }
  }

  // The special-day placement path: writes special_day_slots.activity_id
  // DIRECTLY via the generic per-field write path. Deliberately NOT
  // placeActivityManual (schedule_templates-specific) — never touches
  // template_slots/schedule_templates.
  async function placeActivity(groupId, blockId, activityId) {
    const existing = slotFor(groupId, blockId)
    const id = existing?.id ?? crypto.randomUUID()
    try {
      if (!existing) {
        await writeField('special_day_slots', id, 'special_day_id', specialDayId)
        await writeField('special_day_slots', id, 'group_id', groupId)
        await writeField('special_day_slots', id, 'time_block_id', blockId)
      }
      await writeField('special_day_slots', id, 'activity_id', activityId)
      setSlots((prev) => {
        if (existing) return prev.map((s) => (s.id === id ? { ...s, activity_id: activityId } : s))
        return [...prev, { id, special_day_id: specialDayId, group_id: groupId, time_block_id: blockId, activity_id: activityId, location_id: null }]
      })
    } catch (err) {
      if (/not.?found|tombstone/i.test(err?.message ?? '')) { onDeletedElsewhere?.(); return }
      setError(describeWriteFailure(err, 'Could not place that activity.'))
    }
  }

  async function createAndPlace(groupId, blockId, name) {
    try {
      const { activityId, activity, isNew } = await createActivity(
        { name, groupId, campId, activities },
        repo
      )
      if (isNew) setActivities((prev) => [...prev, activity])
      await placeActivity(groupId, blockId, activityId)
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not create that activity.'))
    }
  }

  async function changeLocation(slotRow, locationId) {
    const id = slotRow.id
    try {
      await writeField('special_day_slots', id, 'location_id', locationId)
      setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, location_id: locationId } : s)))
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not set that location.'))
    }
  }

  function doPrint() {
    window.print()
  }

  if (loading) return <div style={S.stateLoading}>Loading…</div>
  if (!specialDay) return null

  const rowTracks = buildRowTracks({ timeBlocks })
  const gridTemplateColumns = columnTracks(groups.length)

  return (
    <div style={enterStyle}>
      <div className="back-row" style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <button className="press-97" onClick={onBack} style={S.btnSecondary}>{LABELS.backLink}</button>
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === 'Enter' && commitName()}
            style={{ ...S.input, fontSize: 16, fontWeight: 700, maxWidth: 320 }}
          />
        ) : (
          <div
            onClick={() => setEditingName(true)}
            style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18, cursor: 'text' }}
          >
            {specialDay.name}
          </div>
        )}
      </div>

      {error && <div style={S.errorBanner}>{error}</div>}

      <div className="grid-toolbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <button className="press-97" onClick={addBlock} style={S.btnSecondary}>{LABELS.addBlock}</button>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
          {groups.length} group{groups.length !== 1 ? 's' : ''} × {timeBlocks.length} block{timeBlocks.length !== 1 ? 's' : ''} — {filledCount} / {totalCells} filled
        </div>
      </div>

      {timeBlocks.length === 0 ? (
        <div style={S.emptyState}>
          <div style={S.emptyStateTitle}>{LABELS.emptyBlocksTitle}</div>
          <div style={S.emptyStateBody}>{LABELS.emptyBlocksBody}</div>
          <button className="press-97" onClick={addBlock} style={{ ...S.btnPrimary, marginTop: 12 }}>{LABELS.addBlock}</button>
        </div>
      ) : groups.length === 0 ? (
        <div style={S.emptyState}>
          <div style={S.emptyStateTitle}>No groups yet.</div>
          <div style={S.emptyStateBody}>Add groups in Camp Set Up before building this special day's grid.</div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div role="grid" className="schedule-grid-frame" aria-rowcount={timeBlocks.length + 1} aria-colcount={groups.length + 1}>
            <div role="rowgroup" className="schedule-grid schedule-grid--header" style={{ gridTemplateColumns }}>
              <div role="row" style={{ display: 'contents' }}>
                <div role="columnheader" className="cell row-header" aria-colindex={1} style={placeRowHeader({ blockIndex: 0 })}>Block</div>
                {groups.map((g, groupIndex) => (
                  <div key={g.id} role="columnheader" className="cell" aria-colindex={groupIndex + 2}
                    style={placeCell({ blockIndex: 0, columnIndex: groupIndex })}>{g.name}</div>
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
                  {groups.map((g, groupIndex) => {
                    const slotRow = slotFor(g.id, block.id)
                    return (
                      <SpecialDayCell
                        key={g.id}
                        slotRow={slotRow}
                        activity={slotRow?.activity_id ? activityMap.get(slotRow.activity_id) ?? null : null}
                        location={slotRow?.location_id ? locationMap.get(slotRow.location_id) ?? null : null}
                        groupId={g.id}
                        blockId={block.id}
                        specialDayId={specialDayId}
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

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>
            {LABELS.notesLabel}
          </div>
          <button className="press-97" onClick={doPrint} style={S.btnSecondary}>{LABELS.printAction}</button>
        </div>
        <textarea
          className="notes-field"
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          onBlur={(e) => commitNotes(e.target.value)}
          placeholder="Team rosters, station staffing, points, trip times…"
          style={{
            width: '100%', minHeight: 140, resize: 'vertical', fontFamily: 'var(--font-sans)',
            fontSize: 13, padding: '10px 12px', border: '1px solid var(--border)',
            borderRadius: 8, background: 'var(--surface)',
          }}
        />
        {/* Print-only mirror: a <textarea>'s scroll overflow does not print in
            most browsers, so beforeprint copies the live value into this
            plain read-only div (design spec §2 "Print"). */}
        <div ref={notesPrintRef} className="notes-print-view" style={{ display: 'none' }} />
      </div>

      <div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid var(--border)', textAlign: 'right' }}>
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
