import { useCallback, useEffect, useRef, useState } from 'react'
import { localClient } from '../localClient'

const MODE_KEY = 'shoresh-mode'
const TOKEN_KEY = 'shoresh-token'
const ROLE_KEY = 'shoresh-role'
const JOIN_HOST_KEY = 'shoresh-join-host'
const DEFAULT_HOST_PORT = 7777

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// T87 fix round: a director staring at a bounced-to-login screen with no
// explanation can't tell "my token just expired" from "this tablet was
// revoked and needs re-approval." 4403/4404 mean the Host actively decided
// this device is no longer trusted — that needs an actionable, human
// message. Every other code (4401, 4402, unknown) is treated as benign so
// close-code numbers never leak into UI copy.
const DEVICE_REVOKED_CODES = new Set([4403, 4404])
const DEVICE_REVOKED_REASON =
  "This device's access was removed. Ask your director or admin to re-approve it, then sign in again."
const BENIGN_SESSION_ENDED_REASON = 'Your session ended. Please sign in again.'

function reasonForAuthRejectedCode(code) {
  return DEVICE_REVOKED_CODES.has(code) ? DEVICE_REVOKED_REASON : BENIGN_SESSION_ENDED_REASON
}

// Drives the App.jsx state machine: which top-level screen to show, given
// what's been persisted on this device (mode, join target, session token)
// and what the local backend currently reports (camp existence).
export function useDeviceMode() {
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState(() => localStorage.getItem(MODE_KEY))
  const [joinHost, setJoinHost] = useState(() => readJSON(JOIN_HOST_KEY))
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY))
  // Persisted alongside the token (same lifecycle: set on login, cleared on
  // logout/invalid-session) rather than re-fetched via verifySession on every
  // reload — avoids an extra state where a valid token exists but role is
  // briefly unknown, and mirrors how token itself is trusted-but-unverified
  // until verifySession confirms it below.
  const [role, setRole] = useState(() => localStorage.getItem(ROLE_KEY))
  const [camp, setCamp] = useState(null)
  // Stage-aware landing (docs/adr/2026-08-28-stage-aware-nav-landing.md
  // Decision 1) — resolved once per app open inside the init() effect below,
  // alongside refreshCamp/verifySession, so it is available synchronously at
  // AppShell's mount (App.jsx reads it as the `screen` useState initializer).
  // null until resolved; App.jsx's `phase === 'loading'` gate means nothing
  // reads this before it settles to a boolean.
  const [campIsEmpty, setCampIsEmpty] = useState(null)
  const [error, setError] = useState(null)
  const [initNonce, setInitNonce] = useState(0)
  const [pairingStatus, setPairingStatus] = useState(null) // null | 'pending' | 'approved' | 'denied'
  // Director-facing explanation for why they landed back on the login screen.
  // null = ordinary (fresh device, deliberate logout, benign local-expiry).
  // Set only by an authoritative Host rejection (onAuthRejected) — see
  // reasonForAuthRejectedCode above.
  const [sessionEndedReason, setSessionEndedReason] = useState(null)
  const pairingListenersRegistered = useRef(false)

  const refreshCamp = useCallback(async () => {
    const c = await localClient.getCamp()
    setCamp(c || null)
    return c || null
  }, [])

  // Shared by the locally-failed verifySession path and the onAuthRejected
  // push-event path so the two cleanup blocks can't silently drift (Red Hat
  // finding on the original T87 change).
  const clearSessionState = useCallback((reason = null) => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(ROLE_KEY)
    setToken(null)
    setRole(null)
    setSessionEndedReason(reason)
  }, [])

  useEffect(() => {
    let active = true
    async function init() {
      try {
        const c = await refreshCamp()
        if (!active) return

        // Stage-aware landing predicate (ADR Decision 1) — a single cheap
        // existence query, not getReadiness's five-collection engine pass;
        // the landing decision only ever needs the one "is this camp truly
        // untouched" bit. Runs regardless of mode/token, same as refreshCamp.
        const hasSetupData = await localClient.campHasSetupData()
        if (!active) return
        setCampIsEmpty(!hasSetupData)

        // T87 (docs/adr/2026-08-16-client-reauth-on-restart.md, Part 1):
        // verify the stored token BEFORE chooseMode, not after, so a
        // locally-verified token can be handed to the client branch's
        // chooseMode call below and the Client actually re-authenticates on
        // startup instead of silently reconnecting unauthenticated.
        let verifiedToken = null
        const storedToken = localStorage.getItem(TOKEN_KEY)
        if (storedToken) {
          const result = await localClient.verifySession(storedToken)
          if (!active) return
          if (!result || !result.valid) {
            // A locally-expired token is benign — no host actively rejected
            // it, so no reason to alarm the director.
            clearSessionState(null)
          } else {
            verifiedToken = storedToken
            if (result.role) {
              localStorage.setItem(ROLE_KEY, result.role)
              setRole(result.role)
            }
          }
        }

        if (mode === 'host' && c) {
          await localClient.chooseMode({ mode: 'host', campName: c.name, port: DEFAULT_HOST_PORT })
        } else if (mode === 'client' && joinHost) {
          // Only a LOCALLY-VERIFIED token is handed to the transport layer —
          // never the raw localStorage value — so a token this device's own
          // signature/expiry check already knows is dead is never even
          // attempted on the wire. The Host re-verifies independently
          // regardless (defense-in-depth, not the sole gate).
          await localClient.chooseMode({
            mode: 'client', host: joinHost.host, port: joinHost.port,
            token: verifiedToken || undefined,
          })
          // Check if this device is already paired
          const pairingInfo = await localClient.getDevicePairingStatus()
          if (!pairingInfo.isPaired) {
            setPairingStatus('pending')
            if (active) setLoading(false)
            return
          }
        }

        if (active) setLoading(false)
      } catch (err) {
        if (!active) return
        setError(err && err.message ? err.message : String(err))
        setLoading(false)
      }
    }
    init()
    return () => { active = false }
    // Runs once per initNonce (mount, or an explicit retry) — mode/joinHost read
    // from their initial (persisted) values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initNonce])

  // Register pairing push-event listeners once, on mount
  useEffect(() => {
    if (pairingListenersRegistered.current) return
    pairingListenersRegistered.current = true

    if (localClient.onPairingApproved) {
      localClient.onPairingApproved(() => {
        setPairingStatus('approved')
        setInitNonce((n) => n + 1)
      })
    }
    if (localClient.onPairingDenied) {
      localClient.onPairingDenied(() => {
        setPairingStatus('denied')
      })
    }
    if (localClient.onTokenRenewed) {
      localClient.onTokenRenewed((newToken) => {
        if (newToken) {
          localStorage.setItem(TOKEN_KEY, newToken)
          setToken(newToken)
        }
      })
    }
    // T87 Part 3: the Host has authoritatively rejected this device's token
    // (revoked, tampered, mismatched device_id — see syncClient.js's
    // onAuthRejected). Run the SAME cleanup as a locally-failed verifySession
    // check above, so a rejected token can never leave the UI showing a
    // stale 'session' phase — this forces phase back to 'login', the honest
    // not-yet-authenticated state. Also derive a director-facing reason so
    // the login screen isn't a silent, unexplained bounce.
    if (localClient.onAuthRejected) {
      localClient.onAuthRejected((code) => {
        clearSessionState(reasonForAuthRejectedCode(code))
      })
    }
  }, [clearSessionState])

  const retry = useCallback(() => {
    setError(null)
    setLoading(true)
    setInitNonce((n) => n + 1)
  }, [])

  const chooseHost = useCallback(() => {
    localStorage.setItem(MODE_KEY, 'host')
    setMode('host')
    setInitNonce((n) => n + 1)
  }, [])

  const chooseJoin = useCallback(() => {
    localStorage.setItem(MODE_KEY, 'client')
    setMode('client')
  }, [])

  const selectJoinHost = useCallback(async (host) => {
    try {
      await localClient.chooseMode({ mode: 'client', host: host.host, port: host.port })
      localStorage.setItem(JOIN_HOST_KEY, JSON.stringify(host))
      setJoinHost(host)
      await refreshCamp()
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    }
  }, [refreshCamp])

  const bootstrapCamp = useCallback(async ({ campName, adminName, adminPin }) => {
    try {
      await localClient.chooseMode({ mode: 'host', campName, port: DEFAULT_HOST_PORT })
      await localClient.bootstrapCamp({ campName, adminName, adminPin })
      await refreshCamp()
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    }
  }, [refreshCamp])

  const login = useCallback(async (name, pin) => {
    const result = await localClient.login(name, pin)
    if (result && result.token) {
      localStorage.setItem(TOKEN_KEY, result.token)
      setToken(result.token)
      // A successful sign-in resolves whatever got them here — a stale
      // rejection notice must not persist through a fresh session.
      setSessionEndedReason(null)
    }
    if (result && result.role) {
      localStorage.setItem(ROLE_KEY, result.role)
      setRole(result.role)
    }
    return result
  }, [])

  const logout = useCallback(() => {
    clearSessionState(null)
  }, [clearSessionState])

  const backToModeSelect = useCallback(() => {
    localStorage.removeItem(MODE_KEY)
    localStorage.removeItem(JOIN_HOST_KEY)
    setMode(null)
    setJoinHost(null)
  }, [])

  let phase
  if (error) phase = 'error'
  else if (loading) phase = 'loading'
  else if (!mode) phase = 'mode-select'
  else if (mode === 'host' && !camp) phase = 'bootstrap'
  else if (mode === 'client' && !joinHost) phase = 'join'
  else if (mode === 'client' && joinHost && pairingStatus === 'pending') phase = 'pairing_pending'
  else if (mode === 'client' && joinHost && pairingStatus === 'denied') phase = 'pairing_denied'
  else if (!token) phase = 'login'
  else phase = 'session'

  return {
    phase,
    mode,
    camp,
    campIsEmpty,
    role,
    joinHost,
    pairingStatus,
    sessionEndedReason,
    error,
    retry,
    chooseHost,
    chooseJoin,
    selectJoinHost,
    bootstrapCamp,
    login,
    logout,
    backToModeSelect,
  }
}
