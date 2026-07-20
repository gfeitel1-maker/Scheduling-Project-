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
export function usePendingConflicts() {
  const [conflicts, setConflicts] = useState([])
  const [users, setUsers] = useState([])
  const [deviceId, setDeviceId] = useState(null)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

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

    return () => {
      mountedRef.current = false
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

    // Deliberately does NOT remove the conflict from state here. The card
    // itself owns a checkmark-hold-then-collapse animation that must run to
    // completion before the conflict disappears from anywhere; removing it
    // immediately would unmount the card before that animation could ever
    // render. Removal happens later, via dismissResolvedConflict, called by
    // the card at the end of its own local animation sequence.
    return result
  }, [conflicts])

  const dismissResolvedConflict = useCallback((conflictId) => {
    setConflicts((prev) => prev.filter((c) => c.id !== conflictId))
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
  }
}
