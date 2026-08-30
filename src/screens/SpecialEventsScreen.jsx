// Unified Special Events hub (owner-approved 2026-08-29, docs/adr/2026-08-29-
// unify-special-events-screen.md; docs/work/tickets/T110-unify-special-
// events-screen.md). Replaces the separate EventScreen/SpecialDaysScreen rows
// in Sprouts with one create/manage surface: a card grid of special_days +
// events, click a card to open its detail. The Plants build surface
// (SpecialSchedulesScreen, route 'schedule:special') is UNCHANGED — this
// screen only authors name/notes/location and routes "Build →" there, same
// as the two screens it replaces did.
import { useEffect, useRef, useState } from 'react'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { useCrudScreen } from '../hooks/useCrudScreen'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { S, useEnterTransition } from '../styles/shared'
import { LocationPicker } from '../components/LocationPicker'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import CalmEmptyState from '../components/CalmEmptyState'
import { seedFailureMessage } from './specialDay/seedFailureMessage'

const repository = createSetupCrudRepository({ localClient })
const eventScopeFilter = (row, campId) => row.camp_id === campId

const LABELS = {
  emptyMessage: 'No special events yet.',
  addEventCta: '+ Event',
  addDayCta: '+ Special Day',
  seedPrompt: 'Special Day created. Start with your camp’s regular time blocks (you can edit them after), or start empty?',
  seedFromBlocks: 'Seed from Time Blocks',
  startEmpty: 'Start Empty',
  createdHint: (name) => `"${name}" created — build it from Special Schedules under Schedule.`,
}

async function writeField(entity, id, field, value) {
  const token = localStorage.getItem('shoresh-token')
  const result = await localClient.write(token, entity, id, field, value)
  if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
    throw new Error(`write failed for field "${field}"`)
  }
  return result
}

const fieldLabel = {
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-secondary)',
  marginBottom: 5,
  display: 'block',
}

const linkButtonStyle = {
  background: 'none', border: 'none', padding: 0, color: 'var(--primary)',
  fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
  textDecoration: 'underline',
}

// Read-only placement summary — query template_slots WHERE event_id, resolve
// day/block/group names, render as a plain list. Carried over from
// EventScreen.jsx unchanged.
function PlacementSummary({ eventId, placements, groups, days, timeBlocks }) {
  if (placements.length === 0) {
    return <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Not placed on the schedule yet.</div>
  }
  const groupName = (id) => groups.find((g) => g.id === id)?.name ?? '(deleted group)'
  const dayLabel = (id) => days.find((d) => d.id === id)?.label ?? '(deleted day)'
  const blockName = (id) => timeBlocks.find((b) => b.id === id)?.name ?? '(deleted period)'

  return (
    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
      {placements
        .filter((p) => p.event_id === eventId)
        .map((p) => (
          <li key={p.id}>
            {dayLabel(p.day_id)}, {groupName(p.group_id)}, {blockName(p.time_block_id)}
          </li>
        ))}
    </ul>
  )
}

// Event detail — carried over from EventScreen.jsx's EventDetail unchanged:
// editable name + notes (commit-on-blur), location picker, read-only
// PlacementSummary, "Build →" to the Plants build surface.
export function EventDetail({ event, role, placements, groups, days, timeBlocks, locations, onBack, onSave, onDelete, onCreateLocation, onUpdateLocationCapacity, onNavigate }) {
  const [name, setName] = useState(event.name)
  const [notes, setNotes] = useState(event.notes ?? '')
  const [locationId, setLocationId] = useState(event.location_id ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function commit(fields) {
    setSaving(true)
    setError(null)
    try {
      await onSave(event.id, fields)
    } catch {
      setError('That could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  function changeLocation(newLocationId) {
    setLocationId(newLocationId)
    commit({ location_id: newLocationId })
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <button className="press-97" onClick={onBack} style={{ ...S.btnSecondary, marginBottom: 14 }}>
        ← Back to Special Events
      </button>

      {error && <div style={S.errorBanner}>{error}</div>}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginBottom: 16 }}>
        <label style={fieldLabel}>Name</label>
        <input
          value={name}
          disabled={role !== 'admin'}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== event.name && commit({ name: name.trim() })}
          style={{ ...S.input, marginBottom: 12 }}
        />
        <label style={fieldLabel}>Notes</label>
        <textarea
          value={notes}
          disabled={role !== 'admin'}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (event.notes ?? '') && commit({ notes: notes.trim() || null })}
          rows={4}
          style={{ ...S.input, resize: 'vertical', fontFamily: 'inherit' }}
          placeholder="Teams, points, staffing, run-of-show — recorded and printed, never parsed."
        />
        <label style={fieldLabel}>Location (optional)</label>
        <LocationPicker value={locationId} locations={locations} onChange={changeLocation} onCreate={onCreateLocation} onUpdateCapacity={onUpdateLocationCapacity} />
        {saving && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>Saving…</div>}
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginBottom: 16 }}>
        <div style={S.sectionLabel}>Where this is placed</div>
        <PlacementSummary eventId={event.id} placements={placements} groups={groups} days={days} timeBlocks={timeBlocks} />
      </div>

      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
        <button
          className="press-97"
          onClick={() => onNavigate?.('schedule:special', { buildEventId: event.id })}
          style={linkButtonStyle}
        >
          Build this event's schedule from Special Schedules
        </button>
      </div>

      <button
        className="press-97"
        onClick={() => onDelete(event)}
        disabled={role !== 'admin'}
        title={role !== 'admin' ? 'Admin only' : undefined}
        style={role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
      >
        Delete Event
      </button>
    </div>
  )
}

// Special day detail — the analogous editable-name + notes + "Build →" card,
// mirroring EventDetail but pointing at { type: 'day', id } for the Plants
// build surface (matches SpecialDaysScreen's old "Open" action's focus
// shape).
function SpecialDayDetail({ day, role, onBack, onSave, onDelete, onNavigate }) {
  const [name, setName] = useState(day.name)
  const [notes, setNotes] = useState(day.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function commit(fields) {
    setSaving(true)
    setError(null)
    try {
      await onSave(day.id, fields)
    } catch {
      setError('That could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <button className="press-97" onClick={onBack} style={{ ...S.btnSecondary, marginBottom: 14 }}>
        ← Back to Special Events
      </button>

      {error && <div style={S.errorBanner}>{error}</div>}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginBottom: 16 }}>
        <label style={fieldLabel}>Name</label>
        <input
          value={name}
          disabled={role !== 'admin'}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== day.name && commit({ name: name.trim() })}
          style={{ ...S.input, marginBottom: 12 }}
        />
        <label style={fieldLabel}>Notes</label>
        <textarea
          value={notes}
          disabled={role !== 'admin'}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (day.notes ?? '') && commit({ notes: notes.trim() || null })}
          rows={4}
          style={{ ...S.input, resize: 'vertical', fontFamily: 'inherit' }}
          placeholder="Run-of-show, staffing, anything worth recording — never parsed."
        />
        {saving && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>Saving…</div>}
      </div>

      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
        <button
          className="press-97"
          onClick={() => onNavigate?.('schedule:special', { specialDayId: day.id })}
          style={linkButtonStyle}
        >
          Build this day's schedule from Special Schedules
        </button>
      </div>

      <button
        className="press-97"
        onClick={() => onDelete(day)}
        disabled={role !== 'admin'}
        title={role !== 'admin' ? 'Admin only' : undefined}
        style={role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
      >
        Delete Special Day
      </button>
    </div>
  )
}

export default function SpecialEventsScreen({ campId, role, initialFocus = null, onNavigate }) {
  // Events — same useCrudScreen seam EventScreen.jsx used.
  const { rows: events, save: saveEvent, add: addEvent } = useCrudScreen({
    entity: 'events',
    campId,
    localClient,
    repository,
    scopeFilter: eventScopeFilter,
    buildCreateFields: ({ name }) => ({ name, camp_id: campId }),
    addFailedText: 'That event could not be added.',
    saveFailedText: 'That event could not be saved.',
  })

  // Special days — hand-rolled load/create, carried over from
  // SpecialDaysScreen.jsx (its seed-from-time-blocks prompt needs its own
  // write sequencing that useCrudScreen doesn't model).
  const [days, setDays] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [seedPromptForId, setSeedPromptForId] = useState(null)
  const [toast, setToast] = useState(null)

  const [selected, setSelected] = useState(initialFocus)
  const [supportData, setSupportData] = useState({ placements: [], groups: [], daysOfOp: [], timeBlocks: [], locations: [] })
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const [addingEvent, setAddingEvent] = useState(false)
  const [addingDay, setAddingDay] = useState(false)
  const [newEventName, setNewEventName] = useState('')
  const [newDayName, setNewDayName] = useState('')
  const eventNameRef = useRef()
  const dayNameRef = useRef()
  const enterStyle = useEnterTransition('liftFade')

  async function loadDays() {
    setLoading(true)
    setError(null)
    try {
      const daysData = await localClient.list('special_days')
      // Alphabetical, matching the retired SpecialDaysScreen's load sort — a
      // director scans this list by name (Red Hat, 2026-08-29).
      setDays((daysData || [])
        .filter((d) => d.camp_id === campId)
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''))))
    } catch {
      setError("Couldn't load your camp setup — check your connection and refresh.")
    } finally {
      setLoading(false)
    }
  }

  async function loadSupportData() {
    const [slots, groups, daysOfOp, timeBlocks, locations] = await Promise.all([
      localClient.list('template_slots'),
      localClient.list('groups'),
      localClient.list('days_of_operation'),
      localClient.list('time_blocks'),
      localClient.list('locations'),
    ])
    setSupportData({
      placements: (slots || []).filter((s) => s.event_id),
      groups: groups || [],
      daysOfOp: daysOfOp || [],
      timeBlocks: timeBlocks || [],
      locations: (locations || []).filter((l) => l.camp_id === campId),
    })
  }

  useEffect(() => {
    ;(async () => { await Promise.all([loadDays(), loadSupportData()]) })()
  }, [campId])

  useEffect(() => {
    if (initialFocus) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelected(initialFocus)
    }
  }, [initialFocus])

  async function createEvent() {
    if (!newEventName.trim()) return
    const succeeded = await addEvent({ name: newEventName.trim() })
    if (succeeded) { setNewEventName(''); setAddingEvent(false) }
  }

  async function createDay() {
    const trimmed = newDayName.trim()
    if (!trimmed) return
    const id = crypto.randomUUID()
    try {
      await writeField('special_days', id, 'name', trimmed)
      setDays((prev) => [...prev, { id, camp_id: campId, name: trimmed }])
      setNewDayName('')
      setAddingDay(false)
      setSeedPromptForId(id)
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not create that special day.'))
    }
  }

  async function seedFromCampTimeBlocks(specialDayId) {
    let seededCount = 0
    let totalCount = 0
    try {
      const campBlocks = await localClient.list('time_blocks')
      const scoped = (campBlocks || [])
        .filter((b) => b.camp_id === campId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      totalCount = scoped.length
      for (const b of scoped) {
        const newId = crypto.randomUUID()
        await writeField('special_day_time_blocks', newId, 'special_day_id', specialDayId)
        await writeField('special_day_time_blocks', newId, 'name', b.name)
        await writeField('special_day_time_blocks', newId, 'sort_order', b.sort_order ?? 0)
        if (b.start_time) await writeField('special_day_time_blocks', newId, 'start_time', b.start_time)
        if (b.end_time) await writeField('special_day_time_blocks', newId, 'end_time', b.end_time)
        seededCount += 1
      }
      setToast(LABELS.createdHint(days.find((d) => d.id === specialDayId)?.name ?? 'Special Day'))
    } catch (err) {
      setError(describeWriteFailure(err, seedFailureMessage(seededCount, totalCount)))
    } finally {
      setSeedPromptForId(null)
      await loadDays()
    }
  }

  function startEmpty(specialDayId) {
    setSeedPromptForId(null)
    setToast(LABELS.createdHint(days.find((d) => d.id === specialDayId)?.name ?? 'Special Day'))
  }

  async function saveDay(id, fields) {
    try {
      await Promise.all(Object.entries(fields).map(([field, value]) => writeField('special_days', id, field, value)))
      setDays((prev) => prev.map((d) => (d.id === id ? { ...d, ...fields } : d)))
    } catch (err) {
      setError(describeWriteFailure(err, 'That special day could not be saved.'))
      throw err
    }
  }

  async function createLocation(name) {
    const trimmedName = String(name ?? '').trim()
    if (!trimmedName) return null
    const existing = supportData.locations.find((l) => String(l.name ?? '').trim().toLowerCase() === trimmedName.toLowerCase())
    if (existing) return existing.id
    const newId = crypto.randomUUID()
    const fields = { name: trimmedName, camp_id: campId, capacity: 1, notes: null }
    await repository.createRecord('locations', newId, fields)
    setSupportData((prev) => ({ ...prev, locations: [...prev.locations, { id: newId, ...fields }] }))
    return newId
  }

  async function updateLocationCapacity(locationId, capacity) {
    await repository.writeFields('locations', locationId, { capacity })
    setSupportData((prev) => ({
      ...prev,
      locations: prev.locations.map((l) => (l.id === locationId ? { ...l, capacity } : l)),
    }))
  }

  function requestDelete(kind, entity) {
    setPendingDelete({ kind, entity })
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const result = pendingDelete.kind === 'event'
        ? await localClient.deleteEvent({ eventId: pendingDelete.entity.id })
        : await localClient.deleteSpecialDay({ specialDayId: pendingDelete.entity.id })
      if (result?.error) throw new Error(result.error)
      setPendingDelete(null)
      setSelected(null)
      await Promise.all([loadDays(), loadSupportData()])
    } catch (err) {
      setError(describeWriteFailure(err, 'That could not be deleted.'))
      setPendingDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  const selectedEvent = selected?.type === 'event' ? events.find((e) => e.id === selected.id) : null
  const selectedDay = selected?.type === 'day' ? days.find((d) => d.id === selected.id) : null

  if (selectedEvent) {
    return (
      <>
        <EventDetail
          event={selectedEvent}
          role={role}
          placements={supportData.placements}
          groups={supportData.groups}
          days={supportData.daysOfOp}
          timeBlocks={supportData.timeBlocks}
          locations={supportData.locations}
          onBack={() => setSelected(null)}
          onSave={saveEvent}
          onDelete={(event) => requestDelete('event', event)}
          onCreateLocation={createLocation}
          onUpdateLocationCapacity={updateLocationCapacity}
          onNavigate={onNavigate}
        />
        {pendingDelete && (
          <ConfirmDangerDialog
            title={`Delete "${pendingDelete.entity.name}"?`}
            body="This event and its placement on the schedule will be removed."
            recovery={`"${pendingDelete.entity.name}" goes to Trash, and you can put it back from there.`}
            confirmLabel="Delete Event"
            busy={deleting}
            onConfirm={confirmDelete}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </>
    )
  }

  if (selectedDay) {
    return (
      <>
        <SpecialDayDetail
          day={selectedDay}
          role={role}
          onBack={() => setSelected(null)}
          onSave={saveDay}
          onDelete={(day) => requestDelete('day', day)}
          onNavigate={onNavigate}
        />
        {pendingDelete && (
          <ConfirmDangerDialog
            title={`Delete "${pendingDelete.entity.name}"?`}
            body="This special day and its time blocks and filled slots will be removed."
            recovery={`"${pendingDelete.entity.name}" goes to Trash, and you can put it back from there.`}
            confirmLabel="Delete Special Day"
            busy={deleting}
            onConfirm={confirmDelete}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </>
    )
  }

  const isEmpty = !loading && events.length === 0 && days.length === 0

  return (
    <div style={{ maxWidth: 760 }}>
      {toast && <div style={{ ...S.errorBanner, background: 'var(--surface)', marginBottom: 16 }}>{toast}</div>}
      {error && <div style={S.errorBanner}>{error}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <button className="press-97" onClick={() => { setAddingDay(true); setTimeout(() => dayNameRef.current?.focus(), 0) }} style={S.btnSecondary}>
          {LABELS.addDayCta}
        </button>
        <button className="press-97" onClick={() => { setAddingEvent(true); setTimeout(() => eventNameRef.current?.focus(), 0) }} style={S.btnPrimary}>
          {LABELS.addEventCta}
        </button>
      </div>

      {addingDay && (
        <div style={{ ...enterStyle, display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            ref={dayNameRef}
            autoFocus
            value={newDayName}
            onChange={(e) => setNewDayName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createDay()}
            placeholder="Name your special day…"
            style={{ ...S.input, flex: 1 }}
          />
          <button className="press-97" onClick={createDay} style={S.btnPrimary} disabled={!newDayName.trim()}>Create</button>
          <button className="press-97" onClick={() => { setAddingDay(false); setNewDayName('') }} style={S.btnSecondary}>Cancel</button>
        </div>
      )}

      {addingEvent && (
        <div style={{ ...enterStyle, display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            ref={eventNameRef}
            autoFocus
            value={newEventName}
            onChange={(e) => setNewEventName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createEvent()}
            placeholder="e.g. Color War"
            style={{ ...S.input, flex: 1 }}
          />
          <button className="press-97" onClick={createEvent} style={S.btnPrimary} disabled={!newEventName.trim()}>Create</button>
          <button className="press-97" onClick={() => { setAddingEvent(false); setNewEventName('') }} style={S.btnSecondary}>Cancel</button>
        </div>
      )}

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : isEmpty ? (
        <CalmEmptyState message={LABELS.emptyMessage} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {days.map((d) => (
            <Card key={d.id} name={d.name} tag="Special Day" tagColor="var(--secondary)" onClick={() => setSelected({ type: 'day', id: d.id })} />
          ))}
          {events.map((e) => (
            <Card key={e.id} name={e.name} tag="Event" tagColor="var(--primary)" onClick={() => setSelected({ type: 'event', id: e.id })} />
          ))}
          {seedPromptForId && days.some((d) => d.id === seedPromptForId) && (
            <div style={{ ...enterStyle, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px' }}>
              <div style={{ fontSize: 13, marginBottom: 8 }}>{LABELS.seedPrompt}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="press-97" onClick={() => seedFromCampTimeBlocks(seedPromptForId)} style={S.btnSecondary}>{LABELS.seedFromBlocks}</button>
                <button className="press-97" onClick={() => startEmpty(seedPromptForId)} style={S.btnSecondary}>{LABELS.startEmpty}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Card({ name, tag, tagColor, onClick }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      className="press-97"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
        padding: '12px 16px', cursor: 'pointer',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 500 }}>{name || '(unnamed)'}</div>
      <span style={S.chip(tagColor, false, { padding: '3px 10px', fontSize: 11 })}>{tag}</span>
    </div>
  )
}
