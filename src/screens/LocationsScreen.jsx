import { useState, useRef } from 'react'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { useCrudScreen } from '../hooks/useCrudScreen'
import { S, useEnterTransition } from '../styles/shared'
import ScreenIntro from '../components/ScreenIntro'

// M3a — the Locations setup screen. docs/work/specs/2026-08-15-m3-locations-design.md Part 1.
//
// Scoped to M3a only: the screen + readiness promotion. NOT built here —
// the activity picker (M3b, ActivitiesScreen's free-text `location` input)
// and the first-run migration review region (M3c, the near-duplicate merge
// gate + capacity advisory strip). Per the design's §3.3, an absent/empty
// review journal renders nothing at all, which is exactly this screen's
// behavior until M3c adds the region above the toolbar.
const repository = createSetupCrudRepository({ localClient })
const scopeFilter = (row, campId) => row.camp_id === campId

// A place bound by activities must warn with a count and never silently
// orphan the binding (design spec Part 1, "States: Delete"). `locations` is
// not in electron/ops/deleteRecord.js's CLEARABLE_ENTITIES — that module
// exists to clear FK-blocking rows before a delete, and activities.location_id
// carries no DB-level FK (matches weather_alternative_id) — so there is
// nothing to preview via localClient.previewDelete/DeleteRecordDialog for
// this entity. TiersScreen.jsx and TimeBlocksScreen.jsx are the actual
// precedent for a setup entity outside that backend contract: a local
// styled confirm modal reusing DeleteRecordDialog's visual chrome, computing
// its own usage count client-side, deleting via localClient.deleteEntity
// directly. Followed here, with the one addition Locations needs that Tiers
// does not: unbinding the affected activities' location_id first, so a
// deleted place is never left as a dangling reference.
async function boundActivities(campId, locationId) {
  const rows = await localClient.list('activities')
  return (rows || []).filter((a) => a.camp_id === campId && a.location_id === locationId)
}

function capacityWord(n) {
  return `${n} group${n === 1 ? '' : 's'}`
}

// The segmented [ – | n | + ] control from the design spec ("a named
// component: CapacityStepper"), built once here and reused by the add card
// and the inline edit row. Min 1, hard — 0 meant "unlimited" pre-ADR and the
// control cannot express it. Still keyboard-typeable in the middle cell.
export function CapacityStepper({ value, onChange, disabled }) {
  const n = Number(value) || 1
  // Typed text is tracked separately from the committed `n` so the field can
  // sit empty mid-edit (select-all-and-retype) without the controlled value
  // snapping back on every keystroke. Only a commit (blur/Enter, or a
  // +/- click) can change what the parent holds, and a commit always floors
  // to >=1 — the field can look empty, it can never SAVE empty or 0.
  const [text, setText] = useState(String(n))
  // Adjust local text when the committed value changes from outside (e.g. the
  // caller resetting the field after Add) — the render-time pattern from the
  // React docs' "Adjusting state when a prop changes", not an effect, so the
  // reset lands before this render paints instead of one render later.
  const [prevN, setPrevN] = useState(n)
  if (n !== prevN) {
    setPrevN(n)
    setText(String(n))
  }

  function commit(next) {
    const clamped = Math.max(1, Math.round(next) || 1)
    setText(String(clamped))
    if (clamped !== n) onChange(clamped)
  }

  return (
    <div style={stepperStyles.wrap}>
      <button
        type="button"
        className="press-97"
        onClick={() => commit(n - 1)}
        disabled={disabled || n <= 1}
        aria-label="Decrease"
        style={{ ...stepperStyles.btn, ...(disabled || n <= 1 ? S.buttonDisabled : {}) }}
      >–</button>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '' || /^\d+$/.test(raw)) setText(raw)
        }}
        onBlur={() => commit(parseInt(text, 10) || 1)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        style={stepperStyles.input}
        aria-label="Groups at once"
      />
      <button
        type="button"
        className="press-97"
        onClick={() => commit(n + 1)}
        disabled={disabled}
        aria-label="Increase"
        style={{ ...stepperStyles.btn, ...(disabled ? S.buttonDisabled : {}) }}
      >+</button>
    </div>
  )
}

function LocationRow({ location, role, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(location.name)
  const [capacity, setCapacity] = useState(location.capacity)
  const [notes, setNotes] = useState(location.notes || '')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave(location.id, { name: name.trim(), capacity: Number(capacity), notes: notes.trim() || null })
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
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }} style={S.input} />
        </td>
        <td style={S.td}><CapacityStepper value={capacity} onChange={setCapacity} /></td>
        <td style={S.td}>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }} style={S.input} />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <button className="press-97" onClick={save} disabled={saving} style={S.btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="press-97" onClick={() => { setName(location.name); setCapacity(location.capacity); setNotes(location.notes || ''); setEditing(false) }} style={{ ...S.btnSecondary, marginLeft: 6 }}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={(e) => e.currentTarget.style.background = ''}
    >
      <td style={{ ...S.td, fontWeight: 500 }}>{location.name}</td>
      <td style={{ ...S.td, fontVariantNumeric: 'tabular-nums' }}>{capacityWord(location.capacity)}</td>
      <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: 12 }}>{location.notes || '—'}</td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button className="press-97" onClick={() => setEditing(true)} style={S.btnSecondary}>Edit</button>
        <button
          onClick={() => onDelete(location)}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
        >Delete</button>
      </td>
    </tr>
  )
}

export default function LocationsScreen({ campId, role, onNavigate }) {
  const { rows: unsortedLocations, loading, error, setError, adding, add, save, deleteAll: deleteAllRecords, reload } =
    useCrudScreen({
      entity: 'locations',
      campId,
      localClient,
      repository,
      scopeFilter,
      // `name` MUST stay the first key: writeFields (setupCrudRepository.js)
      // writes fields in this object's insertion order, and a locations
      // create is the one entry point where that order is load-bearing, not
      // cosmetic (docs/adr/2026-08-15-locations-concurrent-create-collision.md
      // D3). If `name` collides, being first stops the sequential write loop
      // before capacity/notes ever go out — but more importantly, if ANY
      // field before `name` succeeded first, ensureExists
      // (electron/ops/projections.js) would INSERT OR IGNORE a blank-name
      // placeholder row for the new id BEFORE the collision on `name` ever
      // fires, reintroducing this ADR's orphan-row defect via a different
      // field. Pinned by a regression test in LocationsScreen.test.jsx.
      buildCreateFields: ({ name, capacity, notes }) => ({
        name,
        camp_id: campId,
        capacity,
        notes: notes || null,
      }),
      addFailedText: 'That place could not be added.',
      saveFailedText: 'That place could not be saved.',
      adminOnlyDeleteAllText: 'Only an admin can delete places — no places were deleted.',
      partialDeleteAllText: (succeeded, total, failed) => `Deleted ${succeeded} of ${total} places (${failed} failed — see console).`,
    })
  const locations = [...unsortedLocations].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name ?? '').localeCompare(String(b.name ?? '')))

  const [newName, setNewName] = useState('')
  const [newCapacity, setNewCapacity] = useState(1)
  const [newNotes, setNewNotes] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const nameRef = useRef()
  const enter = useEnterTransition('liftFade')

  async function addLocation() {
    if (!newName.trim()) return
    const succeeded = await add({ name: newName.trim(), capacity: Number(newCapacity), notes: newNotes.trim() })
    if (succeeded) { setNewName(''); setNewCapacity(1); setNewNotes('') }
  }

  async function deleteLocation(location) {
    setError(null)
    const bound = await boundActivities(campId, location.id)
    setPendingDelete({ id: location.id, name: location.name, count: bound.length })
  }

  async function confirmLocationDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const token = localStorage.getItem('shoresh-token')
      // Re-fetch immediately before writing — an activity another device
      // bound to this place between the count preview and this click should
      // still be unbound, not silently skipped.
      const bound = await boundActivities(campId, pendingDelete.id)
      for (const activity of bound) {
        await repository.writeFields('activities', activity.id, { location_id: null })
      }
      const result = await localClient.deleteEntity(token, 'locations', pendingDelete.id)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error('delete failed')
      }
      setPendingDelete(null)
      await reload()
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? 'Only an admin can delete places.'
          : describeWriteFailure(err, 'That place could not be deleted.')
      )
    } finally {
      setDeleting(false)
    }
  }

  async function deleteAll() {
    if (!window.confirm('Delete all places? They can be restored from Trash.')) return
    await deleteAllRecords()
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <ScreenIntro screen="locations" />
      {error && (
        <div style={S.errorBanner}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : locations.length === 0 ? (
        <div style={{ ...emptyStyles.wrap, ...enter }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.5">
            <path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10Z" />
            <circle cx="12" cy="11" r="2.2" />
          </svg>
          <div style={emptyStyles.title}>No places yet</div>
          <div style={emptyStyles.body}>Add a place below and say how many groups fit at once. Or skip this — the schedule works fine without it, and you can add places any time.</div>
          <button className="press-97" onClick={() => nameRef.current?.focus()} style={{ ...S.btnPrimary, marginTop: 14 }}>Add your first place</button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {locations.length} place{locations.length !== 1 ? 's' : ''}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={deleteAll}
                disabled={role !== 'admin'}
                title={role !== 'admin' ? 'Admin only' : undefined}
                style={role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
              >Delete All</button>
            </div>
          </div>

          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                  <th style={S.th}>Name</th>
                  <th style={S.th}>Groups at once</th>
                  <th style={S.th}>Notes</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((location) => (
                  <LocationRow key={location.id} location={location} role={role} onSave={save} onDelete={deleteLocation} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add Place</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 160px' }}>
            <label style={fieldLabel}>Name</label>
            <input ref={nameRef} placeholder="e.g. Pool, Gym, Beit Midrash" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addLocation()} style={S.input} />
          </div>
          <div>
            <label style={fieldLabel}>Groups at once</label>
            <CapacityStepper value={newCapacity} onChange={setNewCapacity} />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label style={fieldLabel}>Notes (optional)</label>
            <input placeholder="e.g. shared with the town" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addLocation()} style={S.input} />
          </div>
          <button className="press-97" onClick={addLocation} disabled={adding || !newName.trim()} style={{ ...S.btnPrimary, flexShrink: 0 }}>{adding ? 'Adding…' : '+ Add'}</button>
        </div>
      </div>

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="press-97" onClick={() => onNavigate('activities')} style={S.authLinkBtn}>← Back to Activities</button>
        <button className="press-97" onClick={() => onNavigate('anchors')} style={S.btnPrimary}>Next: Fixed Events →</button>
      </div>

      {pendingDelete && (
        <div style={deleteOverlay} onClick={() => !deleting && setPendingDelete(null)}>
          <div style={deletePanel} onClick={(e) => e.stopPropagation()}>
            <div style={deleteTitle}>Delete "{pendingDelete.name}"?</div>
            <p style={deleteBody}>
              {pendingDelete.count > 0
                ? `${pendingDelete.count} activit${pendingDelete.count === 1 ? 'y uses' : 'ies use'} "${pendingDelete.name}" right now. Deleting it takes "${pendingDelete.name}" off those activities — they stay on the schedule, just without a place.`
                : `Nothing uses "${pendingDelete.name}" right now.`}
            </p>
            <div style={deleteRecovery}>"{pendingDelete.name}" goes to Trash and you can put it back — but the activities won't automatically start using it again.</div>
            <div style={deleteActions}>
              <button className="press-97" onClick={() => setPendingDelete(null)} disabled={deleting} style={S.btnSecondary}>Cancel</button>
              <button onClick={confirmLocationDelete} disabled={deleting} style={S.btnDanger}>
                {deleting ? 'Working…' : 'Delete Place'}
              </button>
            </div>
          </div>
        </div>
      )}
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

const stepperStyles = {
  wrap: {
    display: 'inline-flex',
    alignItems: 'stretch',
    border: '1.5px solid var(--border)',
    borderRadius: 7,
    overflow: 'hidden',
    background: 'var(--surface)',
  },
  btn: {
    width: 30,
    border: 'none',
    background: 'var(--surface)',
    color: 'var(--text)',
    fontSize: 15,
    lineHeight: 1,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  input: {
    width: 42,
    border: 'none',
    borderLeft: '1px solid var(--border)',
    borderRight: '1px solid var(--border)',
    textAlign: 'center',
    fontSize: 13,
    background: 'var(--surface-elevated)',
    outline: 'none',
    fontVariantNumeric: 'tabular-nums',
    fontFamily: 'inherit',
  },
}

// Calm, no-card empty block — DESIGN_STANDARD §5a. NOT the in-table colSpan
// row Days/Groups use, and not a bordered card like Activities': Locations
// are optional, so their emptiness must read as deliberately fine.
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
  body: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    maxWidth: '56ch',
  },
}

// Local styled confirm modal reusing DeleteRecordDialog's visual chrome —
// see the module comment above: the DeleteRecordDialog backend contract
// (localClient.previewDelete) does not cover locations, so this is the
// honest in-scope fallback, matching TiersScreen.jsx/TimeBlocksScreen.jsx.
const deleteOverlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: '24px 16px',
}

const deletePanel = {
  background: 'var(--surface-elevated)',
  borderRadius: 12,
  padding: 28,
  width: 480,
  maxWidth: '100%',
}

const deleteTitle = {
  fontFamily: 'var(--font-condensed)',
  fontWeight: 700,
  fontSize: 18,
  marginBottom: 14,
}

const deleteBody = { fontSize: 14, lineHeight: 1.55, margin: '0 0 14px' }

const deleteRecovery = {
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--text-secondary)',
}

const deleteActions = {
  display: 'flex',
  gap: 10,
  justifyContent: 'flex-end',
  marginTop: 22,
}
