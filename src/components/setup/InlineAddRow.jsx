import { useRef, useState } from 'react'
import { S } from '../../styles/shared'

// The always-present blank "type here to add" row that lives as the last row of
// a setup table (Excel-like inline add). Typing the required field(s) + pressing
// Enter — or blurring out of the row — creates the record via the screen's own
// create path (the `onAdd` callback), and on success clears the required fields
// and restores defaults so the row stays put for the next entry.
//
// Config-driven generalization of the Days prototype's local AddDayRow. Each
// field is { key, type, placeholder?, required?, default?, options?, width? }.
// Supported types: 'text', 'number', 'time', 'select' (options: [{value,label}]).
//
// onAdd(values) receives an object keyed by field.key (raw control values — the
// caller converts/validates, matching each screen's existing create path) and
// returns a truthy value on success. Wave C1b — shared across setup screens.

// The seed value for a field: its explicit default, else '' for value inputs
// and the first option's value for a select.
function fieldDefault(field) {
  if (field.default !== undefined) return field.default
  if (field.type === 'select') return field.options?.[0]?.value ?? ''
  return ''
}

function initialValues(fields) {
  const values = {}
  for (const field of fields) values[field.key] = fieldDefault(field)
  return values
}

// `trailingCells` (optional): extra <td>s rendered between the field cells and
// the "+ Add" action cell, so the add row can align under tables that carry
// columns InlineAddRow doesn't own (e.g. Groups' per-week toggle column).
// `disabled` (optional): a screen-level guard (e.g. Tiers/TimeBlocks's
// `!activeCohort`). When true, the "+ Add" button is disabled and none of the
// three commit paths (click / Enter / blur-out-of-row) fire — so the row can
// never silently no-op a create when the screen isn't ready to accept one.
export default function InlineAddRow({ fields, onAdd, adding, trailingCells = null, disabled = false }) {
  const rowRef = useRef()
  const [values, setValues] = useState(() => initialValues(fields))

  const requiredFilled = fields.every(f => !f.required || String(values[f.key] ?? '').trim() !== '')
  const canAdd = requiredFilled && !adding && !disabled

  function setValue(key, value) {
    setValues(prev => ({ ...prev, [key]: value }))
  }

  async function commit() {
    if (!canAdd) return
    const ok = await onAdd(values)
    if (ok) setValues(initialValues(fields))
  }

  // Blur-to-commit, but only when focus leaves the row entirely (moving between
  // controls within the row must not commit a half-typed row). Copied from the
  // Days AddDayRow prototype — the rowRef.contains(relatedTarget) guard is
  // subtle and correct.
  function onRowBlur(e) {
    if (!canAdd) return
    if (rowRef.current && rowRef.current.contains(e.relatedTarget)) return
    commit()
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && canAdd) commit()
  }

  return (
    <tr
      ref={rowRef}
      onBlur={onRowBlur}
      style={{ borderTop: '1px solid var(--border)', background: 'var(--bg)' }}
    >
      {fields.map(field => (
        <td key={field.key} style={S.td}>
          {field.type === 'select' ? (
            <select
              value={values[field.key]}
              onChange={e => setValue(field.key, e.target.value)}
              onKeyDown={onKeyDown}
              style={{ ...S.input, background: 'var(--surface)', ...(field.width ? { width: field.width } : {}) }}
            >
              {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input
              type={field.type === 'time' ? 'time' : field.type === 'number' ? 'number' : 'text'}
              placeholder={field.placeholder}
              value={values[field.key]}
              onChange={e => setValue(field.key, e.target.value)}
              onKeyDown={onKeyDown}
              style={{ ...S.input, background: 'var(--surface)', ...(field.width ? { width: field.width } : {}) }}
            />
          )}
        </td>
      ))}
      {trailingCells}
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button
          className="press-97"
          onClick={commit}
          disabled={!canAdd}
          title="Add"
          style={canAdd ? { ...S.btnSecondary } : { ...S.btnSecondary, ...S.buttonDisabled }}
        >{adding ? 'Adding…' : '+ Add'}</button>
      </td>
    </tr>
  )
}
