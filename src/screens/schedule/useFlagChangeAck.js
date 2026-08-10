import { useEffect, useRef, useState } from 'react'

// A single director edit changes one (occasionally a couple of) cells' flag
// state. Anything wider than this is generation, undo/replay, or a route/view
// switch reloading the whole grid — none of those get the quiet ack.
export const MAX_SINGLE_EDIT_CELLS = 3

function cellKeyFor(slot) {
  return `${slot.group_id}|${slot.day_id}|${slot.time_block_id}`
}

// Active flags only — a dismissed flag no longer renders, so it must not
// register as "still there" for the purposes of detecting a change.
function flagSignature(slot) {
  const flags = slot.flags || {}
  return Object.keys(flags)
    .filter(k => flags[k] && !flags[`${k}_dismissed`])
    .sort()
    .join(',')
}

function escapeAttrValue(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

function buildMap(slots) {
  const map = new Map()
  for (const s of slots) map.set(cellKeyFor(s), flagSignature(s))
  return map
}

// Post-edit consequence feedback (design spec Move 1). Diffs the flag
// signature of every cell across a `slots` change and, when the diff looks
// like exactly one director edit, writes `data-flag-changed` directly onto
// the affected cell DOM node(s) so scheduleGrid.css can play a quiet
// acknowledgement — never through React state or a SlotCell prop.
//
// `resyncToken` makes the guard ACTION-aware, not just magnitude-aware: a
// single-cell undo, or a regeneration that happens to differ in <=3 cells, is
// structurally identical to a real edit and would otherwise re-fire the ack.
// The caller bumps `resyncToken` whenever it performs a non-edit that reloads
// slots (undo, redo, generation); a bump wipes the map so the next diff behaves
// like first-render and emits nothing. The ack then belongs only to genuine
// director edits, which never bump the token.
export function useFlagChangeAck(slots, route, resyncToken = 0) {
  const prevMapRef = useRef(new Map())
  const prevRouteRef = useRef(route)
  const prevResyncRef = useRef(resyncToken)

  // A route switch is a wholesale reload, not an edit. Resetting the ref to
  // empty makes the next diff behave exactly like first-render (emits
  // nothing), regardless of what the two routes' flag signatures look like.
  // Skipped on mount (prevRouteRef already matches) — only an actual route
  // change should wipe the map that this render's useMemo just populated.
  useEffect(() => {
    if (prevRouteRef.current !== route) {
      prevRouteRef.current = route
      prevMapRef.current = new Map()
    }
  }, [route])

  // Same wipe, driven by the caller's action signal rather than the route.
  // Declared before the slots-diff effect so that when an undo/generation
  // changes the token AND the slots in the same commit, the map is emptied
  // first and the ensuing diff emits nothing. Skipped on mount.
  useEffect(() => {
    if (prevResyncRef.current !== resyncToken) {
      prevResyncRef.current = resyncToken
      prevMapRef.current = new Map()
    }
  }, [resyncToken])

  const [changedKeys, setChangedKeys] = useState([])

  // Refs must not be read/written during render (react-hooks/refs), so the
  // diff — including the ref mutation that carries state across renders —
  // runs here, once per `slots` change, rather than in a useMemo.
  useEffect(() => {
    const newMap = buildMap(slots)
    const oldMap = prevMapRef.current

    let result = []
    if (oldMap.size > 0) {
      const changed = []
      let addedOrRemoved = 0
      for (const [key, sig] of newMap) {
        if (!oldMap.has(key)) { addedOrRemoved += 1; continue }
        if (oldMap.get(key) !== sig) changed.push(key)
      }
      for (const key of oldMap.keys()) {
        if (!newMap.has(key)) addedOrRemoved += 1
      }
      if (changed.length <= MAX_SINGLE_EDIT_CELLS && addedOrRemoved <= MAX_SINGLE_EDIT_CELLS) {
        result = changed
      }
    }

    prevMapRef.current = newMap
    setChangedKeys(result)
  }, [slots])

  useEffect(() => {
    if (changedKeys.length === 0) return
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    for (const key of changedKeys) {
      const el = document.querySelector(`[data-cell-key="${escapeAttrValue(key)}"]`)
      if (!el) continue
      el.setAttribute('data-flag-changed', '')
      const onEnd = () => el.removeAttribute('data-flag-changed')
      el.addEventListener('animationend', onEnd, { once: true })
    }
  }, [changedKeys])

  return changedKeys
}
