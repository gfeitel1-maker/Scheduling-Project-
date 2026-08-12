import { useState, useMemo, useRef, useEffect } from 'react'
import { normalizeName } from '../../ingest/preview.js'

// Hosted inside SlotCell when that cell is the active inline-write target.
// One component owns typing, local filter state and Enter/Escape — there is
// no separate "matcher" module because the match rule is one line (normalized
// substring) and splitting it out would be an abstraction with one caller.
export default function CellInlineEditor({
  eligibleActivities, currentActivityName, onPlace, onCreateNew, onCancel,
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef(null)
  const committedRef = useRef(false)

  useEffect(() => { inputRef.current?.focus() }, [])

  const query = normalizeName(value)
  const matches = useMemo(() => {
    if (!query) return []
    return eligibleActivities.filter(a => normalizeName(a.name).includes(query))
  }, [eligibleActivities, query])

  const exact = useMemo(
    () => eligibleActivities.find(a => normalizeName(a.name) === query) ?? null,
    [eligibleActivities, query]
  )

  function commitTop() {
    if (!query) return
    committedRef.current = true
    if (exact) { onPlace(exact.id); return }
    if (matches.length > 0) { onPlace(matches[0].id); return }
    onCreateNew(value.trim())
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitTop(); return }
    if (e.key === 'Escape') { e.preventDefault(); committedRef.current = true; onCancel(); return }
  }

  function handleBlur() {
    if (committedRef.current) return
    onCancel()
  }

  return (
    <div className="cell-inline-editor" onClick={e => e.stopPropagation()}>
      <input
        ref={inputRef}
        role="textbox"
        type="text"
        className="cell-inline-editor-input"
        value={value}
        placeholder={currentActivityName || 'Type an activity…'}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
      {query && !exact && (
        <div className="cell-inline-editor-suggestions">
          {matches.map(a => (
            <div
              key={a.id}
              className="cell-inline-editor-suggestion"
              onMouseDown={() => { committedRef.current = true; onPlace(a.id) }}
            >
              {a.name}
            </div>
          ))}
          {matches.length === 0 && (
            <div
              className="cell-inline-editor-suggestion cell-inline-editor-suggestion--create"
              onMouseDown={() => { committedRef.current = true; onCreateNew(value.trim()) }}
            >
              Create "{value.trim()}"
            </div>
          )}
        </div>
      )}
    </div>
  )
}
