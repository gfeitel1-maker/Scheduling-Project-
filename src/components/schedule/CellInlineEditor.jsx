import { useState, useMemo, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { whitespaceInsensitiveName } from '../../ingest/preview.js'

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
  // Packaged audit #26 — the camp's reusable elective sets, offered so a set is
  // discoverable from the week. Picking one goes through onCreateElective with
  // no members, which createElectiveFromCell resolves to the existing durable set.
  electiveSets = [],
}) {
  const [value, setValue] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const [anchor, setAnchor] = useState(null)
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const committedRef = useRef(false)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Audit-2 A10: the suggestion list is portalled to <body> and fixed-positioned
  // under the editor, so neither the cell nor the grid's overflow can clip it.
  // Re-anchored on any scroll (capture) or resize while the editor is open.
  useLayoutEffect(() => {
    function place() {
      const r = rootRef.current?.getBoundingClientRect()
      if (r) setAnchor({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 220) })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [])

  const query = whitespaceInsensitiveName(value)
  const matches = useMemo(() => {
    if (!query) return []
    return eligibleActivities.filter(a => whitespaceInsensitiveName(a.name).includes(query))
  }, [eligibleActivities, query])

  const eventMatches = useMemo(() => {
    if (!query) return []
    return eligibleEvents.filter(e => whitespaceInsensitiveName(e.name).includes(query))
  }, [eligibleEvents, query])

  const durableSets = useMemo(
    () => (onCreateElective ? electiveSets.filter(s => Number(s.is_reusable) !== 0) : []),
    [electiveSets, onCreateElective]
  )

  const electiveMatches = useMemo(() => {
    if (!query) return []
    return durableSets.filter(s => whitespaceInsensitiveName(s.name).includes(query))
  }, [durableSets, query])

  const exact = useMemo(
    () => eligibleActivities.find(a => whitespaceInsensitiveName(a.name) === query) ?? null,
    [eligibleActivities, query]
  )

  // Exact-match-first, same precedence discipline as the activity `exact`
  // above — checked only when no activity claimed the exact match, so an
  // activity literally sharing a name with an event resolves to the
  // activity (activity_id survives event_id in the exclusivity precedence
  // order, ADR §3).
  const exactEvent = useMemo(
    () => (exact ? null : eligibleEvents.find(e => whitespaceInsensitiveName(e.name) === query) ?? null),
    [eligibleEvents, query, exact]
  )

  const exactElective = useMemo(
    () => (exact || exactEvent ? null : durableSets.find(s => whitespaceInsensitiveName(s.name) === query) ?? null),
    [durableSets, query, exact, exactEvent]
  )

  function placeElective(set) {
    committedRef.current = true
    onCreateElective(set.name, [], set.name)
  }

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

    if (exactElective) { placeElective(exactElective); return }

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
    if (electiveMatches.length > 0) { placeElective(electiveMatches[0]); return }
    committedRef.current = true
    onCreateNew(value.trim())
  }

  // One ordered list drives both the rendered rows and arrow-key navigation.
  // With nothing typed it offers the camp's reusable elective sets, so a set is
  // findable from the cell without knowing its name (audit-2 A9).
  const options = useMemo(() => {
    if (hasColon || exact || exactEvent) return []
    const sets = list => list.map(set => ({ key: `es-${set.id}`, label: set.name, kind: 'elective', item: set }))
    if (!query) return sets(durableSets)
    const rows = [
      ...matches.map(a => ({ key: `a-${a.id}`, label: a.name, kind: 'activity', item: a })),
      ...(onPlaceEvent ? eventMatches.map(ev => ({ key: `e-${ev.id}`, label: ev.name, kind: 'event', item: ev })) : []),
      ...sets(electiveMatches),
    ]
    return rows.length > 0 ? rows : [{ key: 'create', label: `Create "${value.trim()}"`, kind: 'create' }]
  }, [hasColon, exact, exactEvent, query, durableSets, matches, eventMatches, electiveMatches, onPlaceEvent, value])

  function pick(option) {
    if (option.kind === 'elective') { placeElective(option.item); return }
    committedRef.current = true
    if (option.kind === 'activity') onPlace(option.item.id)
    else if (option.kind === 'event') onPlaceEvent(option.item.id)
    else onCreateNew(value.trim())
  }

  function handleKeyDown(e) {
    // Defense-in-depth: the primary fix is useGridKeyboardNav's own
    // '.cell-inline-editor' guard, but stopping propagation here means no
    // future ancestor keydown listener (grid nav or otherwise) can reach into
    // an open editor and act on a key this component didn't itself handle.
    e.stopPropagation()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (options.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActiveIndex(i => (i + step + options.length) % options.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (options[activeIndex]) { pick(options[activeIndex]); return }
      commitTop()
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); committedRef.current = true; onCancel(); return }
  }

  function handleBlur() {
    if (committedRef.current) return
    onCancel()
  }

  return (
    <div ref={rootRef} className="cell-inline-editor" onClick={e => e.stopPropagation()}>
      <input
        ref={inputRef}
        role="textbox"
        type="text"
        className="cell-inline-editor-input"
        value={value}
        placeholder={currentActivityName || 'Activity'}
        aria-expanded={options.length > 0}
        onChange={e => { setValue(e.target.value); setActiveIndex(-1) }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
      {query && !exact && hasColon && liveParsed && (
        <div className="cell-inline-editor-elective-chips">
          {liveParsed.memberNames.map((name, i) => {
            const known = eligibleActivities.some(a => whitespaceInsensitiveName(a.name) === whitespaceInsensitiveName(name))
            return (
              <span key={`${name}-${i}`} className="cell-inline-editor-chip" data-known={known ? '' : undefined}>
                {name}
              </span>
            )
          })}
        </div>
      )}
      {options.length > 0 && anchor && createPortal(
        <div
          className="cell-inline-editor-suggestions"
          role="listbox"
          // A portal still bubbles React events to the cell; keep a press here
          // from reaching the cell's drag listeners or click handler.
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          style={{ position: 'fixed', top: anchor.top, left: anchor.left, width: anchor.width }}
        >
          {!query && <div className="cell-inline-editor-suggestions-heading">Elective sets</div>}
          {options.map((o, i) => (
            <div
              key={o.key}
              role="option"
              aria-selected={i === activeIndex}
              className={o.kind === 'create' ? 'cell-inline-editor-suggestion cell-inline-editor-suggestion--create' : 'cell-inline-editor-suggestion'}
              onMouseDown={e => { e.preventDefault(); pick(o) }}
              style={o.kind === 'elective' ? { display: 'flex', alignItems: 'center', gap: 6 } : undefined}
            >
              {o.kind === 'elective' ? (
                <>
                  <span title={o.label} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
                  <span style={ELECTIVE_TAG}>Elective</span>
                </>
              ) : o.label}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

const ELECTIVE_TAG = {
  fontSize: 10, fontWeight: 600, padding: '0 5px', borderRadius: 4, flexShrink: 0,
  color: 'var(--secondary)', background: 'color-mix(in srgb, var(--secondary) 12%, transparent)',
}
