import { useState } from 'react'
import { useEnterTransition } from '../styles/shared'
import { CapacityStepper } from '../screens/LocationsScreen'

const LOCATION_QUERY_MAXLENGTH = 60

function capacityWord(n) {
  return `${n} group${n === 1 ? '' : 's'}`
}

function MapPinIcon({ color = 'var(--text-secondary)', size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" style={{ flexShrink: 0 }}>
      <path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10Z" />
      <circle cx="12" cy="11" r="2.2" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ flexShrink: 0 }}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

// Split out so useEnterTransition('popFade') runs its mount effect when the
// POPOVER mounts, not when the (always-mounted) LocationPicker does — hoisted
// in the parent, `entered` was already true by the time `open` flipped, so
// popFade never had a "from" frame to animate from (Code Reviewer round-2 C1).
export function LocationPickerPopover({ showEmptyHint, matches, active, showCreateRow, creating, q, onSelectMatch, onCreate }) {
  const enter = useEnterTransition('popFade')
  return (
    <div style={{ ...pickerStyles.popover, ...enter }}>
      {showEmptyHint && <div style={pickerStyles.hintRow}>Type a location, or add a new one…</div>}
      {matches.map((l, i) => (
        <button
          key={l.id}
          type="button"
          onMouseDown={e => { e.preventDefault(); onSelectMatch(l) }}
          style={{ ...pickerStyles.option, ...(i === active ? pickerStyles.optionActive : {}) }}
        >
          <span style={{ fontWeight: 500 }}>{l.name}</span>
          <span style={pickerStyles.optionCap}>{capacityWord(l.capacity)}</span>
        </button>
      ))}
      {showCreateRow && (
        <button
          type="button"
          onMouseDown={e => { e.preventDefault(); onCreate() }}
          disabled={creating}
          style={{ ...pickerStyles.option, ...pickerStyles.createOption, ...(active === matches.length ? pickerStyles.optionActive : {}) }}
        >
          <PlusIcon />
          <span style={pickerStyles.createLabel}>Create "{q}" as a new location</span>
          <span style={pickerStyles.newTag}>NEW</span>
        </button>
      )}
    </div>
  )
}

// The M3 place picker (design spec Part 2, docs/work/specs/2026-08-15-m3-
// locations-design.md): typeahead over the camp's locations + inline create,
// replacing the free-text Location input. Selecting/creating binds
// `location_id` directly on whatever entity the caller writes — this
// component never produces a free-text `location` field write (D5 UI freeze).
export function LocationPicker({ value, locations, onChange, onCreate, onUpdateCapacity }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const [creating, setCreating] = useState(false)
  // C2: tracks a place created THIS session so its just-picked token can show
  // an in-place capacity stepper instead of the read-only meta text — the
  // default (1) is often wrong for a shared place (Lake, Field) and the
  // director shouldn't have to leave the modal to fix it. Cleared implicitly
  // once the modal unmounts; does not persist across sessions on purpose —
  // an OLD selection (picked from the list) always shows the plain meta text.
  const [justCreatedId, setJustCreatedId] = useState(null)
  const [capacityFeedback, setCapacityFeedback] = useState(null)

  const selected = value ? locations.find(l => l.id === value) : null
  // C5: a location_id set but absent from the camp's current locations list —
  // deleted place, cross-device race, stale import. Distinct from "nothing
  // picked yet" so the picker can surface it instead of reading as empty.
  const dangling = Boolean(value) && !selected
  const q = query.trim()
  const matches = locations.filter(l => l.name.toLowerCase().includes(q.toLowerCase()))
  const exactMatch = locations.some(l => l.name.toLowerCase() === q.toLowerCase())
  const showCreateRow = q.length > 0 && !exactMatch
  const showEmptyHint = matches.length === 0 && !q
  const optionCount = matches.length + (showCreateRow ? 1 : 0)

  function selectMatch(loc) {
    onChange(loc.id)
    setQuery('')
    setOpen(false)
  }

  async function handleCreate() {
    if (!q || creating) return
    setCreating(true)
    try {
      const newId = await onCreate(q)
      if (newId) { onChange(newId); setJustCreatedId(newId); setQuery(''); setOpen(false) }
    } catch (err) {
      // The typed text and popover stay put so the director can retry —
      // no dedicated error UI for this micro-flow (not in the design spec).
      console.error('Could not create location', err)
    } finally {
      setCreating(false)
    }
  }

  async function changeCapacity(n) {
    setCapacityFeedback(null)
    try {
      await onUpdateCapacity(selected.id, n)
    } catch (err) {
      console.error('Could not update place capacity', err)
      setCapacityFeedback('Could not save — try again.')
    }
  }

  function clear() {
    onChange(null)
    setQuery('')
    setOpen(false)
  }

  if (selected) {
    const justCreated = selected.id === justCreatedId
    return (
      <div>
        <div style={pickerStyles.selected}>
          <MapPinIcon color="var(--secondary)" />
          <span style={pickerStyles.selectedName}>{selected.name}</span>
          {justCreated ? (
            <CapacityStepper value={selected.capacity} onChange={changeCapacity} />
          ) : (
            <span style={pickerStyles.selectedMeta}>· {capacityWord(selected.capacity)} at once</span>
          )}
          <button type="button" onClick={clear} aria-label="Clear" style={pickerStyles.clearBtn}>×</button>
        </div>
        <div style={pickerStyles.hint}>
          {capacityFeedback || (justCreated
            ? 'New location — set how many groups fit at once here, or change it later on the Locations screen.'
            : `The schedule will keep this activity to ${capacityWord(selected.capacity)} here.`)}
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      {dangling && (
        <div style={pickerStyles.danglingWarning}>The location set here no longer exists — pick a new one.</div>
      )}
      <div style={{ ...pickerStyles.field, ...(focused ? pickerStyles.fieldFocus : {}) }}>
        <MapPinIcon />
        <input
          value={query}
          maxLength={LOCATION_QUERY_MAXLENGTH}
          onChange={e => { setQuery(e.target.value); setOpen(true); setActive(0) }}
          onFocus={() => { setFocused(true); setOpen(true) }}
          onBlur={() => { setFocused(false); setTimeout(() => setOpen(false), 120) }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { setActive(a => Math.min(a + 1, optionCount - 1)); e.preventDefault() }
            else if (e.key === 'ArrowUp') { setActive(a => Math.max(a - 1, 0)); e.preventDefault() }
            else if (e.key === 'Enter') {
              e.preventDefault()
              if (matches[active]) selectMatch(matches[active])
              else if (showCreateRow) handleCreate()
            } else if (e.key === 'Escape') { setOpen(false) }
          }}
          placeholder="Search or add a location…"
          style={pickerStyles.input}
        />
      </div>
      {open && (
        <LocationPickerPopover
          showEmptyHint={showEmptyHint}
          matches={matches}
          active={active}
          showCreateRow={showCreateRow}
          creating={creating}
          q={q}
          onSelectMatch={selectMatch}
          onCreate={handleCreate}
        />
      )}
      {/* C3: reassurance that an empty picker is a fine, deliberate state —
          not shown while a dangling id needs attention (that warning above
          already explains why the field reads as unset). */}
      {!query && !value && (
        <div style={pickerStyles.emptyHint}>Leaving it blank is fine. Not every activity has a room.</div>
      )}
    </div>
  )
}

const pickerStyles = {
  field: {
    display: 'flex', alignItems: 'center', gap: 8,
    border: '1.5px solid var(--border)', borderRadius: 7,
    background: 'var(--surface)', padding: '0 10px',
  },
  fieldFocus: { borderColor: 'var(--primary)' },
  input: { border: 'none', outline: 'none', background: 'none', padding: '9px 0', fontSize: 13, width: '100%' },
  popover: {
    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
    background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 8,
    boxShadow: '0 2px 16px color-mix(in srgb, var(--text) 12%, transparent)',
    zIndex: 30, overflow: 'hidden',
  },
  option: {
    display: 'flex', alignItems: 'center', gap: 9, padding: '9px 11px', fontSize: 13,
    border: 'none', background: 'none', width: '100%', textAlign: 'left', color: 'var(--text)', cursor: 'pointer',
  },
  optionActive: { background: 'color-mix(in srgb, var(--primary) 8%, var(--surface-elevated))' },
  optionCap: { marginLeft: 'auto', flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' },
  createOption: { borderTop: '1px solid var(--border)', color: 'var(--secondary)', fontWeight: 600 },
  // C4: a long typed place name must not shove the NEW tag out of the row.
  createLabel: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  newTag: { marginLeft: 'auto', flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em' },
  hintRow: { padding: '9px 11px', fontSize: 13, color: 'var(--text-secondary)' },
  selected: {
    display: 'flex', alignItems: 'center', gap: 8,
    border: '1.5px solid var(--border)', borderRadius: 7, background: 'var(--surface)', padding: '8px 10px',
  },
  // C4: a long place name must not shove the capacity meta / × out of the row.
  selectedName: { fontWeight: 600, fontSize: 13, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  selectedMeta: { flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' },
  clearBtn: {
    marginLeft: 'auto', flexShrink: 0, border: 'none', background: 'none', color: 'var(--text-secondary)',
    width: 22, height: 22, borderRadius: 5, fontSize: 15, lineHeight: 1, cursor: 'pointer',
  },
  hint: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 5 },
  // C3: faint reassurance shown only on the true empty state (nothing typed,
  // nothing bound) — not shown alongside the C5 dangling warning.
  emptyHint: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 5 },
  // C5: a location_id bound to a place that no longer exists.
  danglingWarning: { fontSize: 11, color: 'var(--warning)', marginBottom: 5 },
}
