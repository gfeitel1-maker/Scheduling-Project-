// Unified Special Events hub (owner-approved 2026-08-29, docs/adr/2026-08-29-
// unify-special-events-screen.md; docs/work/tickets/T110-unify-special-
// events-screen.md). Replaces the separate EventScreen/SpecialDaysScreen rows
// in Sprouts with one create/manage surface: a table of special_days +
// events (type-tagged rows, inline-add), click a row to open its detail. The Plants build surface
// (SpecialSchedulesScreen, route 'schedule:special') is UNCHANGED — this
// screen only authors name/notes/location and routes "Build →" there, same
// as the two screens it replaces did.
import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { useCrudScreen } from '../hooks/useCrudScreen'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { S, useEnterTransition } from '../styles/shared'
import { LocationPicker } from '../components/LocationPicker'
import { ScheduleDoor } from '../components/ScheduleDoor'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import InlineAddRow from '../components/setup/InlineAddRow'
import { seedFailureMessage } from './specialDay/seedFailureMessage'

const repository = createSetupCrudRepository({ localClient })
const eventScopeFilter = (row, campId) => row.camp_id === campId

const TYPE_OPTIONS = [
  { value: 'event', label: 'Event' },
  { value: 'day', label: 'Special Day' },
]

const LABELS = {
  emptyMessage: 'No special events yet.',
  namePlaceholder: 'Name a special day or event…',
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

// Event detail — carried over from EventScreen.jsx's EventDetail: editable
// name + notes (commit-on-blur), location picker, and a ScheduleDoor to the
// Plants build surface.
export function EventDetail({ event, role, locations, onBack, onSave, onDelete, onCreateLocation, onUpdateLocationCapacity, onNavigate }) {
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
      <button className="press-97" onClick={onBack} style={{ ...S.backBar, marginBottom: 14 }}>
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

      <div style={{ marginBottom: 16 }}>
        <ScheduleDoor
          label="Build the schedule →"
          onClick={() => onNavigate?.('schedule:special', { buildEventId: event.id })}
        />
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
      <button className="press-97" onClick={onBack} style={{ ...S.backBar, marginBottom: 14 }}>
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

      <div style={{ marginBottom: 16 }}>
        <ScheduleDoor
          label="Build the schedule →"
          onClick={() => onNavigate?.('schedule:special', { specialDayId: day.id })}
        />
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
  const [supportData, setSupportData] = useState({ locations: [] })
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const [adding, setAdding] = useState(false)
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
    const locations = await localClient.list('locations')
    setSupportData({
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

  // Inline-add dispatch: the always-present blank row commits a { name, type }.
  // `type` picks the entity — 'event' goes through the same useCrudScreen add
  // path EventScreen used; 'day' goes through createDay, which mints the row
  // AND fires the seed-from-time-blocks prompt exactly as the old "+ Special
  // Day" button did. Returns truthy on success so InlineAddRow clears its row.
  async function addSpecialEvent(values) {
    const name = String(values.name ?? '').trim()
    if (!name) return false
    setAdding(true)
    try {
      return values.type === 'day' ? await createDay(name) : await createEvent(name)
    } finally {
      setAdding(false)
    }
  }

  async function createEvent(name) {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) return false
    return await addEvent({ name: trimmed })
  }

  async function createDay(name) {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) return false
    const id = crypto.randomUUID()
    try {
      await writeField('special_days', id, 'name', trimmed)
      setDays((prev) => [...prev, { id, camp_id: campId, name: trimmed }])
      setSeedPromptForId(id)
      return true
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not create that special day.'))
      return false
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

  const rows = [
    ...days.map((d) => ({ key: `day-${d.id}`, name: d.name, type: 'day', tag: 'Special Day', tagColor: 'var(--secondary)', focus: { type: 'day', id: d.id } })),
    ...events.map((e) => ({ key: `event-${e.id}`, name: e.name, type: 'event', tag: 'Event', tagColor: 'var(--primary)', focus: { type: 'event', id: e.id } })),
  ]

  return (
    <div style={{ maxWidth: 760 }}>
      {toast && <div style={{ ...S.errorBanner, background: 'var(--surface)', marginBottom: 16 }}>{toast}</div>}
      {error && <div style={S.errorBanner}>{error}</div>}

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Type</th>
                <th style={S.th} aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={3} style={S.emptyState}>
                  <div style={S.emptyStateTitle}>{LABELS.emptyMessage}</div>
                  <div style={S.emptyStateBody}>Type a name below and pick a type to add your first one.</div>
                </td></tr>
              ) : (
                rows.map((r) => (
                  <SpecialEventRow key={r.key} name={r.name} tag={r.tag} tagColor={r.tagColor} onOpen={() => setSelected(r.focus)} />
                ))
              )}
              <InlineAddRow
                fields={[
                  { key: 'name', type: 'text', placeholder: LABELS.namePlaceholder, required: true },
                  { key: 'type', type: 'select', default: 'event', options: TYPE_OPTIONS },
                ]}
                onAdd={addSpecialEvent}
                adding={adding}
              />
            </tbody>
          </table>
        </div>
      )}

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
  )
}

// One list row — clicking anywhere opens that item's detail (the same detail
// the old card click opened). Type shows as a colored tag, reusing S.chip.
function SpecialEventRow({ name, tag, tagColor, onOpen }) {
  return (
    <tr
      style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
      onClick={onOpen}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
    >
      <td style={S.td}>
        <span
          role="button"
          tabIndex={0}
          aria-label={`Open ${name || '(unnamed)'}`}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
          style={{ cursor: 'pointer', fontWeight: 500 }}
        >{name || '(unnamed)'}</span>
      </td>
      <td style={S.td}>
        <span style={S.chip(tagColor, false, { padding: '3px 10px', fontSize: 11 })}>{tag}</span>
      </td>
      <td style={S.td} />
    </tr>
  )
}
