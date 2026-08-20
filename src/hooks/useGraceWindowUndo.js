import { useCallback, useEffect, useRef, useState } from 'react'
import { localClient } from '../localClient'

// U1 — grace-window undo (docs/adr/2026-08-17-onescreen-reconciliation-undo.md,
// Invariant 5). This state lives ONLY in a hook a mounted component owns —
// never module-level, never persisted — so it is provably scoped to the
// screen instance/session: it is lost on navigation away (the component
// unmounting), on a renderer reload, and on app close. The UI copy this
// drives must say "for the next few minutes", never "always available"
// (Invariant 5c) — that honesty lives with the caller's copy, not here.
//
// Grace-window duration: 5 minutes. The mechanism works under any duration
// (ADR open question #2, Designer's call) — this is a reasonable default,
// not a tuned value.
export const GRACE_WINDOW_MS = 5 * 60 * 1000

const IDLE = 'idle'
const LIVE = 'live'
const USED = 'used'
const EXPIRED = 'expired'

export function useGraceWindowUndo() {
  const [status, setStatus] = useState(IDLE)
  const [invertibleOps, setInvertibleOps] = useState([])
  const [createdEntityIds, setCreatedEntityIds] = useState([])
  const [skipped, setSkipped] = useState([])
  const [deleted, setDeleted] = useState([])
  const [kept, setKept] = useState([])
  const [undoError, setUndoError] = useState(null)
  const [isPending, setIsPending] = useState(false)
  const timerRef = useRef(null)
  // Synchronous double-submit guard: `status` only flips to `used` after the
  // ingestUndo await resolves, so two fast clicks would both pass a
  // status-only check and fire two ingestUndo calls, writing redundant
  // __deleted__ ops into the permanent peer-replicated op-log. The REF is
  // the actual guard, set BEFORE the await, not state — a second call's
  // synchronous check must see it immediately, and a state update wouldn't
  // be visible until re-render. `isPending` state exists only to drive the
  // button's `disabled` prop.
  const pendingRef = useRef(false)
  // Unmount guard. undo() awaits ingestUndo, which can resolve (or reject)
  // after the owning component has unmounted — e.g. the director clicks
  // "Undo this import" and then navigates away before the IPC returns. Once
  // unmounted, its setState calls (including setUndoError on failure) would be
  // swallowed with a React warning AND, worse, a FAILED undo's error would go
  // unsurfaced. This ref lets undo() skip those post-unmount setStates
  // cleanly. Safe for every consumer: it only prevents setState on a dead
  // instance, never changes behavior while mounted.
  const isMountedRef = useRef(true)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      clearTimer()
    }
  }, [])

  // Starting a NEW import while a grace window is live immediately clears
  // the prior window's state (Invariant 5b) — there is exactly one live
  // undo affordance at a time, enforced by this same state being
  // overwritten, not by a separate lock.
  const start = useCallback((outcome) => {
    clearTimer()
    setStatus(LIVE)
    setInvertibleOps(Array.isArray(outcome?.invertibleOps) ? outcome.invertibleOps : [])
    setCreatedEntityIds(Array.isArray(outcome?.createdEntityIds) ? outcome.createdEntityIds : [])
    setSkipped([])
    setDeleted([])
    setKept([])
    setUndoError(null)
    timerRef.current = setTimeout(() => setStatus((s) => (s === LIVE ? EXPIRED : s)), GRACE_WINDOW_MS)
  }, [])

  const clear = useCallback(() => {
    clearTimer()
    setStatus(IDLE)
    setInvertibleOps([])
    setCreatedEntityIds([])
    setSkipped([])
    setDeleted([])
    setKept([])
    setUndoError(null)
  }, [])

  // After a successful undo, the SAME held invertibleOps/createdEntityIds is
  // not re-usable — the state transitions to a terminal `used` status the
  // instant ingestUndo returns ok, so a second click on the same affordance
  // is a no-op at the UI layer before it ever reaches IPC again (mechanism
  // step 5).
  const undo = useCallback(async () => {
    if (status !== LIVE || pendingRef.current) return
    pendingRef.current = true
    setIsPending(true)
    setUndoError(null)
    try {
      const result = await localClient.ingestUndo({
        invertibleOps,
        createdEntityIds,
        client_write_id: crypto.randomUUID(),
      })
      // Component gone (director navigated away mid-undo): the revert still
      // committed at the op-log, but there is no live UI to report it to —
      // skip the setStates rather than warn on a dead instance.
      if (!isMountedRef.current) return
      clearTimer()
      setStatus(USED)
      setSkipped(Array.isArray(result?.skipped) ? result.skipped : [])
      setDeleted(Array.isArray(result?.deleted) ? result.deleted : [])
      setKept(Array.isArray(result?.kept) ? result.kept : [])
    } catch (err) {
      // Deliberate: leave `status` at LIVE on error so the director can
      // retry the same grace window rather than losing the affordance to a
      // transient IPC failure. Only surface the error if the component is
      // still mounted — a post-unmount rejection has no UI to show it in.
      if (isMountedRef.current) {
        setUndoError(err?.message ?? 'Could not undo this import.')
      }
    } finally {
      if (isMountedRef.current) {
        pendingRef.current = false
        setIsPending(false)
      }
    }
  }, [status, invertibleOps, createdEntityIds])

  return {
    status,
    isLive: status === LIVE,
    isPending,
    createdEntityIds,
    skipped,
    deleted,
    kept,
    undoError,
    start,
    clear,
    undo,
  }
}
