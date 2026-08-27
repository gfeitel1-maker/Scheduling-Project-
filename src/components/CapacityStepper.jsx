import { useState } from 'react'
import { S } from '../styles/shared'

// The segmented [ – | n | + ] control from the design spec ("a named
// component: CapacityStepper"), shared by LocationsScreen, LocationPicker,
// and ActivitiesScreen. `min` defaults to 1 (LocationsScreen's original
// floor — 0 meant "unlimited" pre-ADR and the control cannot express it);
// callers with a different floor (e.g. min_per_week >= 0) pass `min={0}`.
// Still keyboard-typeable in the middle cell.
export function CapacityStepper({ value, onChange, disabled, ariaLabel = 'Groups at once', min = 1 }) {
  const n = Number(value) || min
  // Typed text is tracked separately from the committed `n` so the field can
  // sit empty mid-edit (select-all-and-retype) without the controlled value
  // snapping back on every keystroke. Only a commit (blur/Enter, or a
  // +/- click) can change what the parent holds, and a commit always floors
  // to >=min — the field can look empty, it can never SAVE empty or below-floor.
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
    const clamped = Math.max(min, Math.round(next) || min)
    setText(String(clamped))
    if (clamped !== n) onChange(clamped)
  }

  return (
    <div style={stepperStyles.wrap}>
      <button
        type="button"
        className="press-97"
        onClick={() => commit(n - 1)}
        disabled={disabled || n <= min}
        aria-label="Decrease"
        style={{ ...stepperStyles.btn, ...(disabled || n <= min ? S.buttonDisabled : {}) }}
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
        onBlur={() => commit(parseInt(text, 10) || min)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        style={stepperStyles.input}
        aria-label={ariaLabel}
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
