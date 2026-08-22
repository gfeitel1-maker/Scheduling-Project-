import { useEffect, useRef, useState } from 'react'

// T105 §5 (docs/work/specs/2026-08-20-elective-authoring-render-design.md).
// Structurally identical to useFlagChangeAck.js — same useRef map / useEffect
// diff / route-reset / local useState shape — with two differences: what it
// tracks per cell (content KIND, not flag signature) and what "this device's
// own recent write" means (a time window, not a same-render-cycle comparison;
// see RECENCY_WINDOW_MS below, the one place this hook's mechanism genuinely
// diverges from useFlagChangeAck's).
//
// Derived, render-time, locally-dismissible: no persisted op, no sync
// surface — mirrors the OVERLAP derived-flag pattern.
export const RECENCY_WINDOW_MS = 5000

function cellKeyFor(slot) {
  return `${slot.group_id}|${slot.day_id}|${slot.time_block_id}`
}

function contentKind(slot) {
  // Events overlay placement Slice 1 (docs/adr/2026-08-22-events-overlay-
  // placement.md §3) — event_id checked ahead of elective_set_id, matching
  // the activity/elective/event precedence order.
  if (slot.event_id) return `event:${slot.event_id}`
  if (slot.elective_set_id) return `elective:${slot.elective_set_id}`
  if (slot.activity_id) return `activity:${slot.activity_id}`
  return 'empty'
}

function buildKindMap(slots) {
  const map = new Map()
  for (const s of slots) map.set(cellKeyFor(s), contentKind(s))
  return map
}

// `ownWriteRef` is the shared ref useSlotMutations' runMutation populates at
// its own-success path (kind + atWriteToken per cell). This hook reads it, it
// does not own its lifetime — useSlotMutations persists it for the whole
// mount, same as its cellQueueRef.
export function useContentRaceFlag(slots, route, ownWriteRef) {
  const prevRouteRef = useRef(route)
  const [racedKeys, setRacedKeys] = useState([])
  const dismissedRef = useRef(new Set())
  // The record-then-optimistic-setSlots pair (runMutation's own-success path)
  // happens synchronously in the SAME tick, so the very first render this
  // hook observes after mount can already carry both — comparing on mount
  // itself would be comparing a write against its own trivial echo (or,
  // worse, against a stale pre-write `slots` the record hasn't caught up to
  // yet). Skipped exactly once, mirroring useFlagChangeAck's own
  // `oldMap.size > 0` mount guard — real ownWriteRef entries are only ever
  // added AFTER mount, so this never hides a genuine race.
  const isFirstRunRef = useRef(true)

  // A route switch is a wholesale reload, not a race — clear pending
  // own-write records and any raced/dismissed state so nothing re-fires
  // after the switch.
  useEffect(() => {
    if (prevRouteRef.current !== route) {
      prevRouteRef.current = route
      ownWriteRef.current.clear()
      dismissedRef.current = new Set()
      setRacedKeys([])
    }
  }, [route, ownWriteRef])

  useEffect(() => {
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false
      return
    }
    const newMap = buildKindMap(slots)
    const own = ownWriteRef.current
    const now = Date.now()
    const raced = []

    for (const [key, record] of [...own.entries()]) {
      // Stale — a write from long ago is noise, not signal. Drop it without
      // comparing.
      if (now - record.atWriteToken > RECENCY_WINDOW_MS) {
        own.delete(key)
        continue
      }
      const currentKind = newMap.get(key)
      // Cell no longer exists (route switch already cleared the ref anyway).
      if (currentKind === undefined) continue
      if (currentKind !== record.kind && !dismissedRef.current.has(key)) {
        raced.push(key)
      }
      // Consumed regardless of outcome — a cell is only ever checked against
      // the write that produced this entry, not every subsequent slots
      // change.
      own.delete(key)
    }

    if (raced.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRacedKeys(prev => [...new Set([...prev, ...raced])])
    }
  }, [slots, ownWriteRef])

  function dismiss(cellKey) {
    dismissedRef.current.add(cellKey)
    setRacedKeys(prev => prev.filter(k => k !== cellKey))
  }

  return { racedKeys, dismiss }
}
