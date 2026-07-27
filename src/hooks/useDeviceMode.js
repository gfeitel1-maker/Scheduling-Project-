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
  const [error, setError] = useState(null)
  const [initNonce, setInitNonce] = useState(0)
  const [pairingStatus, setPairingStatus] = useState(null) // null | 'pending' | 'approved' | 'denied'
  const pairingListenersRegistered = useRef(false)

  const refreshCamp = useCallback(async () => {
    const c = await localClient.getCamp()
    setCamp(c || null)
    return c || null
  }, [])

  useEffect(() => {
    let active = true
    async function init() {
      try {
        const c = await refreshCamp()
        if (!active) return

        if (mode === 'host' && c) {
          await localClient.chooseMode({ mode: 'host', campName: c.name, port: DEFAULT_HOST_PORT })
        } else if (mode === 'client' && joinHost) {
          await localClient.chooseMode({ mode: 'client', host: joinHost.host, port: joinHost.port })
          // Check if this device is already paired
          const pairingInfo = await localClient.getDevicePairingStatus()
          if (!pairingInfo.isPaired) {
            setPairingStatus('pending')
            if (active) setLoading(false)
            return
          }
        }

        const storedToken = localStorage.getItem(TOKEN_KEY)
        if (storedToken) {
          const result = await localClient.verifySession(storedToken)
          if (!active) return
          if (!result || !result.valid) {
            localStorage.removeItem(TOKEN_KEY)
            localStorage.removeItem(ROLE_KEY)
            setToken(null)
            setRole(null)
          } else if (result.role) {
            localStorage.setItem(ROLE_KEY, result.role)
            setRole(result.role)
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
  }, [])

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
    }
    if (result && result.role) {
      localStorage.setItem(ROLE_KEY, result.role)
      setRole(result.role)
    }
    return result
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(ROLE_KEY)
    setToken(null)
    setRole(null)
  }, [])

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
    role,
    joinHost,
    pairingStatus,
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
