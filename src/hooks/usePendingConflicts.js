import { useCallback, useEffect, useRef, useState } from 'react'
import { localClient } from '../localClient'

// Fields whose raw op.value must never reach the UI layer. Checked here, at
// the data-fetch boundary, so a PIN value never even makes it into a React
// prop or a console.log downstream — not just skipped at render time.
const PIN_FIELDS = new Set(['pin_hash', 'pin_salt'])

function isPinField(entity, field) {
  return entity === 'users' && PIN_FIELDS.has(field)
}

// Strips a raw op (as received over the wire/IPC) down to only what the UI
// is allowed to hold onto. PIN ops never carry `value` past this point.
function sanitizeSide(op) {
  if (!op) return null
  const base = {
    op_id: op.id,
    author_user_id: op.author_user_id ?? null,
    device_id: op.device_id ?? null,
    timestamp: op.timestamp ?? null,
  }
  if (isPinField(op.entity, op.field)) return base
  return { ...base, value: op.value }
}

function conflictKey(entity, entity_id, field, existingOpId) {
  return `${entity}:${entity_id}:${field}:${existingOpId}`
}

// Normalizes a raw { type: 'op_conflict', incomingOp, existingOp } message
// (the only shape this backend currently emits — sent back to the submitting
// device, which covers both "my own write collided" and any future
// broadcast-to-other-clients variant of the same message) into the UI's
// uniform conflict record. Named sideA/sideB deliberately — 'incomingOp' /
// 'existingOp' are transport-level names and must not leak into the UI.
function normalizeConflict(msg) {
  const { incomingOp, existingOp } = msg
  if (!incomingOp || !existingOp) return null
  const entity = existingOp.entity
  const entity_id = existingOp.entity_id
  const field = existingOp.field
  return {
    id: conflictKey(entity, entity_id, field, existingOp.id),
    entity,
    entity_id,
    field,
    isPin: isPinField(entity, field),
    sideA: sanitizeSide(incomingOp),
    sideB: sanitizeSide(existingOp),
  }
}

// Single source of truth for pending conflicts: feeds both the Sidebar badge
// count and the ConflictsScreen list. Fed exclusively by the main process's
// `shoresh:op-conflict` broadcast (wired from syncClient.onOpConflict in
// electron/main.js), so it doesn't matter whether a conflict originated from
// this device's own direct write or an incoming peer op — one channel, one
// dedupe, one list.
// How long a resolved card holds its checkmark before collapsing away, in
// ms — must match ConflictCard's local animation timing (1100ms hold + 380ms
// collapse transition, see shared.js mergeCard).
const RESOLVED_HOLD_MS = 1100
const RESOLVED_COLLAPSE_MS = 380

export function usePendingConflicts() {
  const [conflicts, setConflicts] = useState([])
  const [users, setUsers] = useState([])
  const [deviceId, setDeviceId] = useState(null)
  const [loading, setLoading] = useState(true)
  // Task 10 round-4 Fix 1: conflictId -> { side, queued } for a
  // resolved-but-not-yet-dismissed conflict. This state — and the dismiss
  // timer that clears it — lives HERE, in the hook, not in ConflictCard.
  // The hook is the shared instance App.jsx keeps mounted for the whole app
  // lifetime (per the module comment above), so it survives the director
  // navigating away and back. A ConflictCard only ever reads this map; it
  // never owns a setTimeout whose callback can outlive the card and act on
  // shared state after the card that scheduled it is gone. If a fresh card
  // remounts for a conflict already in this map, it renders the resolved
  // state immediately instead of a pristine "unresolved" one that would
  // later vanish unexplained.
  const [resolvedMeta, setResolvedMeta] = useState({})
  const mountedRef = useRef(true)
  const dismissTimersRef = useRef({}) // conflictId -> timeout id
  const resolvedMetaRef = useRef({}) // mirror of resolvedMeta for stable callbacks

  useEffect(() => {
    mountedRef.current = true
    Promise.all([localClient.listUsers(), localClient.getDeviceId()])
      .then(([userList, devId]) => {
        if (!mountedRef.current) return
        setUsers(userList || [])
        setDeviceId(devId || null)
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false)
      })

    // Rehydration (Fix 3): the live onOpConflict broadcast below only ever
    // fires for conflicts that occur WHILE this hook is mounted. Without
    // this fetch, any conflict pending before an app relaunch — resolved-
    // but-not-yet-dismissed, or plain unresolved — would silently vanish
    // from the UI on restart, even though it's durably recorded in the
    // op-log-backed conflicts table. Fetched once on mount; dedupes against
    // the live path by conflictKey the same way the live handler does.
    localClient
      .listPendingConflicts()
      .then((msgs) => {
        if (!mountedRef.current || !Array.isArray(msgs)) return
        const normalized = msgs.map(normalizeConflict).filter(Boolean)
        if (normalized.length === 0) return
        setConflicts((prev) => {
          const seen = new Set(prev.map((c) => c.id))
          const toAdd = normalized.filter((c) => !seen.has(c.id))
          return toAdd.length ? [...prev, ...toAdd] : prev
        })
      })
      .catch(() => {
        // best-effort: a rehydration failure must not block the rest of the
        // screen (live conflicts still work via the broadcast below)
      })

    localClient.onOpConflict((msg) => {
      const normalized = normalizeConflict(msg)
      if (!normalized) return
      setConflicts((prev) => {
        if (prev.some((c) => c.id === normalized.id)) return prev
        return [...prev, normalized]
      })
    })

    // Task 10 round-4 Fix 3 (renderer-side reconciliation): op_applied fires
    // for every op this device applies, including catch-up ops replayed by
    // the Host on reconnect (see syncServer.js's sendMissedOps). If one of
    // those catch-up ops is a resolution for a conflict this screen is
    // currently showing as pending, re-check the durable pending-conflicts
    // list and drop anything no longer in it. This closes the gap where the
    // underlying data (operations table / listPendingConflicts) is already
    // correct but a screen that's been open the whole time wouldn't
    // otherwise know to re-render. Scope: this only reconciles conflicts
    // already visible in THIS mounted screen; it does not by itself deliver
    // brand-new conflicts (those already arrive via onOpConflict above).
    if (typeof localClient.onOpApplied === 'function') {
      localClient.onOpApplied(() => {
        localClient
          .listPendingConflicts()
          .then((msgs) => {
            if (!mountedRef.current || !Array.isArray(msgs)) return
            const stillPending = new Set(msgs.map(normalizeConflict).filter(Boolean).map((c) => c.id))
            setConflicts((prev) =>
              prev.filter((c) => stillPending.has(c.id) || resolvedMetaRef.current[c.id])
            )
          })
          .catch(() => {
            // best-effort: never let a reconciliation-fetch failure disrupt
            // the live conflict list
          })
      })
    }

    const timers = dismissTimersRef.current
    return () => {
      mountedRef.current = false
      // Clear every pending dismiss timer on hook teardown (app close / test
      // unmount). This hook is otherwise long-lived for the app's lifetime,
      // so this mainly guards test environments and StrictMode double-invoke,
      // but it's the correct thing to do regardless.
      for (const id of Object.keys(timers)) clearTimeout(timers[id])
    }
  }, [])

  const resolveConflict = useCallback(async (conflictId, chosenSide) => {
    const conflict = conflicts.find((c) => c.id === conflictId)
    if (!conflict) return { status: 'error' }
    const chosen = chosenSide === 'A' ? conflict.sideA : conflict.sideB
    if (!chosen) return { status: 'error' }

    const token = localStorage.getItem('shoresh-token')
    // Resolution is by op id, not value — the renderer never sends a value
    // back for ANY field (this also means a PIN field's hash never has to
    // flow through this hook to be "kept"; the main process looks the value
    // up itself from the op-log by id). Parent to the LOSING op's id (side B,
    // the existing op this conflict was raised against) so the resolution
    // write doesn't itself look like a fresh unresolved conflict.
    const result = await localClient.resolveConflict(token, {
      entity: conflict.entity,
      entity_id: conflict.entity_id,
      field: conflict.field,
      chosen_op_id: chosen.op_id,
      parent_op_id: conflict.sideB.op_id,
    })

    // Task 10 round-4 Fix 1: the resolve IPC call has already succeeded (or
    // definitively failed) by this point — that outcome is durable now,
    // regardless of whether the ConflictCard that triggered it is still
    // mounted. On success, record it HERE (in the hook, which outlives any
    // individual card) and schedule the eventual removal from `conflicts`
    // ourselves, via a timer tracked in dismissTimersRef so it can never
    // double-schedule and is cleared on hook teardown. A ConflictCard is a
    // pure function of this state: it shows the checkmark whenever
    // resolvedMeta has an entry for its conflict id, whether that's because
    // it just called keep() itself or because it's a fresh remount for a
    // conflict that was already resolved while it was unmounted.
    if (result && (result.status === 'applied' || result.status === 'queued')) {
      setResolvedMeta((prev) => {
        const next = { ...prev, [conflictId]: { side: chosenSide, queued: result.status === 'queued' } }
        resolvedMetaRef.current = next
        return next
      })
      if (!dismissTimersRef.current[conflictId]) {
        dismissTimersRef.current[conflictId] = setTimeout(() => {
          delete dismissTimersRef.current[conflictId]
          setConflicts((prev) => prev.filter((c) => c.id !== conflictId))
          setResolvedMeta((prev) => {
            if (!(conflictId in prev)) return prev
            const { [conflictId]: _removed, ...rest } = prev
            resolvedMetaRef.current = rest
            return rest
          })
        }, RESOLVED_HOLD_MS + RESOLVED_COLLAPSE_MS)
      }
    }

    return result
  }, [conflicts])

  // Kept for the card's local collapse-transition timing only (see
  // ConflictCard) — it no longer performs the actual removal from shared
  // state; the hook's own timer (scheduled in resolveConflict above) owns
  // that. Calling this early/late/never no longer corrupts anything.
  const dismissResolvedConflict = useCallback((conflictId) => {
    setConflicts((prev) => prev.filter((c) => c.id !== conflictId))
    setResolvedMeta((prev) => {
      if (!(conflictId in prev)) return prev
      const { [conflictId]: _removed, ...rest } = prev
      resolvedMetaRef.current = rest
      return rest
    })
    const timer = dismissTimersRef.current[conflictId]
    if (timer) {
      clearTimeout(timer)
      delete dismissTimersRef.current[conflictId]
    }
  }, [])

  function resolveAuthorLabel(side) {
    if (!side) return 'Unknown'
    if (side.device_id && side.device_id === deviceId) return 'This computer'
    if (side.author_user_id) {
      const user = users.find((u) => u.id === side.author_user_id)
      if (user) return user.name
    }
    if (side.device_id) return `Device ${side.device_id.slice(0, 6)}`
    return 'Unknown'
  }

  return {
    conflicts,
    loading,
    resolveConflict,
    dismissResolvedConflict,
    resolveAuthorLabel,
    // conflictId -> { side, queued } for a resolved-but-not-yet-dismissed
    // conflict — see the Fix 1 comment above resolveConflict.
    resolvedMeta,
  }
}
