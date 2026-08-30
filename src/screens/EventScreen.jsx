// The dedicated event overlay-placement screen — Slice 1 (docs/adr/2026-08-22-
// events-overlay-placement.md §5, docs/work/specs/2026-08-22-events-overlay-
// slices.md Step 6).
//
// Structurally mirrors ElectivesScreen.jsx's CRUD shell (name edit,
// setupCrudRepository/useCrudScreen) with the offerings sub-table removed —
// events have no offerings in Slice 1. Placement is authored from the
// campwide grid via normal drag/drop, never from this screen: the detail
// view here is a READ-ONLY summary of where this event currently sits.
//
// Slice 2 (docs/adr/2026-08-22-event-internal-subschedule.md;
// docs/work/specs/2026-08-22-event-internal-subschedule-slices.md Step 4)
// added an internal sub-schedule section that opened EventGridEditor
// directly from here. docs/work/specs/2026-08-23-schedule-build-ia.md
// removed that button: building an event's grid now lives only under
// Schedule → Special Schedules (SpecialSchedulesScreen); this screen keeps
// authoring (name/notes/location) and the read-only PlacementSummary, plus a
// quiet link that navigates to the new build entry.
import { useState, useRef, useEffect } from 'react'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { useCrudScreen } from '../hooks/useCrudScreen'
import { S, useEnterTransition } from '../styles/shared'
import { LocationPicker } from '../components/LocationPicker'

const repository = createSetupCrudRepository({ localClient })
const scopeFilter = (row, campId) => row.camp_id === campId

function EventRow({ event, onOpen, onSave }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(event.name)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave(event.id, { name: name.trim() })
      setEditing(false)
    } catch {
      // onSave already surfaced the error; stay in edit mode so nothing is lost.
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <tr style={{ background: 'var(--surface-elevated)' }}>
        <td style={S.td}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            style={S.input}
          />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <button className="press-97" onClick={save} disabled={saving} style={S.btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="press-97" onClick={() => { setName(event.name); setEditing(false) }} style={{ ...S.btnSecondary, marginLeft: 6 }}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ ...S.td, fontWeight: 500, cursor: 'pointer' }} onClick={() => onOpen(event)}>
        {event.name || '(unnamed)'}
      </td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button className="press-97" onClick={() => setEditing(true)} style={S.btnSecondary}>Rename</button>
      </td>
    </tr>
  )
}

// Read-only placement summary — query template_slots WHERE event_id, resolve
// day/block/group names, render as a plain list. No editing from here; a
// director places/moves an event on the campwide grid via normal drag/drop.
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

function EventDetail({ event, role, placements, groups, days, timeBlocks, locations, onBack, onSave, onCreateLocation, onUpdateLocationCapacity, onNavigate }) {
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

  // Picker selection writes immediately — mirrors AnchorModal/ActivityModal's
  // location_id semantics, but this card has no Save button (every field
  // commits on its own, like Name/Notes above). A picked match or a fresh
  // create is always a valid location by construction; the picker's own
  // dangling-id display (C5) already warns when `event.location_id` points
  // at a place that no longer exists — this only needs to write what it's given.
  function changeLocation(newLocationId) {
    setLocationId(newLocationId)
    commit({ location_id: newLocationId })
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <button className="press-97" onClick={onBack} style={{ ...S.btnSecondary, marginBottom: 14 }}>
        ← Back to Events
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

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
        <div style={S.sectionLabel}>
          Where this is placed
        </div>
        <PlacementSummary eventId={event.id} placements={placements} groups={groups} days={days} timeBlocks={timeBlocks} />
      </div>

      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 16 }}>
        <button
          className="press-97"
          onClick={() => onNavigate?.('schedule:special', { buildEventId: event.id })}
          style={linkButtonStyle}
        >
          Build this event's schedule from Special Schedules
        </button>
      </div>
    </div>
  )
}

const linkButtonStyle = {
  background: 'none', border: 'none', padding: 0, color: 'var(--primary)',
  fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
  textDecoration: 'underline',
}

export default function EventScreen({ campId, role, initialEventId = null, onNavigate }) {
  const { rows: events, loading, error, add, save, adding } = useCrudScreen({
    entity: 'events',
    campId,
    localClient,
    repository,
    scopeFilter,
    // name FIRST — events is UNIQUE_FIRST_FIELD-registered (UNIQUE(camp_id,
    // name)); the unique field must write first so a collision is detectable
    // and no orphaned blank-name row can be materialized. See
    // setupCrudRepository / T115's orphan-row lesson.
    buildCreateFields: ({ name }) => ({ name, camp_id: campId }),
    addFailedText: 'That event could not be added.',
    saveFailedText: 'That event could not be saved.',
  })

  const [newName, setNewName] = useState('')
  // Grid drill-in — an event cell's affordance on the campwide schedule opens
  // this screen focused on it, mirroring ElectivesScreen's selectedSetId.
  const [selectedEventId, setSelectedEventId] = useState(initialEventId)
  const [supportData, setSupportData] = useState({ placements: [], groups: [], days: [], timeBlocks: [], locations: [] })
  const nameRef = useRef()
  const enter = useEnterTransition('liftFade')

  async function loadSupportData() {
    const [slots, groups, days, timeBlocks, locations] = await Promise.all([
      localClient.list('template_slots'),
      localClient.list('groups'),
      localClient.list('days_of_operation'),
      localClient.list('time_blocks'),
      localClient.list('locations'),
    ])
    setSupportData({
      placements: (slots || []).filter((s) => s.event_id),
      groups: groups || [],
      days: days || [],
      timeBlocks: timeBlocks || [],
      locations: (locations || []).filter((l) => l.camp_id === campId),
    })
  }

  // Contextual create from the LocationPicker's "create new" row — mirrors
  // ActivitiesScreen.createLocation exactly (same case-insensitive dedupe
  // rationale; see that screen's comment for the full ADR reasoning).
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

  useEffect(() => {
    ;(async () => { await loadSupportData() })()
  }, [campId])

  async function addEvent() {
    if (!newName.trim()) return
    const succeeded = await add({ name: newName.trim() })
    if (succeeded) setNewName('')
  }

  const selectedEvent = events.find((e) => e.id === selectedEventId)

  if (selectedEvent) {
    return (
      <EventDetail
        event={selectedEvent}
        role={role}
        placements={supportData.placements}
        groups={supportData.groups}
        days={supportData.days}
        timeBlocks={supportData.timeBlocks}
        locations={supportData.locations}
        onBack={() => setSelectedEventId(null)}
        onSave={save}
        onCreateLocation={createLocation}
        onUpdateLocationCapacity={updateLocationCapacity}
        onNavigate={onNavigate}
      />
    )
  }

  return (
    <div style={{ maxWidth: 640 }}>
      {error && <div style={S.errorBanner}>{error}</div>}

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : events.length === 0 ? (
        <div style={{ ...emptyStyles.wrap, ...enter }}>
          <div style={emptyStyles.title}>No events yet</div>
          <button className="press-97" onClick={() => nameRef.current?.focus()} style={{ ...S.btnPrimary, marginTop: 14 }}>
            Add your first event
          </button>
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                <th style={S.th}>Name</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <EventRow key={event.id} event={event} onOpen={(e) => setSelectedEventId(e.id)} onSave={save} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
        <div style={S.sectionLabel}>Add Event</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px' }}>
            <label style={fieldLabel}>Name</label>
            <input
              ref={nameRef}
              placeholder="e.g. Color War"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addEvent()}
              style={S.input}
            />
          </div>
          <button className="press-97" onClick={addEvent} disabled={adding || !newName.trim()} style={{ ...S.btnPrimary, flexShrink: 0 }}>
            {adding ? 'Adding…' : '+ Add'}
          </button>
        </div>
      </div>
    </div>
  )
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

const emptyStyles = {
  wrap: {
    padding: '60px 16px',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 600,
    fontSize: 15,
    color: 'var(--text)',
    marginTop: 8,
  },
}
