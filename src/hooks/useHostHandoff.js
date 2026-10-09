import { useCallback, useEffect, useRef, useState } from 'react'
import { localClient } from '../localClient'

// The host handoff's live state (docs/adr/2026-10-09-host-succession-simple.md). The main process
// pushes a bare "changed" signal; the truth is re-read from handoffStatus. While a handoff is in
// flight the status is also re-read on a short interval, so a missed push cannot leave a control
// stuck on a stale state.
export function useHostHandoff() {
  const [status, setStatus] = useState(null)
  const live = useRef(true)

  const refresh = useCallback(() => (
    localClient.handoffStatus()
      .then((next) => { if (live.current) setStatus(next) })
      // Not signed in yet, or the call is unavailable: the handoff controls simply stay hidden.
      .catch(() => {})
  ), [])

  useEffect(() => {
    live.current = true
    refresh()
    const unsubscribe = localClient.onHandoffChanged(refresh)
    return () => {
      live.current = false
      unsubscribe?.()
    }
  }, [refresh])

  const inFlight = Boolean(status?.handoff)
  useEffect(() => {
    if (!inFlight) return undefined
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [inFlight, refresh])

  return { status, refresh }
}
