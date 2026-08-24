// docs/work/specs/2026-08-23-electives-gap.md Part (a) — typeahead-with-
// inline-create over the activity catalog, structurally identical to
// LocationPicker.jsx's proven shape (same field/popover/keyboard-nav
// styling, same tokens). Differs from LocationPicker in one way: this
// picker has no persistent "selected" binding — selecting an existing match
// or creating a new one both act immediately (add the offering) and the
// picker resets to its empty, closed state, matching the one-click "make
// this an offering" gesture the spec calls for.
import { useState } from 'react'
import { useEnterTransition } from '../styles/shared'

const ACTIVITY_QUERY_MAXLENGTH = 60

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ flexShrink: 0 }}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

// Split out for the same reason LocationPickerPopover is split out: so
// useEnterTransition('popFade') runs its mount effect when the popover
// itself mounts, not when the always-mounted picker does.
export function ActivityPickerPopover({ hintText, matches, active, showCreateRow, creating, q, onSelectMatch, onCreate }) {
  const enter = useEnterTransition('popFade')
  return (
    <div style={{ ...pickerStyles.popover, ...enter }}>
      {hintText && <div style={pickerStyles.hintRow}>{hintText}</div>}
      {matches.map((a, i) => (
        <button
          key={a.id}
          type="button"
          onMouseDown={(e) => { e.preventDefault(); onSelectMatch(a) }}
          style={{ ...pickerStyles.option, ...(i === active ? pickerStyles.optionActive : {}) }}
        >
          <span style={{ fontWeight: 500 }}>{a.name}</span>
        </button>
      ))}
      {showCreateRow && (
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); onCreate() }}
          disabled={creating}
          style={{ ...pickerStyles.option, ...pickerStyles.createOption, ...(active === matches.length ? pickerStyles.optionActive : {}) }}
        >
          <PlusIcon />
          <span style={pickerStyles.createLabel}>Create "{q}" as a new activity</span>
          <span style={pickerStyles.newTag}>NEW</span>
        </button>
      )}
    </div>
  )
}

// `activities` is the AVAILABLE set (catalog minus what's already offered);
// `catalogHasAny` distinguishes "everything is already offered" from a
// truly empty catalog for the empty-popover hint copy (spec's "States").
export default function ActivityPicker({ activities, catalogHasAny, disabled, onSelect, onCreate }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const [creating, setCreating] = useState(false)

  const q = query.trim()
  const matches = activities.filter((a) => a.name.toLowerCase().includes(q.toLowerCase()))
  const exactMatch = activities.some((a) => a.name.toLowerCase() === q.toLowerCase())
  const showCreateRow = q.length > 0 && !exactMatch
  const hintText = matches.length === 0 && !q && catalogHasAny
    ? 'All existing activities are already offered here. Type a name below to add a new one.'
    : null
  const optionCount = matches.length + (showCreateRow ? 1 : 0)

  function selectMatch(a) {
    setQuery('')
    setOpen(false)
    onSelect(a.id)
  }

  async function handleCreate() {
    if (!q || creating) return
    setCreating(true)
    try {
      await onCreate(q)
      setQuery('')
      setOpen(false)
    } catch (err) {
      // The typed text and popover stay put so the director can retry —
      // no dedicated error UI for this micro-flow, matching
      // LocationPicker.handleCreate's catch block.
      console.error('Could not create activity', err)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ ...pickerStyles.field, ...(focused ? pickerStyles.fieldFocus : {}) }}>
        <input
          value={query}
          maxLength={ACTIVITY_QUERY_MAXLENGTH}
          disabled={disabled}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0) }}
          onFocus={() => { setFocused(true); setOpen(true) }}
          onBlur={() => { setFocused(false); setTimeout(() => setOpen(false), 120) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { setActive((a) => Math.min(a + 1, optionCount - 1)); e.preventDefault() }
            else if (e.key === 'ArrowUp') { setActive((a) => Math.max(a - 1, 0)); e.preventDefault() }
            else if (e.key === 'Enter') {
              e.preventDefault()
              if (matches[active]) selectMatch(matches[active])
              else if (showCreateRow) handleCreate()
            } else if (e.key === 'Escape') { setOpen(false) }
          }}
          placeholder="Search or add an activity…"
          aria-label="Search or add an activity"
          style={pickerStyles.input}
        />
      </div>
      {open && (
        <ActivityPickerPopover
          hintText={hintText}
          matches={matches}
          active={active}
          showCreateRow={showCreateRow}
          creating={creating}
          q={q}
          onSelectMatch={selectMatch}
          onCreate={handleCreate}
        />
      )}
    </div>
  )
}

const pickerStyles = {
  field: {
    display: 'flex', alignItems: 'center', gap: 8,
    border: '1.5px solid var(--border)', borderRadius: 7,
    background: 'var(--surface)', padding: '0 10px', minWidth: 220,
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
  createOption: { borderTop: '1px solid var(--border)', color: 'var(--secondary)', fontWeight: 600 },
  createLabel: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  newTag: { marginLeft: 'auto', flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em' },
  hintRow: { padding: '9px 11px', fontSize: 13, color: 'var(--text-secondary)' },
}
