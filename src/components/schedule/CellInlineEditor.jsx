import { useState, useMemo, useRef, useEffect } from 'react'
import { normalizeName } from '../../ingest/preview.js'

// T105 §1 — colon-delimiter grammar: `<set name>: <member 1>, <member 2>`.
// Everything before the first `:` is the set name (trimmed); everything
// after, split on `,`, trimmed, empty tokens dropped, is member names.
function parseElectiveGrammar(value) {
  const idx = value.indexOf(':')
  if (idx === -1) return null
  const setName = value.slice(0, idx).trim()
  const memberNames = value.slice(idx + 1).split(',').map(s => s.trim()).filter(Boolean)
  return { setName, memberNames }
}

// Hosted inside SlotCell when that cell is the active inline-write target.
// One component owns typing, local filter state and Enter/Escape — there is
// no separate "matcher" module because the match rule is one line (normalized
// substring) and splitting it out would be an abstraction with one caller.
export default function CellInlineEditor({
  eligibleActivities, currentActivityName, onPlace, onCreateNew, onCreateElective, onCancel,
  // Events overlay placement Slice 1 (docs/adr/2026-08-22-events-overlay-
  // placement.md §5) — eligibleEvents is a second typeahead source, sibling
  // to eligibleActivities; onPlaceEvent is its commit path. An event has no
  // "create new" grammar in Slice 1 (only existing events are placeable, same
  // posture as an exact activity match) — no colon grammar, no create branch.
  eligibleEvents = [], onPlaceEvent,
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

  const eventMatches = useMemo(() => {
    if (!query) return []
    return eligibleEvents.filter(e => normalizeName(e.name).includes(query))
  }, [eligibleEvents, query])

  const exact = useMemo(
    () => eligibleActivities.find(a => normalizeName(a.name) === query) ?? null,
    [eligibleActivities, query]
  )

  // Exact-match-first, same precedence discipline as the activity `exact`
  // above — checked only when no activity claimed the exact match, so an
  // activity literally sharing a name with an event resolves to the
  // activity (activity_id survives event_id in the exclusivity precedence
  // order, ADR §3).
  const exactEvent = useMemo(
    () => (exact ? null : eligibleEvents.find(e => normalizeName(e.name) === query) ?? null),
    [eligibleEvents, query, exact]
  )

  // Live-typing render only — provisional, harmless (no write). The
  // commit-time check below is what actually decides which path fires.
  const hasColon = value.includes(':')
  const liveParsed = hasColon ? parseElectiveGrammar(value) : null

  function commitTop() {
    if (!query) return

    // Exact-match-first colon guard (design §1, Red Hat round 1): the WHOLE
    // typed string, colon included, checked against real activity names
    // BEFORE any colon-splitting — so an activity literally named
    // "Free Time: Cabin Choice" is never misfiled as a one-member elective.
    if (exact) { committedRef.current = true; onPlace(exact.id); return }

    // Events overlay placement Slice 1 — an exact event-name match places
    // the event, same precedence slot as the activity exact-match above
    // (checked before the colon grammar, so an event literally named with a
    // colon in it is never misfiled as elective grammar either).
    if (exactEvent && onPlaceEvent) { committedRef.current = true; onPlaceEvent(exactEvent.id); return }

    if (hasColon) {
      const parsed = parseElectiveGrammar(value)
      if (parsed && parsed.setName && onCreateElective) {
        committedRef.current = true
        onCreateElective(parsed.setName, parsed.memberNames, value.trim())
        return
      }
      // Invalid elective grammar — a colon with nothing (or only
      // whitespace) before it, e.g. ": Swimming" (Code Reviewer LOW). Do NOT
      // fall through to onCreateNew, which would mint an activity literally
      // named ": Swimming". committedRef stays false, so Enter is a no-op
      // here and the director keeps editing — the same "nothing happens
      // until the input is valid" behavior blur/Escape already give.
      return
    }

    if (matches.length > 0) { committedRef.current = true; onPlace(matches[0].id); return }
    if (eventMatches.length > 0 && onPlaceEvent) { committedRef.current = true; onPlaceEvent(eventMatches[0].id); return }
    committedRef.current = true
    onCreateNew(value.trim())
  }

  function handleKeyDown(e) {
    // Defense-in-depth: the primary fix is useGridKeyboardNav's own
    // '.cell-inline-editor' guard, but stopping propagation here means no
    // future ancestor keydown listener (grid nav or otherwise) can reach into
    // an open editor and act on a key this component didn't itself handle.
    e.stopPropagation()
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
      {query && !exact && hasColon && liveParsed && (
        <div className="cell-inline-editor-elective-chips">
          {liveParsed.memberNames.map((name, i) => {
            const known = eligibleActivities.some(a => normalizeName(a.name) === normalizeName(name))
            return (
              <span key={`${name}-${i}`} className="cell-inline-editor-chip" data-known={known ? '' : undefined}>
                {name}
              </span>
            )
          })}
        </div>
      )}
      {query && !exact && !exactEvent && !hasColon && (
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
          {onPlaceEvent && eventMatches.map(e => (
            <div
              key={e.id}
              className="cell-inline-editor-suggestion"
              onMouseDown={() => { committedRef.current = true; onPlaceEvent(e.id) }}
            >
              {e.name}
            </div>
          ))}
          {matches.length === 0 && eventMatches.length === 0 && (
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
